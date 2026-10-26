import { createHash } from 'crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import { config } from '../../../shared/config';
import { log } from '../../../shared/log';
import { AssetFacts, DEFAULT_CANVAS } from '../../../shared/mock-layout';
import { canonicalJson } from '../drafts/canonical';
import { DraftsService } from '../drafts/drafts.service';
import { PG_POOL, SQS } from '../tokens';
import { CreateAiLayoutDto } from './create-ai-layout.dto';

interface GenerationRow {
  id: string;
  draft_id: string;
  status: string;
  model_version: string;
  seed: number;
  result: unknown;
  error: string | null;
  cached_from_id: string | null;
  accepted_revision_no: number | null;
  created_at: Date;
  updated_at: Date;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export const generationView = (g: GenerationRow) => ({
  generation_id: g.id,
  draft_id: g.draft_id,
  status: g.status,
  model_version: g.model_version,
  seed: g.seed,
  cached: g.cached_from_id !== null,
  cached_from: g.cached_from_id,
  // The layout only exists once the generation is READY.
  result: g.status === 'READY' ? g.result : null,
  error: g.status === 'FAILED' ? g.error : null,
  accepted_revision: g.accepted_revision_no,
  created_at: g.created_at.toISOString(),
  updated_at: g.updated_at.toISOString(),
});

@Injectable()
export class AiService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SQS) private readonly sqs: SQSClient,
    private readonly drafts: DraftsService,
  ) {}

  async request(ownerId: string, draftId: string, dto: CreateAiLayoutDto, correlationId: string) {
    const draft = await this.drafts.findOwned(ownerId, draftId);
    if (draft.status !== 'ACTIVE') {
      throw new ConflictException({ code: draft.status === 'DISCARDED' || draft.status === 'PURGED' ? 'DRAFT_DISCARDED' : 'DRAFT_FROZEN', message: `draft is ${draft.status}` });
    }
    const assets = await this.assetFacts(ownerId, dto.asset_ids);
    const canvas = dto.canvas ? { width: dto.canvas.width, height: dto.canvas.height } : DEFAULT_CANVAS;
    const seed = dto.seed ?? 0;
    const modelVersion = dto.model_version ?? config.mockAiModelVersion;
    const inputHash = sha(canonicalJson({ assets, canvas }));
    const cacheKey = sha(`${inputHash}|${modelVersion}|${seed}`);
    const request = { assets, canvas, ...(dto.test_fail ? { test_fail: dto.test_fail } : {}) };

    const row = (
      await this.pool.query<GenerationRow>(
        `INSERT INTO ai_generation (draft_id, owner_id, input_hash, model_version, seed, cache_key, request)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [draft.id, ownerId, inputHash, modelVersion, seed, cacheKey, JSON.stringify(request)],
      )
    ).rows[0];
    const fields = { generation_id: row.id, draft_id: draft.id, correlation_id: correlationId };
    try {
      await this.sqs.send(new SendMessageCommand({ QueueUrl: config.queueAiRequestsUrl, MessageBody: JSON.stringify({ generation_id: row.id, correlation_id: correlationId }) }));
    } catch (e) {
      // Nobody will ever process this row; do not leave the client polling.
      log('error', 'ai enqueue failed', { ...fields, error: String(e) });
      const failed = (await this.pool.query<GenerationRow>(`UPDATE ai_generation SET status = 'FAILED', error = 'ENQUEUE_FAILED' WHERE id = $1 RETURNING *`, [row.id])).rows[0];
      return generationView(failed);
    }
    log('info', 'ai layout requested', fields);
    return generationView(row);
  }

  async get(ownerId: string, generationId: string) {
    const g = (await this.pool.query<GenerationRow>(`SELECT * FROM ai_generation WHERE id = $1 AND owner_id = $2`, [generationId, ownerId])).rows[0];
    // Another owner's generation looks the same as a missing one.
    if (!g) throw new NotFoundException({ code: 'GENERATION_NOT_FOUND', message: 'generation not found' });
    return generationView(g);
  }

  /** Facts for the worker, in request order. Same eligibility rules as revision references, but no reference is made. */
  private async assetFacts(ownerId: string, ids: string[]): Promise<AssetFacts[]> {
    const rows = (
      await this.pool.query<{ id: string; owner_id: string; kind: 'IMAGE' | 'VIDEO'; upload_status: string; retention_status: string; metadata: any }>(
        `SELECT id, owner_id, kind, upload_status, retention_status, metadata FROM media_asset WHERE id = ANY($1::uuid[])`,
        [ids],
      )
    ).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((raw) => {
      const id = raw.toLowerCase();
      const a = byId.get(id);
      const fail = (code: string, message: string) => new UnprocessableEntityException({ code, message, asset_id: id });
      if (!a || a.owner_id !== ownerId) throw fail('ASSET_NOT_FOUND', `asset ${id} not found`);
      if (a.retention_status === 'DELETING' || a.retention_status === 'DELETED') throw fail('ASSET_NOT_REFERENCEABLE', `asset ${id} is ${a.retention_status}`);
      if (a.upload_status !== 'VALIDATED') throw fail('ASSET_NOT_READY', `asset ${id} is ${a.upload_status}`);
      const facts: AssetFacts = { asset_id: id, kind: a.kind, width: a.metadata.width, height: a.metadata.height };
      if (a.kind === 'VIDEO') facts.duration_seconds = a.metadata.duration_seconds;
      return facts;
    });
  }
}

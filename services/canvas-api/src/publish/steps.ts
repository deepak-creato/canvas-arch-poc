import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { config } from '../../../shared/config';
import { planFinals } from '../../../shared/final-renditions';
import { log } from '../../../shared/log';
import { extractAssetIds } from '../../../shared/refs';
import { rollUp } from '../assets/assets.service';
import { contentHash } from '../drafts/canonical';
import { PG_POOL, S3 } from '../tokens';
import { StepError } from './errors';
import { transition } from './publication-state';

/** Message that Step Functions puts on the publish-tasks queue (see infra/stepfunctions/publish.asl.json). */
export interface StepMessage {
  step: string;
  publication_id: string;
  token: string;
  [k: string]: unknown;
}

/** Returned by a step that answers its task token later, from another place (the canvas upload). */
export const HOLD = Symbol('hold');

export interface PublicationContext {
  id: string;
  draft_id: string;
  owner_id: string;
  status: string;
  attempt: number;
  revision_id: string;
  revision_no: number;
  document: unknown;
  content_hash: string;
  test_fail_mode: string | null;
}

@Injectable()
export class PublishSteps {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(S3) private readonly s3: S3Client,
  ) {}

  /** Runs one workflow step. Every step is safe to run twice. */
  async run(msg: StepMessage): Promise<unknown | typeof HOLD> {
    switch (msg.step) {
      case 'VALIDATE_SNAPSHOT':
        return this.validateSnapshot(msg);
      case 'PLAN_FINALS':
        return this.planFinals(msg);
      case 'MARK_FINALS_READY':
        return this.markFinalsReady(msg);
      case 'FAIL_PUBLICATION':
        return this.failPublication(msg);
      default:
        throw new StepError('STEP_NOT_IMPLEMENTED', `workflow step ${msg.step} is not implemented`);
    }
  }

  async load(publicationId: string): Promise<PublicationContext> {
    const p = (
      await this.pool.query<PublicationContext>(
        `SELECT p.id, p.draft_id, p.owner_id, p.status, p.attempt, p.revision_id, p.test_fail_mode,
                r.revision_no, r.document, r.content_hash
           FROM publication p JOIN canvas_revision r ON r.id = p.revision_id
          WHERE p.id = $1`,
        [publicationId],
      )
    ).rows[0];
    if (!p) throw new StepError('PUBLICATION_NOT_FOUND', `publication ${publicationId} not found`);
    return p;
  }

  /** Active publication only: a LIVE or FAILED one must not be moved by a stale message. */
  private async loadActive(msg: StepMessage): Promise<PublicationContext> {
    const p = await this.load(msg.publication_id);
    if (p.status === 'LIVE' || p.status === 'FAILED') {
      throw new StepError('PUBLICATION_STATE', `publication is ${p.status}`);
    }
    return p;
  }

  /**
   * WAITING_FOR_ASSETS. The pinned revision must still be the snapshot that was requested, and every
   * asset it uses must be validated with draft renditions READY. Not ready yet returns ready=false
   * (the state machine waits and asks again); unusable or too slow fails the publication.
   */
  private async validateSnapshot(msg: StepMessage) {
    const p = await this.loadActive(msg);
    const ctx = { publication_id: p.id, draft_id: p.draft_id };
    await transition(this.pool, p.id, 'WAITING_FOR_ASSETS', msg.step);

    if (contentHash(p.document) !== p.content_hash) {
      throw new StepError('SNAPSHOT_MISMATCH', 'pinned revision content no longer matches its hash');
    }
    const assetIds = extractAssetIds(p.document);
    const iteration = Number(msg.iteration ?? 0);
    if (assetIds.length === 0) return { ready: true, iteration, asset_ids: [] };

    const assets = (
      await this.pool.query<{ id: string; owner_id: string; upload_status: string; retention_status: string; derive_job: string | null; renditions: string[] }>(
        `SELECT a.id, a.owner_id, a.upload_status, a.retention_status,
                (SELECT j.status FROM processing_job j WHERE j.asset_id = a.id AND j.job_type IN ('image-derive', 'video-derive') LIMIT 1) AS derive_job,
                COALESCE((SELECT array_agg(r.status) FROM media_rendition r WHERE r.asset_id = a.id AND r.tier = 'DRAFT'), '{}') AS renditions
           FROM media_asset a WHERE a.id = ANY($1::uuid[])`,
        [assetIds],
      )
    ).rows;
    const byId = new Map(assets.map((a) => [a.id, a]));
    let pending = 0;
    for (const id of assetIds) {
      const a = byId.get(id);
      if (!a || a.owner_id !== p.owner_id || a.retention_status === 'DELETING' || a.retention_status === 'DELETED') {
        throw new StepError('ASSET_UNUSABLE', `asset ${id} is missing or deleted`);
      }
      const status = rollUp(a.upload_status, a.derive_job ?? undefined, a.renditions);
      if (status === 'REJECTED' || status === 'EXPIRED' || status === 'FAILED') {
        throw new StepError('ASSET_UNUSABLE', `asset ${id} is ${status}`);
      }
      if (status !== 'READY') pending++;
    }
    if (pending > 0) {
      if (iteration + 1 >= config.publishMaxAssetPolls) {
        throw new StepError('ASSETS_NOT_READY', `${pending} asset(s) still not ready after ${iteration + 1} checks`);
      }
      log('info', 'assets not ready, waiting', { ...ctx, pending, iteration });
      return { ready: false, iteration: iteration + 1, asset_ids: assetIds };
    }
    return { ready: true, iteration, asset_ids: assetIds };
  }

  /** TRANSCODING. Returns only the video finals that still have to be produced. */
  private async planFinals(msg: StepMessage) {
    const p = await this.loadActive(msg);
    await transition(this.pool, p.id, 'TRANSCODING', msg.step);
    const plan = await planFinals(this.pool, this.s3, extractAssetIds(p.document), { resetFailed: true, publicationId: p.id });
    const failMode = config.workerTestHooks && p.test_fail_mode ? p.test_fail_mode : 'none';
    log('info', 'final plan', { publication_id: p.id, to_produce: plan.missing.length, reused: plan.reused.length });
    return {
      missing: plan.missing.map((m) => ({ asset_id: m.asset_id, rendition_id: m.rendition_id, fail_mode: failMode })),
      reused: plan.reused.length,
    };
  }

  /** Every video final must be READY and its object present before the canvas gate opens. */
  private async markFinalsReady(msg: StepMessage) {
    const p = await this.loadActive(msg);
    const plan = await planFinals(this.pool, this.s3, extractAssetIds(p.document), { publicationId: p.id });
    if (plan.missing.length > 0 || plan.failed.length > 0) {
      const bad = [...plan.missing, ...plan.failed].map((m) => m.asset_id).join(',');
      throw new StepError('FINAL_NOT_READY', `final rendition not ready for asset(s) ${bad}`);
    }
    for (const f of plan.reused) {
      await this.s3.send(new HeadObjectCommand({ Bucket: f.bucket, Key: f.key }));
    }
    return { finals: plan.reused.map((f) => ({ asset_id: f.asset_id, rendition_id: f.rendition_id, key: f.key })) };
  }

  /** Terminal failure: record it so the API, the client and the retry endpoint see it. */
  private async failPublication(msg: StepMessage) {
    const err = (msg.error ?? {}) as { Error?: string; Cause?: string };
    const reason = `${err.Error ?? 'UNKNOWN'}: ${String(err.Cause ?? '').slice(0, 400)}`;
    await transition(this.pool, msg.publication_id, 'FAILED', msg.step, { reason, detail: { error: err.Error ?? null } });
    log('error', 'publication failed', { publication_id: msg.publication_id, reason });
    return { failed: true };
  }
}

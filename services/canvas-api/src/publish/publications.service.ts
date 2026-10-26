import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { SFNClient } from '@aws-sdk/client-sfn';
import { Pool, PoolClient } from 'pg';
import { config } from '../../../shared/config';
import { log } from '../../../shared/log';
import { answerTask } from '../../../shared/sfn';
import { PG_POOL, PRESIGN_S3, S3, SFN } from '../tokens';
import { CANVAS_TYPES, CanvasUploadDto, CanvasUploadedDto } from './canvas-upload.dto';
import { CreatePublicationDto } from './create-publication.dto';
import { PublishOrchestrator } from './orchestrator';

export interface PublicationRow {
  id: string;
  draft_id: string;
  revision_id: string;
  owner_id: string;
  status: string;
  idempotency_key: string;
  execution_arn: string | null;
  render_bucket: string | null;
  render_key: string | null;
  manifest_key: string | null;
  failure_reason: string | null;
  live_at: Date | null;
  attempt: number;
  canvas_content_type: string | null;
  canvas_bytes: string | null;
  created_at: Date;
  updated_at: Date;
}

/** One object per publication and type, so a re-upload overwrites instead of piling up. */
export const canvasKey = (publicationId: string, contentType: string) => `publications/${publicationId}/canvas.${CANVAS_TYPES[contentType]}`;

const KEY_RE = /^[\x21-\x7e]{1,128}$/;

@Injectable()
export class PublicationsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PRESIGN_S3) private readonly s3: S3Client,
    @Inject(S3) private readonly s3Internal: S3Client,
    @Inject(SFN) private readonly sfn: SFNClient,
    private readonly orchestrator: PublishOrchestrator,
  ) {}

  /**
   * Reserves the draft's single publication and pins the exact revision, then starts the workflow.
   * Same owner + key + revision gives back the same publication. The draft row lock serializes
   * concurrent requests, so two clicks cannot create two publications.
   */
  async create(ownerId: string, draftId: string, idempotencyKey: string | undefined, dto: CreatePublicationDto) {
    if (!idempotencyKey || !KEY_RE.test(idempotencyKey)) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header required (1-128 printable characters)' });
    }
    const { pub, replay } = await this.inTx(async (c) => {
      const draft = (
        await c.query<{ id: string; status: string }>(`SELECT id, status FROM canvas_draft WHERE id = $1 AND owner_id = $2 FOR UPDATE`, [draftId, ownerId])
      ).rows[0];
      if (!draft) throw new NotFoundException({ code: 'DRAFT_NOT_FOUND', message: 'draft not found' });

      const rev = (
        await c.query<{ id: string; revision_no: number }>(`SELECT id, revision_no FROM canvas_revision WHERE draft_id = $1 AND revision_no = $2`, [draft.id, dto.revision])
      ).rows[0];

      const byKey = (await c.query<PublicationRow>(`SELECT * FROM publication WHERE owner_id = $1 AND idempotency_key = $2`, [ownerId, idempotencyKey])).rows[0];
      if (byKey) {
        if (byKey.draft_id !== draft.id || byKey.revision_id !== rev?.id) {
          throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency-Key was used for a different publish request' });
        }
        return { pub: byKey, replay: true };
      }

      const existing = (await c.query<PublicationRow>(`SELECT * FROM publication WHERE draft_id = $1`, [draft.id])).rows[0];
      if (existing) {
        throw new ConflictException({
          code: 'PUBLICATION_EXISTS',
          message: 'this draft already has a publication (one publication per draft)',
          publication_id: existing.id,
          status: existing.status,
        });
      }
      if (draft.status !== 'ACTIVE') {
        throw new ConflictException({
          code: draft.status === 'DISCARDED' || draft.status === 'PURGED' ? 'DRAFT_DISCARDED' : 'DRAFT_FROZEN',
          message: `draft is ${draft.status}`,
        });
      }
      if (!rev) throw new NotFoundException({ code: 'REVISION_NOT_FOUND', message: `revision ${dto.revision} not found` });

      const failMode = config.workerTestHooks ? (dto.test_fail_mode ?? null) : null;
      const pub = (
        await c.query<PublicationRow>(
          `INSERT INTO publication (draft_id, revision_id, owner_id, idempotency_key, test_fail_mode)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [draft.id, rev.id, ownerId, idempotencyKey, failMode],
        )
      ).rows[0];
      await c.query(`INSERT INTO publication_transition (publication_id, from_status, to_status, step) VALUES ($1, NULL, 'REQUESTED', 'PUBLISH_REQUEST')`, [pub.id]);
      // From here the draft takes no edits (assertEditable), and the revision cannot be pruned.
      await c.query(`UPDATE canvas_draft SET status = 'PUBLISHING', last_activity_at = now() WHERE id = $1`, [draft.id]);
      await c.query(`UPDATE canvas_revision SET pinned = true WHERE id = $1`, [rev.id]);
      log('info', 'publication requested', { publication_id: pub.id, draft_id: draft.id, owner_id: ownerId, revision_no: rev.revision_no });
      return { pub, replay: false };
    });

    // Outside the transaction. A failed start leaves the row REQUESTED; the same request starts it again.
    let current = pub;
    if (!pub.execution_arn && pub.status === 'REQUESTED') {
      try {
        const arn = await this.orchestrator.start(pub.id, pub.attempt);
        current = (await this.pool.query<PublicationRow>(`UPDATE publication SET execution_arn = $2 WHERE id = $1 RETURNING *`, [pub.id, arn])).rows[0];
      } catch (e) {
        log('error', 'could not start publish workflow', { publication_id: pub.id, error: String(e) });
        throw new ServiceUnavailableException({ code: 'WORKFLOW_START_FAILED', message: 'publish accepted but the workflow did not start; repeat the request', publication_id: pub.id });
      }
    }
    return { ...(await this.view(current)), idempotent_replay: replay };
  }

  async get(ownerId: string, publicationId: string) {
    return this.view(await this.findOwned(ownerId, publicationId), true);
  }

  /**
   * Fresh presigned PUT for the client-rendered canvas. Only while the workflow waits for it
   * (AWAITING_CANVAS); the canvas is rendered by the client, never composed here.
   */
  async canvasUploadUrl(ownerId: string, publicationId: string, dto: CanvasUploadDto) {
    const p = await this.findOwned(ownerId, publicationId);
    if (p.status !== 'AWAITING_CANVAS') {
      throw new ConflictException({ code: 'PUBLICATION_STATE', message: `publication is ${p.status}; a canvas upload is accepted only in AWAITING_CANVAS`, status: p.status });
    }
    const limit = dto.content_type === 'video/mp4' ? config.maxVideoBytes : config.maxImageBytes;
    if (dto.size_bytes > limit) {
      throw new BadRequestException({ code: 'CANVAS_TOO_LARGE', message: `canvas exceeds ${limit} bytes` });
    }
    const key = canvasKey(p.id, dto.content_type);
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: config.bucketPublished, Key: key, ContentType: dto.content_type, ContentLength: dto.size_bytes }),
      { expiresIn: config.uploadTtlSeconds },
    );
    log('info', 'canvas upload url issued', { publication_id: p.id, draft_id: p.draft_id });
    return {
      publication_id: p.id,
      upload_url: url,
      upload_headers: { 'Content-Type': dto.content_type, 'Content-Length': String(dto.size_bytes) },
      upload_expires_at: new Date(Date.now() + config.uploadTtlSeconds * 1000).toISOString(),
    };
  }

  /**
   * The client says its rendered canvas is uploaded. The object is checked (exists, not empty, content type
   * and file signature), recorded, and the AwaitCanvas task token is taken and answered, which resumes the
   * workflow. Safe to repeat: once the token is taken, further calls return the current state.
   */
  async canvasUploaded(ownerId: string, publicationId: string, dto: CanvasUploadedDto) {
    const p = await this.findOwned(ownerId, publicationId);
    if (p.status === 'FINALIZING' || p.status === 'LIVE') return this.view(p);
    if (p.status !== 'AWAITING_CANVAS') {
      throw new ConflictException({ code: 'PUBLICATION_STATE', message: `publication is ${p.status}; canvas-uploaded is accepted only in AWAITING_CANVAS`, status: p.status });
    }
    const key = canvasKey(p.id, dto.content_type);
    const ctx = { publication_id: p.id, draft_id: p.draft_id };
    const unprocessable = (code: string, message: string) => new UnprocessableEntityException({ code, message });

    let head;
    try {
      head = await this.s3Internal.send(new HeadObjectCommand({ Bucket: config.bucketPublished, Key: key }));
    } catch (e: any) {
      if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) throw unprocessable('CANVAS_NOT_FOUND', `no canvas object at ${key}; upload it first`);
      throw e;
    }
    if (!head.ContentLength) throw unprocessable('CANVAS_EMPTY', 'canvas object is empty');
    if (head.ContentType !== dto.content_type) {
      throw unprocessable('CANVAS_CONTENT_TYPE_MISMATCH', `canvas object has content type ${head.ContentType}, expected ${dto.content_type}`);
    }
    const first = await this.s3Internal.send(new GetObjectCommand({ Bucket: config.bucketPublished, Key: key, Range: 'bytes=0-11' }));
    if (!hasSignature(Buffer.from(await first.Body!.transformToByteArray()), dto.content_type)) {
      throw unprocessable('CANVAS_INVALID', `canvas object is not a valid ${dto.content_type} file`);
    }

    // Take the token and record the object in one statement; only one caller gets the token.
    const taken = (
      await this.pool.query<{ task_token: string | null }>(
        `WITH old AS (SELECT id, task_token FROM publication WHERE id = $1 AND status = 'AWAITING_CANVAS' AND task_token IS NOT NULL FOR UPDATE),
              upd AS (UPDATE publication p
                         SET task_token = NULL, render_bucket = $2, render_key = $3, canvas_content_type = $4, canvas_bytes = $5
                        FROM old WHERE p.id = old.id RETURNING old.task_token)
         SELECT task_token FROM upd`,
        [p.id, config.bucketPublished, key, dto.content_type, head.ContentLength],
      )
    ).rows[0]?.task_token;
    if (!taken) return this.view(await this.findOwned(ownerId, publicationId));

    let answered: boolean;
    try {
      answered = await answerTask(this.sfn, taken, { ok: true, output: { render_key: key, bytes: head.ContentLength, etag: head.ETag ?? null } }, ctx);
    } catch (e) {
      // Step Functions unreachable: give the token back so the client can repeat the call.
      await this.pool.query(`UPDATE publication SET task_token = $2 WHERE id = $1 AND task_token IS NULL`, [p.id, taken]);
      log('error', 'could not resume publish workflow', { ...ctx, error: String(e) });
      throw new ServiceUnavailableException({ code: 'WORKFLOW_UNAVAILABLE', message: 'could not resume the workflow; repeat the request' });
    }
    if (!answered) {
      // The wait timed out meanwhile; the workflow is marking the publication FAILED.
      throw new ConflictException({ code: 'CANVAS_TOO_LATE', message: 'the canvas wait already timed out; retry the publication' });
    }
    log('info', 'canvas upload confirmed', { ...ctx, bytes: head.ContentLength });
    return this.view(await this.findOwned(ownerId, publicationId));
  }

  async findOwned(ownerId: string, publicationId: string, db: Pick<PoolClient, 'query'> = this.pool): Promise<PublicationRow> {
    const p = (await db.query<PublicationRow>(`SELECT * FROM publication WHERE id = $1 AND owner_id = $2`, [publicationId, ownerId])).rows[0];
    // Another owner's publication looks the same as a missing one.
    if (!p) throw new NotFoundException({ code: 'PUBLICATION_NOT_FOUND', message: 'publication not found' });
    return p;
  }

  async view(p: PublicationRow, detail = false) {
    const rev = (await this.pool.query<{ revision_no: number }>(`SELECT revision_no FROM canvas_revision WHERE id = $1`, [p.revision_id])).rows[0];
    const base = {
      publication_id: p.id,
      draft_id: p.draft_id,
      revision: rev.revision_no,
      status: p.status,
      attempt: p.attempt,
      failure_reason: p.failure_reason,
      status_url: `/v1/publications/${p.id}`,
      live_at: p.live_at?.toISOString() ?? null,
      created_at: p.created_at.toISOString(),
      updated_at: p.updated_at.toISOString(),
    };
    if (!detail) return base;

    const transitions = (
      await this.pool.query<{ from_status: string | null; to_status: string; step: string | null; created_at: Date }>(
        `SELECT from_status, to_status, step, created_at FROM publication_transition WHERE publication_id = $1 ORDER BY id`,
        [p.id],
      )
    ).rows;
    const finals = (
      await this.pool.query<{ asset_id: string; bucket: string; s3_key: string }>(
        `SELECT pa.asset_id, r.bucket, r.s3_key FROM publication_asset pa JOIN media_rendition r ON r.id = pa.rendition_id
          WHERE pa.publication_id = $1 ORDER BY pa.asset_id`,
        [p.id],
      )
    ).rows;
    const live = p.status === 'LIVE';
    const url = (bucket: string, key: string) => getSignedUrl(this.s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: config.downloadTtlSeconds });
    return {
      ...base,
      // Output references exist once the publication is LIVE.
      manifest_url: live && p.manifest_key ? await url(config.bucketPublished, p.manifest_key) : null,
      render: live && p.render_key ? { url: await url(p.render_bucket!, p.render_key), content_type: p.canvas_content_type, bytes: p.canvas_bytes === null ? null : Number(p.canvas_bytes) } : null,
      finals: live ? await Promise.all(finals.map(async (f) => ({ asset_id: f.asset_id, url: await url(f.bucket, f.s3_key) }))) : [],
      transitions: transitions.map((t) => ({ from: t.from_status, to: t.to_status, step: t.step, at: t.created_at.toISOString() })),
    };
  }

  private async inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

/** PNG signature, or the MP4 `ftyp` box at byte 4. */
function hasSignature(head: Buffer, contentType: string): boolean {
  if (contentType === 'image/png') return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp';
}

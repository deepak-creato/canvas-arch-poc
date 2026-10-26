import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { config } from '../../shared/config';
import { claimJob, failJob, PermanentError, succeedJob, withHeartbeat } from '../../shared/job-repo';
import { ensureJob } from '../../shared/jobs';
import { renditionKey } from '../../shared/keys';
import { log } from '../../shared/log';
import { injectFailure } from './fail-injection';

// done: nothing more to do. busy: another worker holds the job, retry later.
// failed: the job is FAILED_PERMANENT, so the message should end in the DLQ.
export type DeriveOutcome = 'done' | 'busy' | 'failed';

export interface RenditionSpec {
  kind: string;
  version: number;
  paramsHash: string;
  ext: string;
  contentType: string;
  /** Builds the output. Only called when the object does not exist yet. */
  produce(): Promise<{ body: Buffer; metadata: Record<string, unknown> }>;
}

const WORKER_ID = `light-worker-${process.pid}`;
const isNotFound = (e: any) => e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;

async function exists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

/**
 * Shared draft-tier derive loop: one idempotent job, one rendition row per spec.
 * Rows are created up front, outputs that already exist are reused (HEAD before work),
 * and a failed attempt leaves the rows FAILED so the next attempt redoes only those.
 */
export async function runDerive(
  pool: Pool,
  s3: S3Client,
  assetId: string,
  job: { type: string; key: string; leaseSeconds: number },
  specs: RenditionSpec[],
  correlationId: string,
): Promise<DeriveOutcome> {
  await ensureJob(pool, { type: job.type, key: job.key, assetId });
  const claim = await claimJob(pool, job.key, WORKER_ID, job.leaseSeconds);
  if (!claim.claimed) return claim.reason === 'busy' ? 'busy' : claim.reason === 'failed' ? 'failed' : 'done';
  const ctx = { asset_id: assetId, job_id: claim.job.id, correlation_id: correlationId };

  try {
    await withHeartbeat(pool, claim.job.id, WORKER_ID, job.leaseSeconds, async () => {
      for (const s of specs) {
        await pool.query(
          `INSERT INTO media_rendition (asset_id, kind, tier, recipe_version, params_hash, bucket, s3_key, status)
           VALUES ($1, $2, 'DRAFT', $3, $4, $5, $6, 'QUEUED')
           ON CONFLICT (asset_id, kind, recipe_version, params_hash) DO NOTHING`,
          [assetId, s.kind, s.version, s.paramsHash, config.bucketDerived, renditionKey(assetId, s.kind, s.version, s.paramsHash, s.ext)],
        );
      }

      // After the rows exist, so a permanent failure can mark them FAILED_PERMANENT.
      injectFailure(claim.job);

      for (const s of specs) {
        const row = (
          await pool.query<{ id: string; status: string; s3_key: string }>(
            `SELECT id, status, s3_key FROM media_rendition
              WHERE asset_id = $1 AND kind = $2 AND recipe_version = $3 AND params_hash = $4`,
            [assetId, s.kind, s.version, s.paramsHash],
          )
        ).rows[0];
        if (row.status === 'READY') continue;

        await pool.query(`UPDATE media_rendition SET status = 'PROCESSING', error = NULL WHERE id = $1`, [row.id]);
        try {
          // A previous attempt may have written the object but died before updating the row.
          if (await exists(s3, config.bucketDerived, row.s3_key)) {
            await markReady(pool, row.id, { reused: true });
            log('info', 'rendition output already exists', { ...ctx, kind: s.kind });
            continue;
          }
          const out = await s.produce();
          await s3.send(new PutObjectCommand({ Bucket: config.bucketDerived, Key: row.s3_key, Body: out.body, ContentType: s.contentType }));
          await markReady(pool, row.id, { ...out.metadata, bytes: out.body.length, content_type: s.contentType });
          log('info', 'rendition ready', { ...ctx, kind: s.kind });
        } catch (e) {
          await pool.query(`UPDATE media_rendition SET status = 'FAILED', error = $2 WHERE id = $1`, [row.id, String(e).slice(0, 1000)]);
          throw e;
        }
      }
    });
    await succeedJob(pool, claim.job.id);
    return 'done';
  } catch (e) {
    const permanent = await failJob(pool, claim.job, String(e), e instanceof PermanentError);
    if (permanent) {
      await pool.query(
        `UPDATE media_rendition SET status = 'FAILED_PERMANENT'
          WHERE asset_id = $1 AND tier = 'DRAFT' AND status <> 'READY' AND kind = ANY($2)`,
        [assetId, specs.map((s) => s.kind)],
      );
      log('error', 'job failed permanently', { ...ctx, error: String(e) });
    }
    throw e;
  }
}

const markReady = (pool: Pool, id: string, metadata: Record<string, unknown>) =>
  pool.query(`UPDATE media_rendition SET status = 'READY', error = NULL, metadata = metadata || $2::jsonb WHERE id = $1`, [
    id,
    JSON.stringify(metadata),
  ]);

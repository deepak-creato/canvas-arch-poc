import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { config } from './config';
import { finalVideoKey, FINAL_VIDEO, transcodeJobKey } from './keys';
import { log } from './log';

export interface FinalToProduce {
  asset_id: string;
  rendition_id: string;
  bucket: string;
  key: string;
}

export interface FinalPlan {
  /** Final outputs that still have to be produced by the mock transcoder. */
  missing: FinalToProduce[];
  /** Final outputs that are READY and whose object exists: reused, no job. */
  reused: FinalToProduce[];
  /** FAILED / FAILED_PERMANENT rows left alone because `resetFailed` was not set. */
  failed: FinalToProduce[];
}

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
 * Decides which final video outputs a publication needs.
 *
 * Only videos have a final tier; images are published from their original. One FINAL rendition row
 * per video asset, keyed by asset and recipe (`finalVideoKey`), so every publication of the same
 * asset shares one output. Calling this again is safe:
 *   READY and object present   -> reused (no job)
 *   READY but object missing   -> back to QUEUED, produced again
 *   QUEUED / PROCESSING / ...  -> missing (the transcoder job is idempotent, a duplicate request is harmless)
 *   FAILED / FAILED_PERMANENT  -> reported as failed; with `resetFailed` (publication retry) back to
 *                                 QUEUED together with its job, so only that work is redone
 */
export async function planFinals(
  pool: Pool,
  s3: S3Client,
  assetIds: string[],
  opts: { resetFailed?: boolean; publicationId?: string } = {},
): Promise<FinalPlan> {
  const plan: FinalPlan = { missing: [], reused: [], failed: [] };
  if (assetIds.length === 0) return plan;

  const videos = (
    await pool.query<{ id: string }>(`SELECT id FROM media_asset WHERE id = ANY($1::uuid[]) AND kind = 'VIDEO' ORDER BY id`, [assetIds])
  ).rows;

  for (const { id: assetId } of videos) {
    await pool.query(
      `INSERT INTO media_rendition (asset_id, kind, tier, recipe_version, params_hash, bucket, s3_key, status)
       VALUES ($1, $2, 'FINAL', $3, $4, $5, $6, 'QUEUED')
       ON CONFLICT (asset_id, kind, recipe_version, params_hash) DO NOTHING`,
      [assetId, FINAL_VIDEO.kind, FINAL_VIDEO.version, FINAL_VIDEO.paramsHash, config.bucketDerived, finalVideoKey(assetId)],
    );
    const row = (
      await pool.query<{ id: string; status: string; bucket: string; s3_key: string }>(
        `SELECT id, status, bucket, s3_key FROM media_rendition
          WHERE asset_id = $1 AND kind = $2 AND recipe_version = $3 AND params_hash = $4`,
        [assetId, FINAL_VIDEO.kind, FINAL_VIDEO.version, FINAL_VIDEO.paramsHash],
      )
    ).rows[0];
    const item: FinalToProduce = { asset_id: assetId, rendition_id: row.id, bucket: row.bucket, key: row.s3_key };
    const ctx = { asset_id: assetId, publication_id: opts.publicationId };

    if (row.status === 'READY') {
      if (await exists(s3, row.bucket, row.s3_key)) {
        plan.reused.push(item);
        log('info', 'final rendition reused', ctx);
        continue;
      }
      log('warn', 'final rendition READY but object missing, producing again', ctx);
      await requeue(pool, assetId, row.id);
      plan.missing.push(item);
    } else if (row.status === 'FAILED' || row.status === 'FAILED_PERMANENT') {
      if (!opts.resetFailed) {
        plan.failed.push(item);
        continue;
      }
      await requeue(pool, assetId, row.id);
      plan.missing.push(item);
    } else {
      plan.missing.push(item);
    }
  }
  return plan;
}

/** Back to QUEUED: the rendition row and its transcode job, so the job can be claimed again. */
async function requeue(pool: Pool, assetId: string, renditionId: string) {
  await pool.query(`UPDATE media_rendition SET status = 'QUEUED', error = NULL WHERE id = $1`, [renditionId]);
  await pool.query(
    `UPDATE processing_job
        SET status = 'QUEUED', attempts = 0, last_error = NULL, lease_owner = NULL, lease_expires_at = NULL,
            available_at = now(), completed_at = NULL
      WHERE idempotency_key = $1`,
    [transcodeJobKey(assetId)],
  );
}

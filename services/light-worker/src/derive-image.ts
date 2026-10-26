import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import sharp from 'sharp';
import { config } from '../../shared/config';
import { claimJob, failJob, succeedJob } from '../../shared/job-repo';
import { ensureJob } from '../../shared/jobs';
import { renditionKey } from '../../shared/keys';
import { log } from '../../shared/log';
import { IMAGE_RECIPES, ImageRecipe, imageDeriveKey, paramsHash } from './recipes';

const LEASE_SECONDS = 120;
const WORKER_ID = `light-worker-${process.pid}`;

// done: nothing more to do. busy: another worker holds the job, retry later.
export type DeriveOutcome = 'done' | 'busy';

interface Rendition {
  id: string;
  kind: string;
  s3_key: string;
  status: string;
  recipe_version: number;
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

/** Creates the draft-tier thumbnail and preview for a VALIDATED image. Safe to call repeatedly. */
export async function deriveImage(pool: Pool, s3: S3Client, assetId: string, correlationId: string): Promise<DeriveOutcome> {
  const a = (
    await pool.query<{ id: string; kind: string; upload_status: string; original_bucket: string; original_key: string }>(
      `SELECT id, kind, upload_status, original_bucket, original_key FROM media_asset WHERE id = $1`,
      [assetId],
    )
  ).rows[0];
  if (!a || a.kind !== 'IMAGE' || a.upload_status !== 'VALIDATED') return 'done';

  await ensureJob(pool, { type: 'image-derive', key: imageDeriveKey(a.id), assetId: a.id });
  const claim = await claimJob(pool, imageDeriveKey(a.id), WORKER_ID, LEASE_SECONDS);
  if (!claim.claimed) return claim.reason === 'busy' ? 'busy' : 'done';
  const ctx = { asset_id: a.id, job_id: claim.job.id, correlation_id: correlationId };

  try {
    // Rows exist before any work, so status polling can show QUEUED/PROCESSING.
    for (const r of IMAGE_RECIPES) {
      await pool.query(
        `INSERT INTO media_rendition (asset_id, kind, tier, recipe_version, params_hash, bucket, s3_key, status)
         VALUES ($1, $2, 'DRAFT', $3, $4, $5, $6, 'QUEUED')
         ON CONFLICT (asset_id, kind, recipe_version, params_hash) DO NOTHING`,
        [a.id, r.kind, r.version, paramsHash(r), config.bucketDerived, renditionKey(a.id, r.kind, r.version, paramsHash(r), 'webp')],
      );
    }

    let source: Buffer | undefined; // downloaded lazily, only if some output is missing
    for (const recipe of IMAGE_RECIPES) {
      const row = (
        await pool.query<Rendition>(
          `SELECT id, kind, s3_key, status, recipe_version FROM media_rendition
            WHERE asset_id = $1 AND kind = $2 AND recipe_version = $3 AND params_hash = $4`,
          [a.id, recipe.kind, recipe.version, paramsHash(recipe)],
        )
      ).rows[0];
      if (row.status === 'READY') continue;

      await pool.query(`UPDATE media_rendition SET status = 'PROCESSING', error = NULL WHERE id = $1`, [row.id]);
      try {
        // HEAD before work: a previous attempt may have written the object but died before updating the row.
        if (await exists(s3, config.bucketDerived, row.s3_key)) {
          await markReady(pool, row.id, { reused: true });
          log('info', 'rendition output already exists', { ...ctx, kind: recipe.kind });
          continue;
        }
        source ??= Buffer.from(
          await (await s3.send(new GetObjectCommand({ Bucket: a.original_bucket, Key: a.original_key }))).Body!.transformToByteArray(),
        );
        const out = await render(source, recipe);
        await s3.send(
          new PutObjectCommand({ Bucket: config.bucketDerived, Key: row.s3_key, Body: out.data, ContentType: 'image/webp' }),
        );
        await markReady(pool, row.id, { width: out.width, height: out.height, bytes: out.data.length, content_type: 'image/webp' });
        log('info', 'rendition ready', { ...ctx, kind: recipe.kind });
      } catch (e) {
        await pool.query(`UPDATE media_rendition SET status = 'FAILED', error = $2 WHERE id = $1`, [row.id, String(e).slice(0, 1000)]);
        throw e;
      }
    }
    await succeedJob(pool, claim.job.id);
    return 'done';
  } catch (e) {
    await failJob(pool, claim.job, String(e));
    throw e;
  }
}

async function render(source: Buffer, r: ImageRecipe) {
  const { data, info } = await sharp(source, { failOn: 'error' })
    .rotate() // apply EXIF orientation, then drop it
    .resize({ width: r.width, height: r.height, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: r.quality })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const markReady = (pool: Pool, id: string, metadata: Record<string, unknown>) =>
  pool.query(`UPDATE media_rendition SET status = 'READY', error = NULL, metadata = $2::jsonb WHERE id = $1`, [
    id,
    JSON.stringify(metadata),
  ]);

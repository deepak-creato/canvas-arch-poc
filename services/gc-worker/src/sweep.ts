import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Pool, PoolClient } from 'pg';
import { config } from '../../shared/config';
import { log } from '../../shared/log';
import { recalcRetention } from '../../shared/refs';
import { GcOptions } from './options';

export interface SweepResult {
  /** ORPHANED -> DELETING this run */
  claimed: string[];
  /** DELETING -> DELETED this run (includes retries from earlier runs) */
  deleted: string[];
  /** left DELETING after an object delete error */
  failed: string[];
  /** had a reference after all, or a lock/job held it: not deleted */
  skipped: string[];
}

/**
 * Mark-and-sweep, sweep half (plan 7.4 steps 3 to 6).
 *
 * 1. Claim: per asset, in its own transaction, lock the row and re-check under the lock that it is
 *    still ORPHANED past the grace period with zero references. Only then ORPHANED -> DELETING.
 *    A save holds the same row lock while it adds references, so one of the two always loses cleanly.
 * 2. Delete objects outside any lock. DELETING assets accept no new references, so this needs no re-check.
 * 3. Write the DELETED tombstone. A partial failure leaves DELETING and the next run retries.
 */
export async function sweep(pool: Pool, s3: S3Client, o: GcOptions): Promise<SweepResult> {
  const out: SweepResult = { claimed: [], deleted: [], failed: [], skipped: [] };

  const candidates = (
    await pool.query<{ id: string }>(
      `SELECT id FROM media_asset
        WHERE retention_status = 'ORPHANED' AND orphaned_at <= now() - make_interval(secs => $1)
          AND ($2::text IS NULL OR owner_id = $2)
        ORDER BY orphaned_at LIMIT $3`,
      [o.orphanGraceSeconds, o.ownerId ?? null, o.batchSize],
    )
  ).rows;
  for (const { id } of candidates) {
    const claimed = await claim(pool, id, o);
    (claimed ? out.claimed : out.skipped).push(id);
  }

  // Everything DELETING, including leftovers of earlier partial failures.
  const deleting = (
    await pool.query<{ id: string }>(
      `SELECT id FROM media_asset WHERE retention_status = 'DELETING' AND ($1::text IS NULL OR owner_id = $1)
        ORDER BY updated_at LIMIT $2`,
      [o.ownerId ?? null, o.batchSize],
    )
  ).rows;
  for (const { id } of deleting) {
    (await finish(pool, s3, id) ? out.deleted : out.failed).push(id);
  }
  return out;
}

/** ORPHANED -> DELETING under the row lock, after the second zero-reference check. */
async function claim(pool: Pool, id: string, o: GcOptions): Promise<boolean> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const row = (
      await c.query(
        `SELECT id FROM media_asset
          WHERE id = $1 AND retention_status = 'ORPHANED' AND orphaned_at <= now() - make_interval(secs => $2)
          FOR UPDATE SKIP LOCKED`,
        [id, o.orphanGraceSeconds],
      )
    ).rows[0];
    if (!row) {
      await c.query('ROLLBACK');
      return false; // locked by a save, or no longer eligible
    }
    if (await isReferenced(c, id)) {
      // The counters drifted from media_reference. References win: put the asset back in service.
      await recalcRetention(c, [id]);
      await c.query('COMMIT');
      log('warn', 'orphan has references, not deleting', { asset_id: id });
      return false;
    }
    await c.query(`UPDATE media_asset SET retention_status = 'DELETING', delete_attempts = 0, delete_error = NULL WHERE id = $1`, [id]);
    await c.query('COMMIT');
    log('info', 'asset deleting', { asset_id: id });
    return true;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Any reference of any kind: revision, publication, or a published final rendition mapping. */
async function isReferenced(c: PoolClient, assetId: string): Promise<boolean> {
  return (
    (
      await c.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM media_reference WHERE asset_id = $1)
                     OR EXISTS (SELECT 1 FROM publication_asset WHERE asset_id = $1)`,
        [assetId],
      )
    ).rowCount === 1
  );
}

async function listKeys(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const k of r.Contents ?? []) if (k.Key) keys.push(k.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Deletes every object of the asset: original, recorded renditions, and anything under its prefixes. */
export async function deleteAssetObjects(pool: Pool, s3: S3Client, assetId: string): Promise<number> {
  const a = (await pool.query<{ owner_id: string; original_bucket: string; original_key: string }>(`SELECT owner_id, original_bucket, original_key FROM media_asset WHERE id = $1`, [assetId])).rows[0];
  if (!a) return 0;
  const byBucket = new Map<string, Set<string>>();
  const add = (bucket: string, key: string) => byBucket.set(bucket, (byBucket.get(bucket) ?? new Set()).add(key));
  add(a.original_bucket, a.original_key);
  for (const r of (await pool.query<{ bucket: string; s3_key: string }>(`SELECT bucket, s3_key FROM media_rendition WHERE asset_id = $1`, [assetId])).rows) add(r.bucket, r.s3_key);
  // Objects a crashed worker wrote before it could record the row.
  for (const k of await listKeys(s3, config.bucketDerived, `derived/${assetId}/`)) add(config.bucketDerived, k);
  for (const k of await listKeys(s3, config.bucketDerived, `final/${assetId}/`)) add(config.bucketDerived, k);

  let n = 0;
  for (const [bucket, keys] of byBucket) {
    const all = [...keys];
    for (let i = 0; i < all.length; i += 1000) {
      const chunk = all.slice(i, i + 1000);
      const r = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
      if (r.Errors?.length) throw new Error(`delete failed for ${r.Errors.length} object(s): ${r.Errors[0].Key}: ${r.Errors[0].Code}`);
      n += chunk.length;
    }
  }
  return n;
}

/** DELETING -> DELETED after the objects are gone. Returns false and keeps DELETING on any error. */
async function finish(pool: Pool, s3: S3Client, id: string): Promise<boolean> {
  try {
    const n = await deleteAssetObjects(pool, s3, id);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const row = (await c.query(`SELECT 1 FROM media_asset WHERE id = $1 AND retention_status = 'DELETING' FOR UPDATE`, [id])).rows[0];
      if (row) {
        await c.query(`DELETE FROM media_rendition WHERE asset_id = $1`, [id]);
        await c.query(`UPDATE media_asset SET retention_status = 'DELETED', deleted_at = now(), delete_error = NULL WHERE id = $1`, [id]);
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    log('info', 'asset deleted', { asset_id: id, objects: n });
    return true;
  } catch (e) {
    await pool.query(`UPDATE media_asset SET delete_attempts = delete_attempts + 1, delete_error = $2 WHERE id = $1`, [id, String(e).slice(0, 500)]);
    log('error', 'asset delete failed, will retry', { asset_id: id, error: String(e) });
    return false;
  }
}

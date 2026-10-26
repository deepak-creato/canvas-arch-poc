import { Pool } from 'pg';
import { log } from '../../shared/log';
import { GcOptions } from './options';

/**
 * PENDING_UPLOAD -> EXPIRED once the reservation (plus grace) has run out. SKIP LOCKED leaves
 * rows that a concurrent "complete" call holds; the status guard keeps a confirmed upload safe.
 */
export async function expireUploads(pool: Pool, o: GcOptions): Promise<string[]> {
  const r = await pool.query<{ id: string }>(
    `UPDATE media_asset SET upload_status = 'EXPIRED'
      WHERE id IN (
        SELECT id FROM media_asset
         WHERE upload_status = 'PENDING_UPLOAD'
           AND upload_expires_at <= now() - make_interval(secs => $1)
           AND ($2::text IS NULL OR owner_id = $2)
         ORDER BY upload_expires_at LIMIT $3
         FOR UPDATE SKIP LOCKED)
        AND upload_status = 'PENDING_UPLOAD'
      RETURNING id`,
    [o.uploadExpiryGraceSeconds, o.ownerId ?? null, o.batchSize],
  );
  for (const a of r.rows) log('info', 'upload expired', { asset_id: a.id });
  return r.rows.map((a) => a.id);
}

/**
 * UNATTACHED -> ORPHANED for usable-or-dead uploads nothing ever referenced, after the unattached
 * grace. orphaned_at starts the orphan grace, so this step never leads to a delete on its own.
 * The reference check runs in the same statement as the row lock.
 */
export async function markUnattached(pool: Pool, o: GcOptions): Promise<string[]> {
  const r = await pool.query<{ id: string }>(
    `UPDATE media_asset a SET retention_status = 'ORPHANED', orphaned_at = now()
      WHERE a.id IN (
        SELECT id FROM media_asset
         WHERE retention_status = 'UNATTACHED'
           AND upload_status IN ('VALIDATED', 'REJECTED', 'EXPIRED')
           AND updated_at <= now() - make_interval(secs => $1)
           AND ($2::text IS NULL OR owner_id = $2)
         ORDER BY updated_at LIMIT $3
         FOR UPDATE SKIP LOCKED)
        AND a.retention_status = 'UNATTACHED'
        AND NOT EXISTS (SELECT 1 FROM media_reference r WHERE r.asset_id = a.id)
      RETURNING a.id`,
    [o.unattachedGraceSeconds, o.ownerId ?? null, o.batchSize],
  );
  for (const a of r.rows) log('info', 'unattached asset orphaned', { asset_id: a.id });
  return r.rows.map((a) => a.id);
}

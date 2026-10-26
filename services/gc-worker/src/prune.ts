import { Pool, PoolClient } from 'pg';
import { log } from '../../shared/log';
import { recalcRetention } from '../../shared/refs';
import { GcOptions } from './options';

async function inTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
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

/**
 * Deletes the given revisions and releases their references. The caller holds the draft row lock.
 * Asset rows are locked in id order (the order a save uses) before the references go, so
 * recalcRetention sees a stable count. media_reference rows go with the revision (ON DELETE CASCADE).
 */
async function releaseRevisions(client: PoolClient, revisionIds: string[]): Promise<string[]> {
  if (revisionIds.length === 0) return [];
  const assetIds = (
    await client.query<{ id: string }>(
      `SELECT id FROM media_asset
        WHERE id IN (SELECT asset_id FROM media_reference WHERE revision_id = ANY($1::uuid[]))
        ORDER BY id FOR UPDATE`,
      [revisionIds],
    )
  ).rows.map((r) => r.id);
  await client.query(`DELETE FROM canvas_revision WHERE id = ANY($1::uuid[])`, [revisionIds]);
  await recalcRetention(client, assetIds);
  return assetIds;
}

/**
 * DISCARDED drafts past `purge_after` become PURGED: all revisions are deleted, their references
 * released, and the draft row stays as a tombstone. Assets other drafts or publications still
 * reference keep a reference row, so recalcRetention leaves them REFERENCED/PUBLISHED.
 */
export async function purgeDiscardedDrafts(pool: Pool, o: GcOptions): Promise<string[]> {
  const candidates = (
    await pool.query<{ id: string }>(
      `SELECT id FROM canvas_draft
        WHERE status = 'DISCARDED' AND purge_after <= now() AND ($1::text IS NULL OR owner_id = $1)
        ORDER BY purge_after LIMIT $2`,
      [o.ownerId ?? null, o.batchSize],
    )
  ).rows;
  const purged: string[] = [];
  for (const { id } of candidates) {
    const done = await inTx(pool, async (c) => {
      // A restore or a save holds the draft lock: skip, the next run sees the new state.
      const d = (
        await c.query(`SELECT id FROM canvas_draft WHERE id = $1 AND status = 'DISCARDED' AND purge_after <= now() FOR UPDATE SKIP LOCKED`, [id])
      ).rows[0];
      if (!d) return false;
      const revs = (await c.query<{ id: string }>(`SELECT id FROM canvas_revision WHERE draft_id = $1`, [id])).rows.map((r) => r.id);
      const assets = await releaseRevisions(c, revs);
      await c.query(`UPDATE canvas_draft SET status = 'PURGED' WHERE id = $1`, [id]);
      log('info', 'draft purged', { draft_id: id, revisions: revs.length, released_assets: assets.length });
      return true;
    });
    if (done) purged.push(id);
  }
  return purged;
}

/**
 * Deletes old revisions of ACTIVE drafts. Never the head, a pinned revision, one a publication
 * points to, the newest `revisionKeepLast`, or any younger than `revisionMinAgeSeconds`.
 * Returns "draft_id:revision_no" for each pruned revision.
 */
export async function pruneRevisions(pool: Pool, o: GcOptions): Promise<string[]> {
  const keep = Math.max(1, o.revisionKeepLast);
  const eligible = `r.draft_id = d.id AND r.revision_no <= d.head_revision_no - $1
       AND NOT r.pinned
       AND r.created_at <= now() - make_interval(secs => $2)
       AND NOT EXISTS (SELECT 1 FROM publication p WHERE p.revision_id = r.id)`;
  const candidates = (
    await pool.query<{ id: string }>(
      `SELECT d.id FROM canvas_draft d
        WHERE d.status = 'ACTIVE' AND ($3::text IS NULL OR d.owner_id = $3)
          AND EXISTS (SELECT 1 FROM canvas_revision r WHERE ${eligible})
        ORDER BY d.last_activity_at LIMIT $4`,
      [keep, o.revisionMinAgeSeconds, o.ownerId ?? null, o.batchSize],
    )
  ).rows;
  const pruned: string[] = [];
  for (const { id } of candidates) {
    const rows = await inTx(pool, async (c) => {
      // Same lock a save takes. Recheck ACTIVE under it: publishing freezes the draft.
      const d = (await c.query(`SELECT id FROM canvas_draft WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE SKIP LOCKED`, [id])).rows[0];
      if (!d) return [];
      const revs = (
        await c.query<{ id: string; revision_no: number }>(
          `SELECT r.id, r.revision_no FROM canvas_revision r JOIN canvas_draft d ON d.id = r.draft_id
            WHERE d.id = $3 AND ${eligible} ORDER BY r.revision_no`,
          [keep, o.revisionMinAgeSeconds, id],
        )
      ).rows;
      await releaseRevisions(c, revs.map((r) => r.id));
      for (const r of revs) log('info', 'revision pruned', { draft_id: id, revision_no: r.revision_no });
      return revs.map((r) => `${id}:${r.revision_no}`);
    });
    pruned.push(...rows);
  }
  return pruned;
}

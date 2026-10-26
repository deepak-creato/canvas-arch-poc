import { Pool } from 'pg';
import { log } from '../../../shared/log';
import { addPublicationReferences, AssetReferenceError, extractAssetIds, recalcRetention } from '../../../shared/refs';
import { StepError } from './errors';
import { transition } from './publication-state';

/**
 * LIVE, in one transaction: the publication references every asset of the frozen revision (so they become
 * PUBLISHED and GC leaves them alone), the final renditions are mapped, the draft becomes PUBLISHED and the
 * revision stays pinned. Either all of it commits or none; running it again on a LIVE publication changes nothing.
 */
export async function markPublicationLive(pool: Pool, publicationId: string, step: string): Promise<{ live: true; already: boolean }> {
  const p = (
    await pool.query<{ id: string; draft_id: string; owner_id: string; revision_id: string; status: string; document: unknown }>(
      `SELECT p.id, p.draft_id, p.owner_id, p.revision_id, p.status, r.document
         FROM publication p JOIN canvas_revision r ON r.id = p.revision_id WHERE p.id = $1`,
      [publicationId],
    )
  ).rows[0];
  if (!p) throw new StepError('PUBLICATION_NOT_FOUND', `publication ${publicationId} not found`);
  if (p.status === 'LIVE') return { live: true, already: true };
  if (p.status !== 'FINALIZING') throw new StepError('PUBLICATION_STATE', `publication is ${p.status}, expected FINALIZING`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock order: publication, draft, assets (id order). The save path takes draft then assets.
    const locked = (await client.query<{ status: string; manifest_key: string | null }>(`SELECT status, manifest_key FROM publication WHERE id = $1 FOR UPDATE`, [p.id])).rows[0];
    if (locked.status === 'LIVE') {
      await client.query('COMMIT');
      return { live: true, already: true };
    }
    if (locked.status !== 'FINALIZING' || !locked.manifest_key) {
      throw new StepError('PUBLICATION_STATE', `publication is ${locked.status}, manifest ${locked.manifest_key ? 'written' : 'missing'}`);
    }
    await client.query(`SELECT 1 FROM canvas_draft WHERE id = $1 FOR UPDATE`, [p.draft_id]);

    const assetIds = extractAssetIds(p.document);
    try {
      await addPublicationReferences(client, p.owner_id, p.id, assetIds);
    } catch (e) {
      if (e instanceof AssetReferenceError) throw new StepError(e.code, e.message);
      throw e;
    }
    const finals = await client.query(
      `INSERT INTO publication_asset (publication_id, asset_id, rendition_id, role)
       SELECT $1, r.asset_id, r.id, 'FINAL' FROM media_rendition r
        WHERE r.asset_id = ANY($2::uuid[]) AND r.tier = 'FINAL' AND r.status = 'READY'
       ON CONFLICT DO NOTHING`,
      [p.id, assetIds],
    );
    await recalcRetention(client, assetIds);
    await client.query(`UPDATE publication SET live_at = now() WHERE id = $1`, [p.id]);
    await transition(client, p.id, 'LIVE', step, { detail: { assets: assetIds.length, finals: finals.rowCount } });
    await client.query(`UPDATE canvas_draft SET status = 'PUBLISHED', last_activity_at = now() WHERE id = $1`, [p.draft_id]);
    await client.query(`UPDATE canvas_revision SET pinned = true WHERE id = $1`, [p.revision_id]);
    await client.query('COMMIT');
    log('info', 'publication live', { publication_id: p.id, draft_id: p.draft_id, assets: assetIds.length });
    return { live: true, already: false };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

import { PoolClient } from 'pg';

type Queryable = Pick<PoolClient, 'query'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AssetReferenceError extends Error {
  constructor(
    readonly code: 'INVALID_ASSET_REFERENCE' | 'ASSET_NOT_FOUND' | 'ASSET_NOT_READY' | 'ASSET_NOT_REFERENCEABLE',
    message: string,
    readonly assetId?: string,
  ) {
    super(message);
  }
}

/**
 * Distinct asset ids in a canvas document: every string value under a key named `asset_id`,
 * at any depth. Sorted, so locks are always taken in the same order.
 */
export function extractAssetIds(doc: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'asset_id') {
          if (typeof child !== 'string' || !UUID.test(child)) {
            throw new AssetReferenceError('INVALID_ASSET_REFERENCE', `asset_id must be a UUID string, got ${JSON.stringify(child)}`);
          }
          found.add(child.toLowerCase());
        } else walk(child);
      }
    }
  };
  walk(doc);
  return [...found].sort();
}

/**
 * Locks the asset rows (in id order) and rejects anything missing, foreign, not VALIDATED,
 * or already DELETING/DELETED. Shared by revision and publication references.
 */
async function lockReferenceable(client: PoolClient, ownerId: string, assetIds: string[]): Promise<void> {
  const rows = (
    await client.query<{ id: string; owner_id: string; upload_status: string; retention_status: string }>(
      `SELECT id, owner_id, upload_status, retention_status FROM media_asset WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [assetIds],
    )
  ).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of assetIds) {
    const a = byId.get(id);
    // Another owner's asset looks the same as a missing one.
    if (!a || a.owner_id !== ownerId) throw new AssetReferenceError('ASSET_NOT_FOUND', `asset ${id} not found`, id);
    if (a.retention_status === 'DELETING' || a.retention_status === 'DELETED') {
      throw new AssetReferenceError('ASSET_NOT_REFERENCEABLE', `asset ${id} is ${a.retention_status}`, id);
    }
    if (a.upload_status !== 'VALIDATED') throw new AssetReferenceError('ASSET_NOT_READY', `asset ${id} is ${a.upload_status}`, id);
  }
}

/**
 * Records which assets a revision uses, in the caller's transaction. Locks the asset rows
 * and rejects anything missing, foreign, not VALIDATED, or already DELETING/DELETED.
 * Returns the referenced asset ids.
 */
export async function addRevisionReferences(client: PoolClient, ownerId: string, revisionId: string, assetIds: string[]): Promise<string[]> {
  if (assetIds.length === 0) return [];
  await lockReferenceable(client, ownerId, assetIds);
  await client.query(
    `INSERT INTO media_reference (asset_id, revision_id) SELECT unnest($1::uuid[]), $2 ON CONFLICT DO NOTHING`,
    [assetIds, revisionId],
  );
  return assetIds;
}

/** Same for a publication: the published assets stay referenced for as long as the publication exists. */
export async function addPublicationReferences(client: PoolClient, ownerId: string, publicationId: string, assetIds: string[]): Promise<string[]> {
  if (assetIds.length === 0) return [];
  await lockReferenceable(client, ownerId, assetIds);
  await client.query(
    `INSERT INTO media_reference (asset_id, publication_id) SELECT unnest($1::uuid[]), $2 ON CONFLICT DO NOTHING`,
    [assetIds, publicationId],
  );
  return assetIds;
}

/**
 * Recomputes ref_count, retention_status and orphaned_at for the given assets from
 * media_reference, the only source of truth. The caller holds the asset row locks
 * (addRevisionReferences does) so counts cannot move underneath it.
 *
 *   publication reference         -> PUBLISHED
 *   other references              -> REFERENCED, orphaned_at cleared
 *   none, was referenced before   -> ORPHANED, orphaned_at set once (grace period starts there)
 *   none, never referenced        -> unchanged (UNATTACHED)
 *
 * DELETING and DELETED assets are never touched.
 */
export async function recalcRetention(db: Queryable, assetIds: string[]): Promise<void> {
  if (assetIds.length === 0) return;
  await db.query(
    `WITH c AS (
       SELECT a.id,
              (SELECT count(*)::int FROM media_reference r WHERE r.asset_id = a.id) AS n,
              EXISTS (SELECT 1 FROM media_reference r WHERE r.asset_id = a.id AND r.publication_id IS NOT NULL) AS pub
         FROM media_asset a
        WHERE a.id = ANY($1::uuid[]) AND a.retention_status NOT IN ('DELETING', 'DELETED')
     )
     UPDATE media_asset a
        SET ref_count = c.n,
            retention_status = CASE
              WHEN c.pub THEN 'PUBLISHED'
              WHEN c.n > 0 THEN 'REFERENCED'
              WHEN a.retention_status IN ('REFERENCED', 'PUBLISHED', 'ORPHANED') THEN 'ORPHANED'
              ELSE a.retention_status END,
            orphaned_at = CASE
              WHEN c.n > 0 THEN NULL
              WHEN a.retention_status IN ('REFERENCED', 'PUBLISHED', 'ORPHANED') THEN COALESCE(a.orphaned_at, now())
              ELSE a.orphaned_at END
       FROM c WHERE a.id = c.id`,
    [assetIds],
  );
}

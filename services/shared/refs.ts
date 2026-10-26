import { PoolClient } from 'pg';

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
 * Records which assets a revision uses, in the caller's transaction. Locks the asset rows
 * and rejects anything missing, foreign, not VALIDATED, or already DELETING/DELETED.
 * Returns the referenced asset ids.
 */
export async function addRevisionReferences(client: PoolClient, ownerId: string, revisionId: string, assetIds: string[]): Promise<string[]> {
  if (assetIds.length === 0) return [];
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
  await client.query(
    `INSERT INTO media_reference (asset_id, revision_id) SELECT unnest($1::uuid[]), $2 ON CONFLICT DO NOTHING`,
    [assetIds, revisionId],
  );
  return assetIds;
}

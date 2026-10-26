import { Pool } from 'pg';
import { ProcessingStatus, rollUp } from '../assets/assets.service';

export interface AssetReadiness {
  id: string;
  owner_id: string;
  kind: string;
  retention_status: string;
  status: ProcessingStatus;
  final_status: string | null;
}

/** Client-facing readiness of each asset (same roll-up as GET /v1/assets/{id}) plus the state of its final rendition. */
export async function assetReadiness(pool: Pool, assetIds: string[]): Promise<AssetReadiness[]> {
  if (assetIds.length === 0) return [];
  const rows = (
    await pool.query<{ id: string; owner_id: string; kind: string; upload_status: string; retention_status: string; derive_job: string | null; renditions: string[]; final_status: string | null }>(
      `SELECT a.id, a.owner_id, a.kind, a.upload_status, a.retention_status,
              (SELECT j.status FROM processing_job j WHERE j.asset_id = a.id AND j.job_type IN ('image-derive', 'video-derive') LIMIT 1) AS derive_job,
              COALESCE((SELECT array_agg(r.status) FROM media_rendition r WHERE r.asset_id = a.id AND r.tier = 'DRAFT'), '{}') AS renditions,
              (SELECT r.status FROM media_rendition r WHERE r.asset_id = a.id AND r.tier = 'FINAL' LIMIT 1) AS final_status
         FROM media_asset a WHERE a.id = ANY($1::uuid[]) ORDER BY a.id`,
      [assetIds],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    owner_id: r.owner_id,
    kind: r.kind,
    retention_status: r.retention_status,
    status: rollUp(r.upload_status, r.derive_job ?? undefined, r.renditions),
    final_status: r.final_status,
  }));
}

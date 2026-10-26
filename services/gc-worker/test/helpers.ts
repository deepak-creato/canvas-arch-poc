// Integration helpers: need the compose stack (make up). Postgres on 5433, LocalStack on 4566.
import { randomBytes, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { config } from '../../shared/config';
import { GcOptions } from '../src/options';

export const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
export const newOwner = () => `gc-${randomBytes(4).toString('hex')}`;

/** Options for a test: every grace is 0 (eligible now) and the run is scoped to one owner. */
export const opts = (ownerId: string, over: Partial<GcOptions> = {}): GcOptions => ({
  batchSize: 100,
  uploadExpiryGraceSeconds: 0,
  unattachedGraceSeconds: 0,
  orphanGraceSeconds: 0,
  ownerId,
  ...over,
});

export interface SeedAsset {
  owner: string;
  kind?: 'IMAGE' | 'VIDEO';
  upload_status?: string;
  retention_status?: string;
  orphaned_at?: string | null;
  upload_expires_at?: string;
  size_bytes?: number;
  content_type?: string;
}

export async function seedAsset(a: SeedAsset): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  const key = `staging/${a.owner}/${id}/source`;
  await pool.query(
    `INSERT INTO media_asset (id, owner_id, kind, client_sha256, content_type, size_bytes, original_bucket, original_key,
                              upload_status, retention_status, orphaned_at, upload_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, now() + interval '15 minutes'))`,
    [
      id, a.owner, a.kind ?? 'IMAGE', randomBytes(32).toString('hex'), a.content_type ?? 'image/png', a.size_bytes ?? 10,
      config.bucketIngest, key, a.upload_status ?? 'VALIDATED', a.retention_status ?? 'UNATTACHED', a.orphaned_at ?? null,
      a.upload_expires_at ?? null,
    ],
  );
  return { id, key };
}

export const asset = async (id: string) =>
  (await pool.query(`SELECT upload_status, retention_status, ref_count, orphaned_at FROM media_asset WHERE id = $1`, [id])).rows[0];

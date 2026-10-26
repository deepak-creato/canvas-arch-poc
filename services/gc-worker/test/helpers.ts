// Integration helpers: need the compose stack (make up). Postgres on 5433, LocalStack on 4566.
import { createHash, randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
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
  jobStaleSeconds: 3600,
  reconcileAfterSeconds: 0,
  strayGraceSeconds: 0,
  deleteStrays: false,
  revisionKeepLast: 1,
  revisionMinAgeSeconds: 0,
  ownerId,
  ...over,
});

export interface SeedAsset {
  id?: string;
  /** Default is outside staging/ so S3 events do not wake the light-worker on seeded rows. */
  key?: string;
  owner: string;
  kind?: 'IMAGE' | 'VIDEO';
  upload_status?: string;
  retention_status?: string;
  orphaned_at?: string | null;
  upload_expires_at?: string;
  size_bytes?: number;
  content_type?: string;
  sha256?: string;
}

export async function seedAsset(a: SeedAsset): Promise<{ id: string; key: string }> {
  const id = a.id ?? randomUUID();
  const key = a.key ?? `gc-test/${a.owner}/${id}/source`;
  await pool.query(
    `INSERT INTO media_asset (id, owner_id, kind, client_sha256, content_type, size_bytes, original_bucket, original_key,
                              upload_status, retention_status, orphaned_at, upload_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, now() + interval '15 minutes'))`,
    [
      id, a.owner, a.kind ?? 'IMAGE', a.sha256 ?? randomBytes(32).toString('hex'), a.content_type ?? 'image/png', a.size_bytes ?? 10,
      config.bucketIngest, key, a.upload_status ?? 'VALIDATED', a.retention_status ?? 'UNATTACHED', a.orphaned_at ?? null,
      a.upload_expires_at ?? null,
    ],
  );
  return { id, key };
}

export const asset = async (id: string) =>
  (await pool.query(`SELECT upload_status, retention_status, ref_count, orphaned_at, deleted_at, delete_attempts, delete_error FROM media_asset WHERE id = $1`, [id])).rows[0];

// canvas-api, for tests that go through the real save path
const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
export const api = async (owner: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'x-owner-id': owner, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
export const docWith = (...assetIds: string[]) => ({ elements: assetIds.map((asset_id) => ({ type: 'media', asset_id })) });

/** Creates a draft and saves one revision per document. Returns the draft id; head = docs.length + 1. */
export async function draftWith(owner: string, ...docs: Record<string, unknown>[]): Promise<string> {
  const created = await api(owner, 'POST', '/v1/drafts', {});
  expect(created.status).toBe(201);
  let head = 1;
  for (const document of docs) {
    const r = await api(owner, 'PUT', `/v1/drafts/${created.body.draft_id}`, { base_revision: head, document });
    expect(r.status).toBe(200);
    head = r.body.head_revision;
  }
  return created.body.draft_id;
}

const FIXTURE = resolve(__dirname, '../../../fixtures/sample-5.jpg');

/**
 * A real JPEG in the ingest bucket, recorded as UPLOADED, with no job yet. The key is outside staging/, so no S3
 * event fires: the light-worker only works on it when a test sends the event.
 */
export async function seedUploadedFixture(owner: string) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { createS3 } = await import('../../shared/s3');
  const bytes = readFileSync(FIXTURE);
  const a = await seedAsset({
    owner,
    upload_status: 'UPLOADED',
    content_type: 'image/jpeg',
    size_bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  await createS3().send(new PutObjectCommand({ Bucket: config.bucketIngest, Key: a.key, Body: bytes, ContentType: 'image/jpeg' }));
  return a;
}

/** An asset row plus an original and one recorded rendition in S3. */
export async function seedWithObjects(owner: string, over: Partial<SeedAsset> = {}) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { createS3 } = await import('../../shared/s3');
  const s3 = createS3();
  const a = await seedAsset({ owner, ...over });
  const derived = `derived/${a.id}/thumbnail/v1/w320.webp`;
  await pool.query(
    `INSERT INTO media_rendition (asset_id, kind, tier, bucket, s3_key, status) VALUES ($1, 'thumbnail', 'DRAFT', $2, $3, 'READY')`,
    [a.id, config.bucketDerived, derived],
  );
  await s3.send(new PutObjectCommand({ Bucket: config.bucketDerived, Key: derived, Body: 'x' }));
  await s3.send(new PutObjectCommand({ Bucket: config.bucketIngest, Key: a.key, Body: 'x' }));
  return { ...a, derived };
}

export async function objectExists(bucket: string, Key: string): Promise<boolean> {
  const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const { createS3 } = await import('../../shared/s3');
  try {
    await createS3().send(new HeadObjectCommand({ Bucket: bucket, Key }));
    return true;
  } catch {
    return false;
  }
}

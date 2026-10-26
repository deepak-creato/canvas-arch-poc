// Integration test: needs the compose stack (make up).
import { execSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { resolve } from 'path';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const COMPOSE = resolve(__dirname, '../../../docker-compose.yml');

const sql = (q: string) =>
  execSync(`docker compose -f ${COMPOSE} exec -T postgres psql -U canvas -tA -c "${q}"`).toString().trim();

const owner = () => `owner-${randomBytes(4).toString('hex')}`;
const call = (path: string, o: string | null, body?: unknown) =>
  fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(o ? { 'x-owner-id': o } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function reserve(o: string, bytes = randomBytes(64)) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const b: any = await (await call('/v1/uploads', o, { sha256, content_type: 'image/png', size_bytes: bytes.length })).json();
  return { b, bytes };
}
const put = (b: any, bytes: Buffer) =>
  fetch(b.upload_url, { method: 'PUT', headers: b.upload_headers, body: new Uint8Array(bytes) });

describe('POST /v1/uploads/:id/complete', () => {
  it('stays PENDING_UPLOAD with 409 until the object exists, then moves to UPLOADED', async () => {
    const o = owner();
    const { b, bytes } = await reserve(o);

    const early = await call(`/v1/uploads/${b.asset_id}/complete`, o);
    expect(early.status).toBe(409);
    expect(((await early.json()) as any).code).toBe('OBJECT_NOT_FOUND');
    expect(sql(`select upload_status from media_asset where id='${b.asset_id}'`)).toBe('PENDING_UPLOAD');
    expect(sql(`select count(*) from processing_job where asset_id='${b.asset_id}'`)).toBe('0');

    expect((await put(b, bytes)).status).toBe(200);
    const done = await call(`/v1/uploads/${b.asset_id}/complete`, o);
    expect(done.status).toBe(200);
    expect(((await done.json()) as any).upload_status).toBe('UPLOADED');
    expect(sql(`select upload_status from media_asset where id='${b.asset_id}'`)).toBe('UPLOADED');
  });

  it('is idempotent and creates exactly one validate job', async () => {
    const o = owner();
    const { b, bytes } = await reserve(o);
    await put(b, bytes);
    const rs = await Promise.all(Array.from({ length: 5 }, () => call(`/v1/uploads/${b.asset_id}/complete`, o)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(sql(`select count(*) from processing_job where asset_id='${b.asset_id}' and job_type='validate'`)).toBe('1');
  });

  it('404 for another owner or unknown id, 400 for bad id or missing owner', async () => {
    const o = owner();
    const { b, bytes } = await reserve(o);
    await put(b, bytes);
    expect((await call(`/v1/uploads/${b.asset_id}/complete`, owner())).status).toBe(404);
    expect((await call(`/v1/uploads/00000000-0000-4000-8000-000000000000/complete`, o)).status).toBe(404);
    expect((await call(`/v1/uploads/not-a-uuid/complete`, o)).status).toBe(400);
    expect((await call(`/v1/uploads/${b.asset_id}/complete`, null)).status).toBe(400);
    expect(sql(`select upload_status from media_asset where id='${b.asset_id}'`)).toBe('PENDING_UPLOAD');
  });

  it('rejects an expired reservation', async () => {
    const o = owner();
    const { b, bytes } = await reserve(o);
    await put(b, bytes);
    sql(`update media_asset set upload_expires_at = now() - interval '1 minute' where id='${b.asset_id}'`);
    const r = await call(`/v1/uploads/${b.asset_id}/complete`, o);
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).code).toBe('UPLOAD_EXPIRED');
  });
});

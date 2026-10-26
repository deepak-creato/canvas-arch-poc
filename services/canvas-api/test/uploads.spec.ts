// Integration test: needs the compose stack (make up). Talks to the running API over HTTP.
import { createHash, randomBytes } from 'crypto';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';

const post = (owner: string | null, body: unknown) =>
  fetch(`${API}/v1/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(owner ? { 'x-owner-id': owner } : {}) },
    body: JSON.stringify(body),
  });

const fresh = () => {
  const bytes = randomBytes(64);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
};
const req = (sha256: string, size = 64) => ({ sha256, content_type: 'image/png', size_bytes: size, filename: 'a.png' });
const owner = () => `owner-${randomBytes(4).toString('hex')}`;

describe('POST /v1/uploads', () => {
  it('new upload returns asset_id and a presigned URL that accepts the bytes', async () => {
    const { bytes, sha256 } = fresh();
    const r = await post(owner(), req(sha256));
    expect(r.status).toBe(200);
    const b: any = await r.json();
    expect(b.asset_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.deduplicated).toBe(false);
    expect(b.upload_status).toBe('PENDING_UPLOAD');
    const put = await fetch(b.upload_url, { method: 'PUT', headers: b.upload_headers, body: new Uint8Array(bytes) });
    expect(put.status).toBe(200);
  });

  it('same owner + hash reuses the asset', async () => {
    const { sha256 } = fresh();
    const o = owner();
    const a: any = await (await post(o, req(sha256))).json();
    const b: any = await (await post(o, req(sha256))).json();
    expect(b.asset_id).toBe(a.asset_id);
  });

  it('different owner gets a distinct asset', async () => {
    const { sha256 } = fresh();
    const a: any = await (await post(owner(), req(sha256))).json();
    const b: any = await (await post(owner(), req(sha256))).json();
    expect(b.asset_id).not.toBe(a.asset_id);
  });

  it('concurrent identical requests produce one asset', async () => {
    const { sha256 } = fresh();
    const o = owner();
    const rs = await Promise.all(Array.from({ length: 8 }, () => post(o, req(sha256))));
    const ids = new Set((await Promise.all(rs.map((r) => r.json()))).map((b: any) => b.asset_id));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('rejects missing owner, bad hash, bad type, oversize', async () => {
    const { sha256 } = fresh();
    expect((await post(null, req(sha256))).status).toBe(400);
    expect((await post(owner(), req('abc'))).status).toBe(400);
    expect((await post(owner(), { ...req(sha256), content_type: 'text/plain' })).status).toBe(400);
    expect((await post(owner(), req(sha256, 21 * 1024 * 1024))).status).toBe(422);
  });
});

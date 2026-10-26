// Integration test: needs the compose stack (make up) with canvas-api and light-worker running.
import { execSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const COMPOSE = resolve(__dirname, '../../../docker-compose.yml');
const FIX = resolve(__dirname, '../../../fixtures');

const sql = (q: string) =>
  execSync(`docker compose -f ${COMPOSE} exec -T postgres psql -U canvas -tA -c "${q}"`).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const owner = () => `a-${randomBytes(4).toString('hex')}`;

const getAsset = (o: string | null, id: string) =>
  fetch(`${API}/v1/assets/${id}`, { headers: o ? { 'x-owner-id': o } : {} });

async function reserve(o: string, name: string, ct: string) {
  const bytes = readFileSync(`${FIX}/${name}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const body = JSON.stringify({ sha256, content_type: ct, size_bytes: bytes.length, filename: name });
  const post = async () =>
    (await (await fetch(`${API}/v1/uploads`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-owner-id': o }, body })).json()) as any;
  const res = await post();
  return { id: res.asset_id as string, post, put: () => fetch(res.upload_url, { method: 'PUT', headers: res.upload_headers, body: new Uint8Array(bytes) }) };
}

/** Polls GET /v1/assets/{id} until processing_status is one of `until` (or times out). */
async function poll(o: string, id: string, until: string[], ms = 60000): Promise<any> {
  const end = Date.now() + ms;
  let last: any;
  while (Date.now() < end) {
    last = await (await getAsset(o, id)).json();
    if (until.includes(last.processing_status)) return last;
    await sleep(500);
  }
  throw new Error(`timed out, last status ${last?.processing_status}`);
}

describe('GET /v1/assets/:id', () => {
  it('reports PENDING before the upload, then READY with usable image URLs', async () => {
    const o = owner();
    const a = await reserve(o, 'sample-5.jpg', 'image/jpeg');

    const before: any = await (await getAsset(o, a.id)).json();
    expect(before).toMatchObject({ asset_id: a.id, kind: 'IMAGE', upload_status: 'PENDING_UPLOAD', processing_status: 'PENDING', renditions: [], filename: 'sample-5.jpg' });

    await a.put();
    const ready = await poll(o, a.id, ['READY', 'FAILED']);
    expect(ready).toMatchObject({ upload_status: 'VALIDATED', processing_status: 'READY', reject_reason: null });
    expect(ready.media).toMatchObject({ width: 1280, height: 720, format: 'jpeg' });
    expect(ready.media.etag).toBeUndefined();

    const byKind = Object.fromEntries(ready.renditions.map((r: any) => [r.kind, r]));
    expect(Object.keys(byKind).sort()).toEqual(['preview', 'thumbnail']);
    expect(byKind.thumbnail).toMatchObject({ status: 'READY', content_type: 'image/webp', width: 320, height: 180 });
    for (const r of ready.renditions) {
      const res = await fetch(r.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
    }

    // The same bytes from the same owner reuse the asset, which is already READY.
    const again = await a.post();
    expect(again).toMatchObject({ asset_id: a.id, deduplicated: true });
  });

  it('video: poster, proxy, sprite sheet and sprite.json are all reachable', async () => {
    const o = owner();
    const a = await reserve(o, 'sample.mp4', 'video/mp4');
    await a.put();
    const ready = await poll(o, a.id, ['READY', 'FAILED']);
    expect(ready.processing_status).toBe('READY');
    expect(ready.media).toMatchObject({ width: 320, height: 180, has_audio: true });
    const kinds = ready.renditions.map((r: any) => r.kind).sort();
    expect(kinds).toEqual(['poster', 'proxy', 'sprite', 'sprite_manifest']);
    const manifest = ready.renditions.find((r: any) => r.kind === 'sprite_manifest');
    const json: any = await (await fetch(manifest.url)).json();
    expect(json).toMatchObject({ asset_id: a.id, frame_count: 3 });
    for (const r of ready.renditions) expect((await fetch(r.url)).status).toBe(200);
  });

  it('a rejected upload reports REJECTED with the reason and no renditions', async () => {
    const o = owner();
    const a = await reserve(o, 'corrupt.png', 'image/png');
    await a.put();
    const r = await poll(o, a.id, ['REJECTED', 'READY']);
    expect(r).toMatchObject({ processing_status: 'REJECTED', upload_status: 'REJECTED', reject_reason: 'CORRUPT_FILE', renditions: [] });
  });

  it('a permanently failed derive job reports FAILED', async () => {
    const o = owner();
    const a = await reserve(o, 'sample-1.png', 'image/png');
    sql(`insert into processing_job (job_type, idempotency_key, asset_id, payload) values ('image-derive','derive:${a.id}:image:v1','${a.id}', jsonb_build_object('fail_mode','permanent'))`);
    await a.put();
    const r = await poll(o, a.id, ['FAILED', 'READY']);
    expect(r.processing_status).toBe('FAILED');
    expect(r.upload_status).toBe('VALIDATED');
    expect(r.renditions.every((x: any) => x.status === 'FAILED_PERMANENT' && x.url === null)).toBe(true);
  });

  it('is owner-scoped and validates input', async () => {
    const o = owner();
    const a = await reserve(o, 'sample-1.png', 'image/png');
    expect((await getAsset(owner(), a.id)).status).toBe(404);
    expect((await getAsset(o, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await getAsset(o, 'nope')).status).toBe(400);
    expect((await getAsset(null, a.id)).status).toBe(400);
    expect((await getAsset(o, a.id)).status).toBe(200);
  });
});

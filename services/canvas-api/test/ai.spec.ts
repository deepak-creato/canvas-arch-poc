// Integration test: needs the compose stack (make up) with canvas-api, ai-worker and light-worker running.
import { execSync } from 'child_process';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const COMPOSE = resolve(__dirname, '../../../docker-compose.yml');
const FIX = resolve(__dirname, '../../../fixtures');
const sql = (q: string) => execSync(`docker compose -f ${COMPOSE} exec -T postgres psql -U canvas -tA -c "${q}"`).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const owner = () => `ai-${randomBytes(4).toString('hex')}`;

const call = (o: string | null, method: string, path: string, body?: unknown) =>
  fetch(`${API}${path}`, {
    method,
    headers: { ...(o ? { 'x-owner-id': o } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const json = async (r: Response) => (await r.json()) as any;

async function validatedAsset(o: string, name = 'sample-5.jpg', ct = 'image/jpeg'): Promise<string> {
  const bytes = readFileSync(`${FIX}/${name}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const res = await json(await call(o, 'POST', '/v1/uploads', { sha256, content_type: ct, size_bytes: bytes.length, filename: name }));
  await fetch(res.upload_url, { method: 'PUT', headers: res.upload_headers, body: new Uint8Array(bytes) });
  for (let i = 0; i < 120; i++) {
    const a = await json(await call(o, 'GET', `/v1/assets/${res.asset_id}`));
    if (a.upload_status === 'VALIDATED') return res.asset_id;
    if (a.upload_status === 'REJECTED') throw new Error('fixture rejected');
    await sleep(500);
  }
  throw new Error('asset never validated');
}

async function pollGen(o: string, id: string, until: string[], ms = 30000): Promise<any> {
  const end = Date.now() + ms;
  let last: any;
  while (Date.now() < end) {
    last = await json(await call(o, 'GET', `/v1/ai-layouts/${id}`));
    if (until.includes(last.status)) return last;
    await sleep(300);
  }
  throw new Error(`timed out, last status ${last?.status}`);
}

const jobCount = (o: string) => Number(sql(`SELECT count(*) FROM processing_job j JOIN media_asset a ON a.id = j.asset_id WHERE a.owner_id = '${o}'`));

describe('AI layout request and polling (POC-021)', () => {
  it('goes QUEUED -> READY and returns a canvas that only references the requested assets', async () => {
    const o = owner();
    const a1 = await validatedAsset(o);
    const a2 = await validatedAsset(o, 'sample-1.png', 'image/png');
    const draft = await json(await call(o, 'POST', '/v1/drafts', {}));
    const jobs = jobCount(o);

    const res = await call(o, 'POST', `/v1/drafts/${draft.draft_id}/ai-layouts`, { asset_ids: [a1, a2], seed: 11 });
    expect(res.status).toBe(202);
    const gen = await json(res);
    expect(gen).toMatchObject({ status: 'QUEUED', result: null, cached: false, draft_id: draft.draft_id });

    const done = await pollGen(o, gen.generation_id, ['READY', 'FAILED']);
    expect(done.status).toBe('READY');
    expect(done.result).toMatchObject({ version: 1, canvas: { width: 1080, height: 1080 } });
    expect(done.result.elements.map((e: any) => e.asset_id).sort()).toEqual([a1, a2].sort());

    // Asking for a layout creates no media work and no draft revision.
    expect(jobCount(o)).toBe(jobs);
    expect((await json(await call(o, 'GET', `/v1/drafts/${draft.draft_id}`))).head_revision).toBe(1);
  });

  it('turns an injected permanent failure into FAILED with an error', async () => {
    const o = owner();
    const a = await validatedAsset(o);
    const draft = await json(await call(o, 'POST', '/v1/drafts', {}));
    const gen = await json(await call(o, 'POST', `/v1/drafts/${draft.draft_id}/ai-layouts`, { asset_ids: [a], seed: 1, test_fail: 'permanent' }));
    const done = await pollGen(o, gen.generation_id, ['READY', 'FAILED']);
    expect(done).toMatchObject({ status: 'FAILED', result: null, error: 'injected permanent failure' });
  });

  it('retries a transient failure and still ends READY', async () => {
    const o = owner();
    const a = await validatedAsset(o);
    const draft = await json(await call(o, 'POST', '/v1/drafts', {}));
    const gen = await json(await call(o, 'POST', `/v1/drafts/${draft.draft_id}/ai-layouts`, { asset_ids: [a], seed: 2, test_fail: 'transient_once' }));
    const done = await pollGen(o, gen.generation_id, ['READY', 'FAILED'], 40000);
    expect(done.status).toBe('READY');
  });

  it('rejects unknown, foreign and unready assets, bad bodies and non-active drafts', async () => {
    const o = owner();
    const mine = await validatedAsset(o);
    const draft = await json(await call(o, 'POST', '/v1/drafts', {}));
    const post = (body: unknown, d = draft.draft_id, who = o) => call(who, 'POST', `/v1/drafts/${d}/ai-layouts`, body);
    const code = async (r: Response) => [r.status, (await json(r)).code];

    expect(await code(await post({ asset_ids: [mine, randomUUID()] }))).toEqual([422, 'ASSET_NOT_FOUND']);
    expect(await code(await post({ asset_ids: [await validatedAsset(owner())] }))).toEqual([422, 'ASSET_NOT_FOUND']);
    expect((await post({ asset_ids: [] })).status).toBe(400);
    expect((await post({ asset_ids: [mine, mine] })).status).toBe(400);
    expect((await post({ asset_ids: ['x'] })).status).toBe(400);
    expect((await post({ asset_ids: [mine] }, draft.draft_id, owner())).status).toBe(404);

    sql(`UPDATE media_asset SET retention_status = 'DELETING' WHERE id = '${mine}'`);
    expect(await code(await post({ asset_ids: [mine] }))).toEqual([422, 'ASSET_NOT_REFERENCEABLE']);
    sql(`UPDATE media_asset SET retention_status = 'UNATTACHED' WHERE id = '${mine}'`);

    sql(`UPDATE canvas_draft SET status = 'PUBLISHING' WHERE id = '${draft.draft_id}'`);
    expect(await code(await post({ asset_ids: [mine] }))).toEqual([409, 'DRAFT_FROZEN']);
  });

  it('hides a generation from other owners', async () => {
    const o = owner();
    const a = await validatedAsset(o);
    const draft = await json(await call(o, 'POST', '/v1/drafts', {}));
    const gen = await json(await call(o, 'POST', `/v1/drafts/${draft.draft_id}/ai-layouts`, { asset_ids: [a], seed: 3 }));
    expect((await call(owner(), 'GET', `/v1/ai-layouts/${gen.generation_id}`)).status).toBe(404);
    expect((await call(o, 'GET', `/v1/ai-layouts/${randomUUID()}`)).status).toBe(404);
  });
});

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

describe('AI cache and accept (POC-022)', () => {
  it('M4 exit demo: the second identical request is served from cache with no media work', async () => {
    const o = owner();
    const a1 = await validatedAsset(o);
    const a2 = await validatedAsset(o, 'sample-1.png', 'image/png');
    const draft = await json(await call(o, 'POST', '/v1/drafts', {}));
    const url = `/v1/drafts/${draft.draft_id}/ai-layouts`;
    const jobs = jobCount(o);
    const renditions = sql(`SELECT count(*) FROM media_rendition r JOIN media_asset a ON a.id = r.asset_id WHERE a.owner_id = '${o}'`);

    const first = await json(await call(o, 'POST', url, { asset_ids: [a1, a2], seed: 5 }));
    const done = await pollGen(o, first.generation_id, ['READY', 'FAILED']);
    expect(done.status).toBe('READY');

    const res = await call(o, 'POST', url, { asset_ids: [a1, a2], seed: 5 });
    expect(res.status).toBe(200);
    const second = await json(res);
    expect(second).toMatchObject({ status: 'READY', cached: true, cached_from: first.generation_id });
    expect(second.generation_id).not.toBe(first.generation_id);
    expect(second.result).toEqual(done.result);

    expect(jobCount(o)).toBe(jobs);
    expect(sql(`SELECT count(*) FROM media_rendition r JOIN media_asset a ON a.id = r.asset_id WHERE a.owner_id = '${o}'`)).toBe(renditions);
    // One worker run only: the cached row never went through the queue.
    expect(sql(`SELECT count(*) FROM ai_generation WHERE owner_id = '${o}' AND cached_from_id IS NULL`)).toBe('1');
  });

  it('misses the cache when seed, asset order, canvas or model version differ, and across owners', async () => {
    const o = owner();
    const a1 = await validatedAsset(o);
    const a2 = await validatedAsset(o, 'sample-1.png', 'image/png');
    const draft = await json(await call(o, 'POST', '/v1/drafts', {}));
    const url = `/v1/drafts/${draft.draft_id}/ai-layouts`;
    const base = await json(await call(o, 'POST', url, { asset_ids: [a1, a2], seed: 7 }));
    await pollGen(o, base.generation_id, ['READY']);

    for (const body of [
      { asset_ids: [a1, a2], seed: 8 },
      { asset_ids: [a2, a1], seed: 7 },
      { asset_ids: [a1, a2], seed: 7, canvas: { width: 800, height: 600 } },
      { asset_ids: [a1, a2], seed: 7, model_version: 'mock-layout-v2' },
    ]) {
      const res = await call(o, 'POST', url, body);
      expect([res.status, (await json(res)).cached]).toEqual([202, false]);
    }
    // Same bytes under another owner are a different asset: nothing to reuse.
    const o2 = owner();
    const b = await validatedAsset(o2);
    const d2 = await json(await call(o2, 'POST', '/v1/drafts', {}));
    expect((await call(o2, 'POST', `/v1/drafts/${d2.draft_id}/ai-layouts`, { asset_ids: [b], seed: 7 })).status).toBe(202);
  });

  it('accepts a READY layout as an AI_GENERATION revision with references, once', async () => {
    const o = owner();
    const a = await validatedAsset(o);
    const draft = await json(await call(o, 'POST', '/v1/drafts', {}));
    const id = draft.draft_id;
    const gen = await json(await call(o, 'POST', `/v1/drafts/${id}/ai-layouts`, { asset_ids: [a], seed: 9 }));
    const ready = await pollGen(o, gen.generation_id, ['READY']);
    const accept = (base: number) => call(o, 'POST', `/v1/drafts/${id}/ai-layouts/${gen.generation_id}/accept`, { base_revision: base });

    const res = await accept(1);
    expect(res.status).toBe(200);
    const out = await json(res);
    expect(out).toMatchObject({ already_accepted: false, unchanged: false, head_revision: 2, revision: { revision_no: 2, source: 'AI_GENERATION', document: ready.result }, generation: { accepted_revision: 2 } });
    expect(sql(`SELECT ref_count || '|' || retention_status FROM media_asset WHERE id = '${a}'`)).toBe('1|REFERENCED');

    const again = await json(await accept(1));
    expect(again).toMatchObject({ already_accepted: true, generation: { accepted_revision: 2 } });
    expect((await json(await call(o, 'GET', `/v1/drafts/${id}/revisions`))).revisions).toHaveLength(2);
  });

  it('applies the normal save rules: stale base conflicts; not READY, other draft and frozen draft are rejected', async () => {
    const o = owner();
    const a = await validatedAsset(o);
    const draft = await json(await call(o, 'POST', '/v1/drafts', {}));
    const id = draft.draft_id;
    const gen = await json(await call(o, 'POST', `/v1/drafts/${id}/ai-layouts`, { asset_ids: [a], seed: 21 }));
    await pollGen(o, gen.generation_id, ['READY']);
    const accept = (d: string, base: number, g = gen.generation_id, who = o) => call(who, 'POST', `/v1/drafts/${d}/ai-layouts/${g}/accept`, { base_revision: base });

    await call(o, 'PUT', `/v1/drafts/${id}`, { base_revision: 1, document: { elements: [{ id: 'z' }] } });
    const stale = await accept(id, 1);
    expect([stale.status, (await json(stale)).code]).toEqual([409, 'REVISION_CONFLICT']);
    expect((await json(await call(o, 'GET', `/v1/ai-layouts/${gen.generation_id}`))).accepted_revision).toBeNull();

    const other = await json(await call(o, 'POST', '/v1/drafts', {}));
    expect((await accept(other.draft_id, 1)).status).toBe(404);
    expect((await accept(id, 2, gen.generation_id, owner())).status).toBe(404);

    const failed = await json(await call(o, 'POST', `/v1/drafts/${id}/ai-layouts`, { asset_ids: [a], seed: 22, test_fail: 'permanent' }));
    await pollGen(o, failed.generation_id, ['FAILED']);
    const notReady = await accept(id, 2, failed.generation_id);
    expect([notReady.status, (await json(notReady)).code]).toEqual([409, 'GENERATION_NOT_READY']);

    sql(`UPDATE canvas_draft SET status = 'PUBLISHING' WHERE id = '${id}'`);
    const frozen = await accept(id, 2);
    expect([frozen.status, (await json(frozen)).code]).toEqual([409, 'DRAFT_FROZEN']);
  });
});

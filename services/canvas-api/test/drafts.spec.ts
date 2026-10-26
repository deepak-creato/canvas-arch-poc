// Integration test: needs the compose stack (make up) with canvas-api running.
import { execSync } from 'child_process';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Pool } from 'pg';
import { config } from '../../shared/config';
import { recalcRetention } from '../../shared/refs';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const owner = () => `d-${randomBytes(4).toString('hex')}`;

const call = (o: string | null, method: string, path: string, body?: unknown) =>
  fetch(`${API}${path}`, {
    method,
    headers: { ...(o ? { 'x-owner-id': o } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const json = async (r: Response) => (await r.json()) as any;

const COMPOSE = resolve(__dirname, '../../../docker-compose.yml');
const FIX = resolve(__dirname, '../../../fixtures');
const sql = (q: string) => execSync(`docker compose -f ${COMPOSE} exec -T postgres psql -U canvas -tA -c "${q}"`).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Uploads a fixture and waits for VALIDATED. Fixtures are keyed by owner, so each test owner gets its own asset. */
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

describe('drafts: create, read, list (POC-014)', () => {
  it('creates a draft with revision 1 and reads it back', async () => {
    const o = owner();
    const res = await call(o, 'POST', '/v1/drafts', {});
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created).toMatchObject({ status: 'ACTIVE', head_revision: 1, revision: { revision_no: 1, source: 'INITIAL', document: { elements: [] } } });

    const got = await json(await call(o, 'GET', `/v1/drafts/${created.draft_id}`));
    expect(got).toMatchObject({ draft_id: created.draft_id, head_revision: 1, revision: { revision_no: 1, content_hash: created.revision.content_hash } });
  });

  it('keeps a supplied starting document', async () => {
    const o = owner();
    const doc = { elements: [{ id: 'a', type: 'text', text: 'hi' }] };
    const created = await json(await call(o, 'POST', '/v1/drafts', { document: doc }));
    expect(created.revision.document).toEqual(doc);
  });

  it('rejects a non-object document and a missing owner', async () => {
    expect((await call(owner(), 'POST', '/v1/drafts', { document: 'x' })).status).toBe(400);
    expect((await call(null, 'POST', '/v1/drafts', {})).status).toBe(400);
  });

  it('hides drafts from other owners', async () => {
    const created = await json(await call(owner(), 'POST', '/v1/drafts', {}));
    const res = await call(owner(), 'GET', `/v1/drafts/${created.draft_id}`);
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ code: 'DRAFT_NOT_FOUND' });
    expect((await call(owner(), 'GET', `/v1/drafts/${randomUUID()}`)).status).toBe(404);
  });

  it('lists only the caller drafts, newest activity first', async () => {
    const o = owner();
    const a = await json(await call(o, 'POST', '/v1/drafts', {}));
    const b = await json(await call(o, 'POST', '/v1/drafts', {}));
    await json(await call(owner(), 'POST', '/v1/drafts', {}));
    const list = await json(await call(o, 'GET', '/v1/drafts'));
    expect(list.drafts.map((d: any) => d.draft_id).sort()).toEqual([a.draft_id, b.draft_id].sort());
    expect((await call(o, 'GET', '/v1/drafts?status=BOGUS')).status).toBe(400);
  });
});

const jobCount = () => Number(sql('SELECT count(*) FROM processing_job'));

describe('drafts: immutable revisions (POC-015)', () => {
  it('increments the revision on change and skips an unchanged document', async () => {
    const o = owner();
    const d = await json(await call(o, 'POST', '/v1/drafts', {}));
    const id = d.draft_id;

    const r2 = await json(await call(o, 'PUT', `/v1/drafts/${id}`, { base_revision: 1, document: { elements: [{ id: 'a', type: 'text' }] } }));
    expect(r2).toMatchObject({ unchanged: false, head_revision: 2, revision: { revision_no: 2, source: 'USER_SAVE' } });

    // Same content, different key order: still unchanged.
    const same = await json(await call(o, 'PUT', `/v1/drafts/${id}`, { base_revision: 2, document: { elements: [{ type: 'text', id: 'a' }] } }));
    expect(same).toMatchObject({ unchanged: true, head_revision: 2, revision: { revision_no: 2 } });

    const list = await json(await call(o, 'GET', `/v1/drafts/${id}/revisions`));
    expect(list.head_revision).toBe(2);
    expect(list.revisions.map((r: any) => r.revision_no)).toEqual([2, 1]);
    expect(list.revisions[0].document).toBeUndefined();
  });

  it('keeps old revisions unchanged and starts no media jobs', async () => {
    const o = owner();
    const d = await json(await call(o, 'POST', '/v1/drafts', {}));
    const before = jobCount();
    for (let i = 0; i < 5; i++) {
      await call(o, 'PUT', `/v1/drafts/${d.draft_id}`, { base_revision: i + 1, document: { elements: [{ id: 'a', x: i }] } });
    }
    expect(jobCount()).toBe(before);
    const got = await json(await call(o, 'GET', `/v1/drafts/${d.draft_id}`));
    expect(got).toMatchObject({ head_revision: 6, revision: { document: { elements: [{ id: 'a', x: 4 }] } } });
  });

  it('rejects a bad body and another owner', async () => {
    const o = owner();
    const d = await json(await call(o, 'POST', '/v1/drafts', {}));
    expect((await call(o, 'PUT', `/v1/drafts/${d.draft_id}`, { document: {} })).status).toBe(400);
    expect((await call(o, 'PUT', `/v1/drafts/${d.draft_id}`, { base_revision: 1, document: [] })).status).toBe(400);
    expect((await call(owner(), 'PUT', `/v1/drafts/${d.draft_id}`, { base_revision: 1, document: {} })).status).toBe(404);
  });
});

describe('drafts: optimistic concurrency (POC-016)', () => {
  it('returns 409 REVISION_CONFLICT for a stale base_revision and saves nothing', async () => {
    const o = owner();
    const d = await json(await call(o, 'POST', '/v1/drafts', {}));
    const id = d.draft_id;
    await call(o, 'PUT', `/v1/drafts/${id}`, { base_revision: 1, document: { elements: [{ id: 'a' }] } });

    const stale = await call(o, 'PUT', `/v1/drafts/${id}`, { base_revision: 1, document: { elements: [{ id: 'b' }] } });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ code: 'REVISION_CONFLICT', head_revision: 2 });

    const got = await json(await call(o, 'GET', `/v1/drafts/${id}`));
    expect(got).toMatchObject({ head_revision: 2, revision: { document: { elements: [{ id: 'a' }] } } });
  });

  it('rejects a base_revision ahead of the head', async () => {
    const o = owner();
    const d = await json(await call(o, 'POST', '/v1/drafts', {}));
    const res = await call(o, 'PUT', `/v1/drafts/${d.draft_id}`, { base_revision: 5, document: { x: 1 } });
    expect(res.status).toBe(409);
  });

  it('checks the base before the unchanged shortcut', async () => {
    const o = owner();
    const d = await json(await call(o, 'POST', '/v1/drafts', {}));
    await call(o, 'PUT', `/v1/drafts/${d.draft_id}`, { base_revision: 1, document: { x: 1 } });
    // Stale base, content equal to head: still a conflict.
    const res = await call(o, 'PUT', `/v1/drafts/${d.draft_id}`, { base_revision: 1, document: { x: 1 } });
    expect(res.status).toBe(409);
  });

  it('lets exactly one of several parallel saves from the same base win', async () => {
    const o = owner();
    const d = await json(await call(o, 'POST', '/v1/drafts', {}));
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => call(o, 'PUT', `/v1/drafts/${d.draft_id}`, { base_revision: 1, document: { n: i } })),
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    const list = await json(await call(o, 'GET', `/v1/drafts/${d.draft_id}/revisions`));
    expect(list.revisions.map((r: any) => r.revision_no)).toEqual([2, 1]);
  });
});

const refs = (draftId: string) =>
  sql(`SELECT r.revision_no || ':' || m.asset_id FROM media_reference m JOIN canvas_revision r ON r.id = m.revision_id WHERE r.draft_id = '${draftId}' ORDER BY 1`)
    .split('\n')
    .filter(Boolean);

describe('drafts: revision references (POC-017)', () => {
  it('records exact revision-to-asset usage, including nested and repeated ids', async () => {
    const o = owner();
    const a1 = await validatedAsset(o);
    const a2 = await validatedAsset(o, 'sample-1.png', 'image/png');
    const d = await json(await call(o, 'POST', '/v1/drafts', {}));

    const doc = { elements: [{ id: 'x', asset_id: a1 }, { id: 'g', children: [{ asset_id: a2 }, { asset_id: a1 }] }] };
    expect((await call(o, 'PUT', `/v1/drafts/${d.draft_id}`, { base_revision: 1, document: doc })).status).toBe(200);
    expect(refs(d.draft_id)).toEqual([`2:${a1}`, `2:${a2}`].sort());

    // Revision 3 drops a2; revision 2 keeps its reference.
    await call(o, 'PUT', `/v1/drafts/${d.draft_id}`, { base_revision: 2, document: { elements: [{ asset_id: a1 }] } });
    expect(refs(d.draft_id)).toEqual([`2:${a1}`, `2:${a2}`, `3:${a1}`].sort());
  });

  it('writes references for the starting document of a new draft', async () => {
    const o = owner();
    const a = await validatedAsset(o);
    const d = await json(await call(o, 'POST', '/v1/drafts', { document: { elements: [{ asset_id: a }] } }));
    expect(refs(d.draft_id)).toEqual([`1:${a}`]);
  });

  it('rejects bad references and writes no revision or reference', async () => {
    const o = owner();
    const mine = await validatedAsset(o);
    const d = await json(await call(o, 'POST', '/v1/drafts', {}));
    const put = (document: unknown) => call(o, 'PUT', `/v1/drafts/${d.draft_id}`, { base_revision: 1, document });

    const malformed = await put({ elements: [{ asset_id: 'nope' }] });
    expect([malformed.status, (await json(malformed)).code]).toEqual([422, 'INVALID_ASSET_REFERENCE']);

    const missing = await put({ elements: [{ asset_id: mine }, { asset_id: randomUUID() }] });
    expect([missing.status, (await json(missing)).code]).toEqual([422, 'ASSET_NOT_FOUND']);

    const foreign = await put({ elements: [{ asset_id: await validatedAsset(owner()) }] });
    expect([foreign.status, (await json(foreign)).code]).toEqual([422, 'ASSET_NOT_FOUND']);

    sql(`UPDATE media_asset SET retention_status = 'DELETING' WHERE id = '${mine}'`);
    const deleting = await put({ elements: [{ asset_id: mine }] });
    expect([deleting.status, (await json(deleting)).code]).toEqual([422, 'ASSET_NOT_REFERENCEABLE']);
    sql(`UPDATE media_asset SET retention_status = 'UNATTACHED' WHERE id = '${mine}'`);

    const pendingBytes = readFileSync(`${FIX}/sample-2.jpg`);
    const pending = await json(
      await call(o, 'POST', '/v1/uploads', { sha256: createHash('sha256').update(pendingBytes).digest('hex'), content_type: 'image/jpeg', size_bytes: pendingBytes.length, filename: 'p.jpg' }),
    );
    const notReady = await put({ elements: [{ asset_id: pending.asset_id }] });
    expect([notReady.status, (await json(notReady)).code]).toEqual([422, 'ASSET_NOT_READY']);

    expect(refs(d.draft_id)).toEqual([]);
    expect((await json(await call(o, 'GET', `/v1/drafts/${d.draft_id}`))).head_revision).toBe(1);
  });
});

describe('drafts: ref_count and retention (POC-018)', () => {
  const state = (id: string) => sql(`SELECT ref_count || '|' || retention_status || '|' || (orphaned_at IS NOT NULL) FROM media_asset WHERE id = '${id}'`);

  it('counts each revision holder and stays REFERENCED while any holder remains', async () => {
    const o = owner();
    const a = await validatedAsset(o);
    expect(state(a)).toBe('0|UNATTACHED|false');

    const d1 = await json(await call(o, 'POST', '/v1/drafts', { document: { elements: [{ asset_id: a }] } }));
    expect(state(a)).toBe('1|REFERENCED|false');
    const d2 = await json(await call(o, 'POST', '/v1/drafts', { document: { elements: [{ asset_id: a }] } }));
    expect(state(a)).toBe('2|REFERENCED|false');

    // Same draft, new revision using the asset again: one more holder (history is retained).
    await call(o, 'PUT', `/v1/drafts/${d1.draft_id}`, { base_revision: 1, document: { elements: [{ asset_id: a }, { id: 'n' }] } });
    expect(state(a)).toBe('3|REFERENCED|false');

    // Drop d1's holders: d2 still keeps the asset alive.
    const pool = new Pool({ connectionString: config.databaseUrl });
    try {
      sql(`DELETE FROM media_reference WHERE revision_id IN (SELECT id FROM canvas_revision WHERE draft_id = '${d1.draft_id}')`);
      await recalcRetention(pool, [a]);
      expect(state(a)).toBe('1|REFERENCED|false');

      // Last holder gone: ORPHANED, orphaned_at set once.
      sql(`DELETE FROM media_reference WHERE revision_id IN (SELECT id FROM canvas_revision WHERE draft_id = '${d2.draft_id}')`);
      await recalcRetention(pool, [a]);
      expect(state(a)).toBe('0|ORPHANED|true');
      const first = sql(`SELECT orphaned_at FROM media_asset WHERE id = '${a}'`);
      await recalcRetention(pool, [a]);
      expect(sql(`SELECT orphaned_at FROM media_asset WHERE id = '${a}'`)).toBe(first);

      // A new reference rescues it.
      const d3 = await json(await call(o, 'POST', '/v1/drafts', { document: { elements: [{ asset_id: a }] } }));
      expect(d3.status).toBe('ACTIVE');
      expect(state(a)).toBe('1|REFERENCED|false');

      // DELETING is never touched.
      sql(`UPDATE media_asset SET retention_status = 'DELETING' WHERE id = '${a}'`);
      await recalcRetention(pool, [a]);
      expect(state(a)).toBe('1|DELETING|false');
    } finally {
      await pool.end();
    }
  });
});

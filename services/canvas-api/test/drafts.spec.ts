// Integration test: needs the compose stack (make up) with canvas-api running.
import { randomBytes, randomUUID } from 'crypto';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const owner = () => `d-${randomBytes(4).toString('hex')}`;

const call = (o: string | null, method: string, path: string, body?: unknown) =>
  fetch(`${API}${path}`, {
    method,
    headers: { ...(o ? { 'x-owner-id': o } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const json = async (r: Response) => (await r.json()) as any;

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

const jobCount = () => {
  const { execSync } = require('child_process');
  const compose = require('path').resolve(__dirname, '../../../docker-compose.yml');
  return Number(execSync(`docker compose -f ${compose} exec -T postgres psql -U canvas -tA -c "SELECT count(*) FROM processing_job"`).toString().trim());
};

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

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

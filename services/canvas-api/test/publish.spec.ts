// Integration test: needs the compose stack (make up).
import { randomUUID } from 'crypto';
import { call, draftWith, json, owner, pubStatus, readyAsset, sql, until } from './publish-helpers';

const publish = (o: string, draftId: string, key: string | null, body: unknown = { revision: 1 }) =>
  call(o, 'POST', `/v1/drafts/${draftId}/publications`, body, key ? { 'idempotency-key': key } : {});

describe('publish request (POC-026)', () => {
  it('reserves the draft, pins the revision and answers with a status URL', async () => {
    const o = owner();
    const img = await readyAsset(o);
    const draft = await draftWith(o, [img]);

    const res = await publish(o, draft, randomUUID());
    expect(res.status).toBe(202);
    const pub = await json(res);
    expect(pub).toMatchObject({ draft_id: draft, revision: 1, status: 'REQUESTED', attempt: 1, idempotent_replay: false });
    expect(pub.status_url).toBe(`/v1/publications/${pub.publication_id}`);

    expect(sql(`SELECT status FROM canvas_draft WHERE id = '${draft}'`)).toBe('PUBLISHING');
    expect(sql(`SELECT pinned FROM canvas_revision WHERE draft_id = '${draft}' AND revision_no = 1`)).toBe('t');
    expect(sql(`SELECT execution_arn IS NOT NULL FROM publication WHERE id = '${pub.publication_id}'`)).toBe('t');

    const got = await json(await call(o, 'GET', pub.status_url));
    expect(got.publication_id).toBe(pub.publication_id);
    expect(got.transitions[0]).toMatchObject({ from: null, to: 'REQUESTED', step: 'PUBLISH_REQUEST' });
    expect(got.manifest_url).toBeNull();
  });

  it('returns the same operation for a repeated key, even for a double click', async () => {
    const o = owner();
    const draft = await draftWith(o, []);
    const key = randomUUID();
    const [a, b] = await Promise.all([publish(o, draft, key), publish(o, draft, key)]);
    const [pa, pb] = [await json(a), await json(b)];
    expect(pa.publication_id).toBe(pb.publication_id);
    expect([a.status, b.status].sort()).toEqual([200, 202]);

    const again = await publish(o, draft, key);
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ publication_id: pa.publication_id, idempotent_replay: true });
    expect(sql(`SELECT count(*) FROM publication WHERE draft_id = '${draft}'`)).toBe('1');
    expect(sql(`SELECT count(*) FROM publication_transition WHERE publication_id = '${pa.publication_id}' AND to_status = 'REQUESTED'`)).toBe('1');
  });

  it('rejects a second publish with another key, and a key reused for another revision', async () => {
    const o = owner();
    const draft = await draftWith(o, []);
    const first = await json(await publish(o, draft, 'key-one'));

    const other = await publish(o, draft, 'key-two');
    expect(other.status).toBe(409);
    expect(await json(other)).toMatchObject({ code: 'PUBLICATION_EXISTS', publication_id: first.publication_id });

    const reused = await publish(o, draft, 'key-one', { revision: 2 });
    expect(reused.status).toBe(409);
    expect((await json(reused)).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(sql(`SELECT count(*) FROM publication WHERE draft_id = '${draft}'`)).toBe('1');
  });

  it('publishes exactly the requested revision, not the head', async () => {
    const o = owner();
    const draft = await draftWith(o, []);
    const doc = { version: 1, canvas: { width: 1080, height: 1080 }, elements: [{ id: 'x' }] };
    expect((await call(o, 'PUT', `/v1/drafts/${draft}`, { base_revision: 1, document: doc })).status).toBe(200);

    const pub = await json(await publish(o, draft, randomUUID(), { revision: 1 }));
    expect(pub.revision).toBe(1);
    expect(sql(`SELECT r.revision_no FROM publication p JOIN canvas_revision r ON r.id = p.revision_id WHERE p.id = '${pub.publication_id}'`)).toBe('1');
    expect(sql(`SELECT pinned FROM canvas_revision WHERE draft_id = '${draft}' AND revision_no = 2`)).toBe('f');
  });

  it('freezes the draft: edits, restore, discard and AI requests are rejected', async () => {
    const o = owner();
    const img = await readyAsset(o);
    const draft = await draftWith(o, [img]);
    await publish(o, draft, randomUUID());

    const doc = { version: 1, canvas: { width: 1080, height: 1080 }, elements: [] };
    const save = await call(o, 'PUT', `/v1/drafts/${draft}`, { base_revision: 1, document: doc });
    expect(save.status).toBe(409);
    expect((await json(save)).code).toBe('DRAFT_FROZEN');
    expect((await call(o, 'POST', `/v1/drafts/${draft}/revisions/1/restore`)).status).toBe(409);
    expect((await call(o, 'DELETE', `/v1/drafts/${draft}`)).status).toBe(409);
    const ai = await call(o, 'POST', `/v1/drafts/${draft}/ai-layouts`, { asset_ids: [img] });
    expect(ai.status).toBe(409);
    expect((await json(ai)).code).toBe('DRAFT_FROZEN');
  });

  it('validates the request and scopes it to the owner', async () => {
    const o = owner();
    const draft = await draftWith(o, []);
    expect((await publish(o, draft, null)).status).toBe(400);
    expect((await publish(o, draft, 'k', { revision: 0 })).status).toBe(400);
    expect((await publish(o, draft, 'k', { revision: 9 })).status).toBe(404);
    expect(sql(`SELECT status FROM canvas_draft WHERE id = '${draft}'`)).toBe('ACTIVE');
    expect((await publish(owner(), draft, 'k')).status).toBe(404);
    expect((await call(o, 'POST', '/v1/drafts/' + randomUUID() + '/publications', { revision: 1 }, { 'idempotency-key': 'k' })).status).toBe(404);

    const pub = await json(await publish(o, draft, 'k'));
    expect((await call(owner(), 'GET', pub.status_url)).status).toBe(404);
    expect((await call(null, 'GET', pub.status_url)).status).toBe(400);
  });

  it('a discarded draft cannot be published', async () => {
    const o = owner();
    const draft = await draftWith(o, []);
    await call(o, 'DELETE', `/v1/drafts/${draft}`);
    const res = await publish(o, draft, randomUUID());
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('DRAFT_DISCARDED');
  });

  it('the workflow starts on its own', async () => {
    const o = owner();
    const draft = await draftWith(o, []);
    const pub = await json(await publish(o, draft, randomUUID()));
    // Past REQUESTED means the state machine ran its first step through the queue.
    expect(await until(() => pubStatus(pub.publication_id), (s) => s !== 'REQUESTED')).not.toBe('REQUESTED');
  });
});

// Integration test: needs the compose stack (make up).
import { executionStatus, call, json, owner, publishToGate, sql, uploadCanvas } from './publish-helpers';

describe('canvas gate (POC-027)', () => {
  it('waits in AWAITING_CANVAS with the task token stored, and issues a fresh upload URL', async () => {
    const o = owner();
    const g = await publishToGate(o);
    expect(g.status).toBe('AWAITING_CANVAS');
    expect(sql(`SELECT task_token IS NOT NULL FROM publication WHERE id = '${g.id}'`)).toBe('t');
    expect(await executionStatus(sql(`SELECT execution_arn FROM publication WHERE id = '${g.id}'`))).toBe('RUNNING');
    expect(sql(`SELECT string_agg(to_status, ',' ORDER BY id) FROM publication_transition WHERE publication_id = '${g.id}'`)).toBe(
      'REQUESTED,WAITING_FOR_ASSETS,TRANSCODING,AWAITING_CANVAS',
    );

    const { put, res } = await uploadCanvas(o, g.id);
    expect(res.upload_url).toContain(`publications/${g.id}/canvas.png`);
    expect(put.status).toBe(200);
    // The workflow keeps waiting: nothing is final until the client confirms the upload.
    expect(sql(`SELECT status FROM publication WHERE id = '${g.id}'`)).toBe('AWAITING_CANVAS');
  });

  it('refuses an upload URL outside AWAITING_CANVAS', async () => {
    const o = owner();
    const g = await publishToGate(o, { test_fail_mode: 'permanent' });
    expect(g.status).toBe('FAILED');
    const res = await call(o, 'POST', `/v1/publications/${g.id}/canvas-upload`, { content_type: 'image/png', size_bytes: 1000 });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'PUBLICATION_STATE', status: 'FAILED' });
  });

  it('validates the request and scopes it to the owner', async () => {
    const o = owner();
    const g = await publishToGate(o);
    const url = `/v1/publications/${g.id}/canvas-upload`;
    expect((await call(o, 'POST', url, { content_type: 'image/gif', size_bytes: 10 })).status).toBe(400);
    expect((await call(o, 'POST', url, { content_type: 'image/png' })).status).toBe(400);
    expect((await call(o, 'POST', url, { content_type: 'image/png', size_bytes: 999999999999 })).status).toBe(400);
    expect((await call(owner(), 'POST', url, { content_type: 'image/png', size_bytes: 10 })).status).toBe(404);
  });
});

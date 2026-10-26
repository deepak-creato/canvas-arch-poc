// Integration test (POC-030): failures, timeouts and retry. Needs the compose stack (make up).
import { StopExecutionCommand } from '@aws-sdk/client-sfn';
import { call, draftWith, executionStatus, json, owner, publish, publishToGate, pubStatus, readyAsset, readyVideo, sfn, sql, startPublication, trail, until, uploadCanvas } from './publish-helpers';

const confirm = (o: string, id: string) => call(o, 'POST', `/v1/publications/${id}/canvas-uploaded`, { content_type: 'image/png' });
const retry = (o: string, id: string) => call(o, 'POST', `/v1/publications/${id}/retry`);
const jobAttempts = (assetId: string) => sql(`SELECT attempts FROM processing_job WHERE asset_id = '${assetId}' AND job_type = 'final-transcode'`);
const finalStatus = (assetId: string) => sql(`SELECT status FROM media_rendition WHERE asset_id = '${assetId}' AND tier = 'FINAL'`);

describe('mock failures, timeouts and retry (POC-030)', () => {
  it('retries a transient transcode error by itself and the publication carries on', async () => {
    const o = owner();
    const g = await publishToGate(o, { test_fail_mode: 'transient:1' });
    expect(g.status).toBe('AWAITING_CANVAS');
    expect(jobAttempts(g.vid)).toBe('2');
    expect(finalStatus(g.vid)).toBe('READY');
  });

  it('a permanent error fails the publication; the retry redoes only the failed final and goes LIVE', async () => {
    const o = owner();
    const img = await readyAsset(o);
    const v1 = await readyVideo(o);
    const v2 = await readyAsset(o, 'sample-long.mp4', 'video/mp4');
    const draft = await draftWith(o, [img, v1, v2]);
    // Only the second video's job is poisoned (the job payload is where the hook is read).
    sql(`INSERT INTO processing_job (job_type, idempotency_key, asset_id, payload) VALUES ('final-transcode', 'transcode:${v2}:final:v1', '${v2}', jsonb_build_object('fail_mode', 'permanent'))`);

    const pub = await json(await publish(o, draft, 'retry-key'));
    expect(await until(() => pubStatus(pub.publication_id), (s) => s === 'FAILED')).toBe('FAILED');
    expect(sql(`SELECT failure_reason FROM publication WHERE id = '${pub.publication_id}'`)).toMatch(/^TranscodeFailed/);
    expect(await until(() => finalStatus(v1), (s) => s === 'READY')).toBe('READY'); // finished on its own
    expect(finalStatus(v2)).toBe('FAILED_PERMANENT');
    // The draft stays frozen while the publication can be retried.
    expect(sql(`SELECT status FROM canvas_draft WHERE id = '${draft}'`)).toBe('PUBLISHING');
    const status = await json(await call(o, 'GET', `/v1/drafts/${draft}/status`));
    expect(status).toMatchObject({ draft_status: 'PUBLISHING', assets_status: 'READY', can_publish: false, can_retry_publication: true });
    expect(status.publication).toMatchObject({ publication_id: pub.publication_id, status: 'FAILED', attempt: 1 });
    expect(status.assets.find((a: any) => a.asset_id === v2).final_status).toBe('FAILED_PERMANENT');

    // The cause is fixed (poison removed); retry the same publication.
    sql(`UPDATE processing_job SET payload = jsonb_build_object() WHERE asset_id = '${v2}' AND job_type = 'final-transcode'`);
    const attemptsV1 = jobAttempts(v1);
    const res = await retry(o, pub.publication_id);
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ publication_id: pub.publication_id, status: 'REQUESTED', attempt: 2, failure_reason: null });
    expect(await until(() => pubStatus(pub.publication_id), (s) => s === 'AWAITING_CANVAS' || s === 'FAILED')).toBe('AWAITING_CANVAS');

    // v1's READY output was reused; only v2 was produced again. Still one publication for the draft.
    expect(jobAttempts(v1)).toBe(attemptsV1);
    expect(finalStatus(v2)).toBe('READY');
    expect(sql(`SELECT count(*) FROM publication WHERE draft_id = '${draft}'`)).toBe('1');
    expect(trail(pub.publication_id).filter((s) => s === 'REQUESTED')).toHaveLength(2);

    await uploadCanvas(o, pub.publication_id);
    expect((await confirm(o, pub.publication_id)).status).toBe(202);
    expect(await until(() => pubStatus(pub.publication_id), (s) => s === 'LIVE' || s === 'FAILED')).toBe('LIVE');
    expect(sql(`SELECT count(*) FROM publication_asset WHERE publication_id = '${pub.publication_id}'`)).toBe('2');
    expect(sql(`SELECT count(*) FROM media_reference WHERE publication_id = '${pub.publication_id}'`)).toBe('3');
    expect(sql(`SELECT status FROM canvas_draft WHERE id = '${draft}'`)).toBe('PUBLISHED');
    expect((await json(await call(o, 'GET', `/v1/drafts/${draft}/status`))).publication).toMatchObject({ status: 'LIVE', attempt: 2 });
  });

  it('a canvas that never arrives times the wait out; retry reopens the gate on the same publication', async () => {
    const o = owner();
    const vid = await readyVideo(o);
    const draft = await draftWith(o, [vid]);
    const { id, arn } = await startPublication(o, draft, { canvasTimeout: 3 });
    expect(await until(() => pubStatus(id), (s) => s === 'FAILED')).toBe('FAILED');
    expect(sql(`SELECT failure_reason FROM publication WHERE id = '${id}'`)).toMatch(/Timeout/);
    expect(await until(() => executionStatus(arn), (s) => s !== 'RUNNING')).toBe('FAILED');
    expect(sql(`SELECT task_token IS NULL FROM publication WHERE id = '${id}'`)).toBe('t');
    // A late confirmation cannot revive it.
    expect((await confirm(o, id)).status).toBe(409);

    const res = await retry(o, id);
    expect(res.status).toBe(202);
    expect(await until(() => pubStatus(id), (s) => s === 'AWAITING_CANVAS' || s === 'FAILED')).toBe('AWAITING_CANVAS');
    await uploadCanvas(o, id);
    expect((await confirm(o, id)).status).toBe(202);
    expect(await until(() => pubStatus(id), (s) => s === 'LIVE' || s === 'FAILED')).toBe('LIVE');
    expect(sql(`SELECT attempt FROM publication WHERE id = '${id}'`)).toBe('2');
  });

  it('recovers a publication whose execution died without reporting', async () => {
    const o = owner();
    const g = await publishToGate(o);
    expect(g.status).toBe('AWAITING_CANVAS');
    // Running workflow: refuse to start a second one.
    const busy = await retry(o, g.id);
    expect(busy.status).toBe(409);
    expect((await json(busy)).code).toBe('PUBLICATION_IN_PROGRESS');

    await sfn.send(new StopExecutionCommand({ executionArn: sql(`SELECT execution_arn FROM publication WHERE id = '${g.id}'`), error: 'Test', cause: 'lost' }));
    const res = await retry(o, g.id);
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ publication_id: g.id, attempt: 2 });
    expect(sql(`SELECT detail->>'previous' FROM publication_transition WHERE publication_id = '${g.id}' AND step = 'RETRY'`)).toBe('EXECUTION_ABORTED');
    expect(await until(() => pubStatus(g.id), (s) => s === 'AWAITING_CANVAS')).toBe('AWAITING_CANVAS');
    // Double click: the second retry finds a running workflow.
    expect((await retry(o, g.id)).status).toBe(409);
  });

  it('only the owner can retry, LIVE and exhausted publications cannot', async () => {
    const o = owner();
    const g = await publishToGate(o, { test_fail_mode: 'permanent' });
    expect(g.status).toBe('FAILED');
    expect((await retry(owner(), g.id)).status).toBe(404);
    sql(`UPDATE publication SET attempt = 5 WHERE id = '${g.id}'`);
    const res = await retry(o, g.id);
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('RETRIES_EXHAUSTED');
    sql(`UPDATE publication SET status = 'LIVE' WHERE id = '${g.id}'`);
    expect((await json(await retry(o, g.id))).code).toBe('PUBLICATION_STATE');
  });

  it('draft status before any publication', async () => {
    const o = owner();
    const img = await readyAsset(o);
    const draft = await draftWith(o, [img]);
    expect(await json(await call(o, 'GET', `/v1/drafts/${draft}/status`))).toMatchObject({
      draft_status: 'ACTIVE',
      assets_status: 'READY',
      publication: null,
      can_publish: true,
      can_retry_publication: false,
    });
    expect((await call(owner(), 'GET', `/v1/drafts/${draft}/status`)).status).toBe(404);
  });
});

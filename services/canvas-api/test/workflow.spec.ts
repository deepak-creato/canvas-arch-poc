// Integration test (POC-025): drives the publish state machine directly, without the publish API.
import { GetExecutionHistoryCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { randomUUID } from 'crypto';
import { config } from '../../shared/config';
import { draftWith, executionStatus, owner, pubStatus, readyAsset, readyVideo, sfn, sql, trail, until } from './publish-helpers';

/** What POST /v1/drafts/{id}/publications will do in POC-026, minus the API. */
async function startPublication(o: string, draftId: string, failMode?: string) {
  const rev = sql(`SELECT id FROM canvas_revision WHERE draft_id = '${draftId}' AND revision_no = 1`);
  const id = randomUUID();
  sql(
    `INSERT INTO publication (id, draft_id, revision_id, owner_id, idempotency_key, test_fail_mode)
     VALUES ('${id}', '${draftId}', '${rev}', '${o}', '${randomUUID()}', ${failMode ? `'${failMode}'` : 'NULL'})`,
  );
  const out = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: config.publishStateMachineArn,
      name: `${id}-a1`,
      input: JSON.stringify({
        publication_id: id,
        attempt: 1,
        validation: { iteration: 0 },
        wait_seconds: 1,
        canvas_timeout_seconds: 60,
        transcode_timeout_seconds: 60,
      }),
    }),
  );
  return { id, arn: out.executionArn! };
}

const finalStatus = (assetId: string) => sql(`SELECT status FROM media_rendition WHERE asset_id = '${assetId}' AND tier = 'FINAL'`);
const transcodeJobs = (assetId: string) => sql(`SELECT count(*) || '|' || coalesce(max(attempts), 0) FROM processing_job WHERE asset_id = '${assetId}' AND job_type = 'final-transcode'`);

async function stateTrail(arn: string): Promise<string[]> {
  const h = await sfn.send(new GetExecutionHistoryCommand({ executionArn: arn, maxResults: 200 }));
  return (h.events ?? []).filter((e) => e.type?.endsWith('StateEntered')).map((e) => e.stateEnteredEventDetails!.name!);
}

describe('publish workflow (POC-025)', () => {
  it('validates, produces finals and stops at the canvas gate', async () => {
    const o = owner('wf');
    const img = await readyAsset(o);
    const vid = await readyVideo(o);
    const draft = await draftWith(o, [img, vid]);
    const { id, arn } = await startPublication(o, draft);

    // No Lambda in LocalStack: every step goes through the queue and the step runner.
    expect(await until(() => pubStatus(id), (s) => s === 'AWAITING_CANVAS')).toBe('AWAITING_CANVAS');
    expect(await finalStatus(vid)).toBe('READY');
    expect(await finalStatus(img)).toBe(''); // images have no final tier
    expect(trail(id)).toEqual(['WAITING_FOR_ASSETS', 'TRANSCODING', 'AWAITING_CANVAS']);

    expect(await executionStatus(arn)).toBe('RUNNING');
    const states = await stateTrail(arn);
    expect(states).toEqual(['ValidateSnapshot', 'AssetsReady', 'PlanFinals', 'Transcode', 'MockTranscode', 'MarkFinalsReady', 'AwaitCanvas']);
  });

  it('runs no mock job when the final output is already READY', async () => {
    const o = owner('wf');
    const vid = await readyVideo(o);
    const first = await startPublication(o, await draftWith(o, [vid]));
    await until(() => pubStatus(first.id), (s) => s === 'AWAITING_CANVAS');
    expect(await finalStatus(vid)).toBe('READY');
    expect(transcodeJobs(vid)).toBe('1|1');

    const second = await startPublication(o, await draftWith(o, [vid]));
    await until(() => pubStatus(second.id), (s) => s === 'AWAITING_CANVAS');
    expect(transcodeJobs(vid)).toBe('1|1');
    expect(trail(second.id)).toEqual(['WAITING_FOR_ASSETS', 'TRANSCODING', 'AWAITING_CANVAS']);
  });

  it('fails the publication with a reason when a final cannot be produced', async () => {
    const o = owner('wf');
    const vid = await readyVideo(o);
    const { id } = await startPublication(o, await draftWith(o, [vid]), 'permanent');
    expect(await until(() => pubStatus(id), (s) => s === 'FAILED')).toBe('FAILED');
    expect(await finalStatus(vid)).toBe('FAILED_PERMANENT');
    expect(sql(`SELECT failure_reason FROM publication WHERE id = '${id}'`)).toMatch(/^TranscodeFailed/);
  });

  it('fails when an asset can never be used', async () => {
    const o = owner('wf');
    const img = await readyAsset(o);
    const draft = await draftWith(o, [img]);
    sql(`UPDATE media_asset SET retention_status = 'DELETED' WHERE id = '${img}'`);
    const { id } = await startPublication(o, draft);
    expect(await until(() => pubStatus(id), (s) => s === 'FAILED')).toBe('FAILED');
    expect(sql(`SELECT failure_reason FROM publication WHERE id = '${id}'`)).toMatch(/^ASSET_UNUSABLE/);
  });
});

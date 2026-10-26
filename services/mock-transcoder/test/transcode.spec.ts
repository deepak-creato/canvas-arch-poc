// Integration test: needs the compose stack (make up) with mock-transcoder running.
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { execSync } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { statSync } from 'fs';
import { resolve } from 'path';
import { config } from '../../shared/config';
import { finalVideoKey, FINAL_VIDEO } from '../../shared/keys';
import { createS3 } from '../../shared/s3';
import { createSqs } from '../../shared/sqs';

const COMPOSE = resolve(__dirname, '../../../docker-compose.yml');
const FIXTURE = resolve(__dirname, '../../../fixtures/sample.mp4');
const TRANSCODER = process.env.TRANSCODER_URL ?? 'http://127.0.0.1:3103';
const sql = (q: string) => execSync(`docker compose -f ${COMPOSE} exec -T postgres psql -U canvas -tA -c "${q}"`).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const s3 = createS3();
const sqs = createSqs();

/** A VALIDATED video asset row and its FINAL rendition row, as PlanFinals will create them. */
function seedAsset() {
  const id = randomUUID();
  const rid = randomUUID();
  const sha = randomBytes(32).toString('hex');
  sql(
    `INSERT INTO media_asset (id, owner_id, kind, client_sha256, content_type, original_bucket, original_key, upload_status)
     VALUES ('${id}', 'tc-test', 'VIDEO', '${sha}', 'video/mp4', '${config.bucketIngest}', 'staging/tc-test/${id}/source', 'VALIDATED')`,
  );
  sql(
    `INSERT INTO media_rendition (id, asset_id, kind, tier, recipe_version, params_hash, bucket, s3_key, status)
     VALUES ('${rid}', '${id}', '${FINAL_VIDEO.kind}', 'FINAL', ${FINAL_VIDEO.version}, '${FINAL_VIDEO.paramsHash}', '${config.bucketDerived}', '${finalVideoKey(id)}', 'QUEUED')`,
  );
  return { assetId: id, renditionId: rid, key: finalVideoKey(id) };
}

// The token is fake: answering it fails with an invalid-token error, which the worker logs and drops.
const request = (a: { assetId: string; renditionId: string }, extra: Record<string, unknown> = {}) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: config.queueTranscodeUrl,
      MessageBody: JSON.stringify({ publication_id: randomUUID(), asset_id: a.assetId, rendition_id: a.renditionId, token: `fake-${randomUUID()}`, ...extra }),
    }),
  );

async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 45000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(500);
    v = await fn();
  }
  return v;
}
const renditionStatus = (id: string) => sql(`SELECT status FROM media_rendition WHERE id = '${id}'`);
const job = (assetId: string) => sql(`SELECT status || '|' || attempts FROM processing_job WHERE asset_id = '${assetId}' AND job_type = 'final-transcode'`);
const mock = async (assetId: string) => (await (await fetch(`${TRANSCODER}/jobs?asset_id=${assetId}`)).json()) as any;

describe('mock transcoder (POC-023)', () => {
  it('places the fixture at the requested key and reports COMPLETE', async () => {
    const a = seedAsset();
    await request(a);
    expect(await until(() => renditionStatus(a.renditionId), (s) => s === 'READY')).toBe('READY');
    expect(job(a.assetId)).toBe('SUCCEEDED|1');
    expect((await mock(a.assetId)).state).toBe('COMPLETE');

    const head = await s3.send(new HeadObjectCommand({ Bucket: config.bucketDerived, Key: a.key }));
    expect(head.ContentLength).toBe(statSync(FIXTURE).size);
    expect(head.ContentType).toBe('video/mp4');
    const body = await s3.send(new GetObjectCommand({ Bucket: config.bucketDerived, Key: a.key, Range: 'bytes=4-7' }));
    expect(Buffer.from(await body.Body!.transformToByteArray()).toString()).toBe('ftyp'); // MP4 signature
  });

  it('runs the mock job once: a second request for a finished output does no work', async () => {
    const a = seedAsset();
    await request(a);
    await until(() => renditionStatus(a.renditionId), (s) => s === 'READY');
    await request(a);
    await sleep(3000);
    expect(job(a.assetId)).toBe('SUCCEEDED|1');
    expect(sql(`SELECT count(*) FROM processing_job WHERE asset_id = '${a.assetId}'`)).toBe('1');
  });

  it('retries a transient failure and then completes', async () => {
    const a = seedAsset();
    await request(a, { fail_mode: 'transient:1' });
    expect(await until(() => renditionStatus(a.renditionId), (s) => s === 'READY')).toBe('READY');
    expect(job(a.assetId)).toBe('SUCCEEDED|2');
  });

  it('a permanent failure ends in ERROR and the rendition is FAILED_PERMANENT', async () => {
    const a = seedAsset();
    await request(a, { fail_mode: 'permanent' });
    expect(await until(() => renditionStatus(a.renditionId), (s) => s === 'FAILED_PERMANENT')).toBe('FAILED_PERMANENT');
    expect(job(a.assetId)).toBe('FAILED_PERMANENT|1');
    expect((await mock(a.assetId)).state).toBe('ERROR');
  });

  it('answers 404 for an unknown job', async () => {
    expect((await fetch(`${TRANSCODER}/jobs?asset_id=${randomUUID()}`)).status).toBe(404);
  });
});

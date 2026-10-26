// Integration test: needs the compose stack (make up) with light-worker running (WORKER_TEST_HOOKS=true).
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { execSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Pool } from 'pg';
import { claimJob, withHeartbeat } from '../../shared/job-repo';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const COMPOSE = resolve(__dirname, '../../../docker-compose.yml');
const FIX = resolve(__dirname, '../../../fixtures');
const Q = 'http://127.0.0.1:4566/000000000000/light-processing';
const DLQ = 'http://127.0.0.1:4566/000000000000/light-processing-dlq';
const sqs = new SQSClient({ region: 'us-east-1', endpoint: 'http://127.0.0.1:4566', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });

const sql = (q: string) =>
  execSync(`docker compose -f ${COMPOSE} exec -T postgres psql -U canvas -tA -c "${q}"`).toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(500);
  }
  return false;
}

/** Reserves an upload (no PUT yet) so a test can prepare job rows before the worker sees the object. */
async function reserve(name = 'sample-1.png', ct = 'image/png') {
  const bytes = readFileSync(`${FIX}/${name}`);
  const res: any = await (
    await fetch(`${API}/v1/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owner-id': `j-${randomBytes(4).toString('hex')}` },
      body: JSON.stringify({ sha256: createHash('sha256').update(bytes).digest('hex'), content_type: ct, size_bytes: bytes.length }),
    })
  ).json();
  const put = () => fetch(res.upload_url, { method: 'PUT', headers: res.upload_headers, body: new Uint8Array(bytes) });
  return { id: res.asset_id as string, put };
}

const event = (key: string) =>
  JSON.stringify({ 'detail-type': 'Object Created', detail: { bucket: { name: 'media-ingest-poc' }, object: { key } } });
const job = (id: string, type: string, col = "status||':'||attempts") =>
  sql(`select ${col} from processing_job where asset_id='${id}' and job_type='${type}'`);
const renditionStatuses = (id: string) =>
  sql(`select string_agg(status, ',' order by kind) from media_rendition where asset_id='${id}'`);

async function inDlq(marker: string, ms = 60000) {
  let found = false;
  await waitFor(async () => {
    const out = await sqs.send(new ReceiveMessageCommand({ QueueUrl: DLQ, MaxNumberOfMessages: 10, VisibilityTimeout: 1, WaitTimeSeconds: 1 }));
    for (const m of out.Messages ?? []) {
      if (m.Body!.includes(marker)) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: DLQ, ReceiptHandle: m.ReceiptHandle! }));
        found = true;
      }
    }
    return found;
  }, ms);
  return found;
}

describe('retries', () => {
  it('transient failures are retried with backoff and then succeed', async () => {
    const a = await reserve();
    sql(`insert into processing_job (job_type, idempotency_key, asset_id, payload) values ('image-derive','derive:${a.id}:image:v1','${a.id}', jsonb_build_object('fail_mode','transient:2'))`);
    await a.put();
    expect(await waitFor(() => renditionStatuses(a.id) === 'READY,READY')).toBe(true);
    expect(job(a.id, 'image-derive')).toBe('SUCCEEDED:3');
    expect(job(a.id, 'image-derive', 'coalesce(last_error,\'\')')).toBe('');
  });

  it('a job that keeps failing ends FAILED_PERMANENT and its message reaches the DLQ', async () => {
    const a = await reserve();
    sql(`insert into processing_job (job_type, idempotency_key, asset_id, payload) values ('image-derive','derive:${a.id}:image:v1','${a.id}', jsonb_build_object('fail_mode','transient:99'))`);
    await a.put();
    expect(await waitFor(() => job(a.id, 'image-derive') === 'FAILED_PERMANENT:3')).toBe(true);
    expect(renditionStatuses(a.id)).toBe('FAILED_PERMANENT,FAILED_PERMANENT');
    expect(job(a.id, 'validate')).toBe('SUCCEEDED:1'); // earlier step is unaffected
    expect(sql(`select upload_status from media_asset where id='${a.id}'`)).toBe('VALIDATED');
    const key = sql(`select original_key from media_asset where id='${a.id}'`);
    expect(await inDlq(key)).toBe(true);
  });

  it('a permanent error fails after one attempt and reaches the DLQ', async () => {
    const a = await reserve();
    sql(`insert into processing_job (job_type, idempotency_key, asset_id, payload) values ('image-derive','derive:${a.id}:image:v1','${a.id}', jsonb_build_object('fail_mode','permanent'))`);
    await a.put();
    expect(await waitFor(() => job(a.id, 'image-derive') === 'FAILED_PERMANENT:1')).toBe(true);
    expect(job(a.id, 'image-derive', 'last_error')).toContain('injected permanent failure');
    expect(await inDlq(sql(`select original_key from media_asset where id='${a.id}'`))).toBe(true);
  });

  it('an unparseable message is retried and then moved to the DLQ', async () => {
    const marker = `poison-${randomBytes(4).toString('hex')}`;
    await sqs.send(new SendMessageCommand({ QueueUrl: Q, MessageBody: marker }));
    expect(await inDlq(marker)).toBe(true);
  });
});

describe('leases', () => {
  it('takes over a job whose lease expired (crashed worker)', async () => {
    const a = await reserve();
    sql(`insert into processing_job (job_type, idempotency_key, asset_id, status, attempts, lease_owner, lease_expires_at) values ('validate','validate:${a.id}','${a.id}','RUNNING',1,'dead-worker', now() - interval '1 minute')`);
    await a.put();
    expect(await waitFor(() => sql(`select upload_status from media_asset where id='${a.id}'`) === 'VALIDATED')).toBe(true);
    expect(job(a.id, 'validate')).toBe('SUCCEEDED:2');
  });

  it('leaves a job with a live lease alone until it expires', async () => {
    const a = await reserve();
    sql(`insert into processing_job (job_type, idempotency_key, asset_id, status, attempts, lease_owner, lease_expires_at) values ('validate','validate:${a.id}','${a.id}','RUNNING',1,'other-worker', now() + interval '8 seconds')`);
    const t0 = Date.now();
    await a.put();
    expect(await waitFor(() => sql(`select upload_status from media_asset where id='${a.id}'`) === 'VALIDATED')).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(6000);
    expect(job(a.id, 'validate')).toBe('SUCCEEDED:2');
  });

  it('the heartbeat keeps a lease alive past its first expiry', async () => {
    const pool = new Pool({ connectionString: 'postgres://canvas:canvas@127.0.0.1:5433/canvas' });
    const key = `hb-${randomBytes(4).toString('hex')}`;
    try {
      await pool.query(`insert into processing_job (job_type, idempotency_key) values ('test', $1)`, [key]);
      const c = await claimJob(pool, key, 'w1', 3);
      if (!c.claimed) throw new Error('claim failed');
      await withHeartbeat(pool, c.job.id, 'w1', 3, async () => {
        await sleep(5500); // longer than the 3s lease
        expect(await claimJob(pool, key, 'w2', 3)).toEqual({ claimed: false, reason: 'busy' });
      });
      await sleep(3500); // heartbeat stopped: lease runs out
      expect((await claimJob(pool, key, 'w2', 3)).claimed).toBe(true);
    } finally {
      await pool.query(`delete from processing_job where idempotency_key = $1`, [key]);
      await pool.end();
    }
  });
});

describe('duplicates', () => {
  it('a burst of identical events processes each job exactly once', async () => {
    const a = await reserve('sample-2.jpg', 'image/jpeg');
    await a.put();
    const key = sql(`select original_key from media_asset where id='${a.id}'`);
    await Promise.all(Array.from({ length: 6 }, () => sqs.send(new SendMessageCommand({ QueueUrl: Q, MessageBody: event(key) }))));
    expect(await waitFor(() => renditionStatuses(a.id) === 'READY,READY')).toBe(true);
    await sleep(4000);
    expect(sql(`select string_agg(job_type||':'||status||':'||attempts, ',' order by job_type) from processing_job where asset_id='${a.id}'`)).toBe('image-derive:SUCCEEDED:1,validate:SUCCEEDED:1');
    expect(sql(`select count(*) from media_rendition where asset_id='${a.id}'`)).toBe('2');
  });
});

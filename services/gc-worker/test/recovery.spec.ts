import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { config } from '../../shared/config';
import { createSqs } from '../../shared/sqs';
import { inspectDlq, redriveDlq } from '../src/dlq';
import { listProblemJobs, reapStuckJobs, requeueJobs, syntheticObjectCreated } from '../src/jobs';
import { asset, newOwner, opts, pool, seedAsset, seedUploadedFixture } from './helpers';

const sqs = createSqs();
afterAll(() => pool.end());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 45000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(500);
    v = await fn();
  }
  return v;
}
const uploadStatus = async (id: string) => (await asset(id)).upload_status;
const jobRow = async (id: string, type = 'validate') =>
  (await pool.query(`SELECT id, status, attempts, last_error FROM processing_job WHERE asset_id = $1 AND job_type = $2`, [id, type])).rows[0];
const insertJob = (assetId: string, status: string, o: { attempts?: number; lease?: string; updated?: string; error?: string } = {}) =>
  pool.query(
    `INSERT INTO processing_job (job_type, idempotency_key, asset_id, status, attempts, lease_expires_at, last_error, updated_at, payload)
     VALUES ('validate', $1, $2, $3, $4, ${o.lease ?? 'NULL'}, $5, ${o.updated ?? 'now()'}, '{}')`,
    [`validate:${assetId}`, assetId, status, o.attempts ?? 1, o.error ?? null],
  );

describe('lease timeout (POC-035)', () => {
  it('reaps a dead worker: retryable job becomes FAILED, exhausted one FAILED_PERMANENT, live lease untouched', async () => {
    const owner = newOwner();
    const dead = await seedAsset({ owner });
    const exhausted = await seedAsset({ owner });
    const alive = await seedAsset({ owner });
    await insertJob(dead.id, 'RUNNING', { attempts: 1, lease: "now() - interval '1 minute'" });
    await insertJob(exhausted.id, 'RUNNING', { attempts: 3, lease: "now() - interval '1 minute'" });
    await insertJob(alive.id, 'RUNNING', { attempts: 1, lease: "now() + interval '1 minute'" });

    const reaped = await reapStuckJobs(pool, opts(owner));
    expect(reaped).toHaveLength(2);
    expect(await jobRow(dead.id)).toMatchObject({ status: 'FAILED', last_error: 'LEASE_EXPIRED' });
    expect(await jobRow(exhausted.id)).toMatchObject({ status: 'FAILED_PERMANENT', last_error: 'LEASE_EXPIRED' });
    expect(await jobRow(alive.id)).toMatchObject({ status: 'RUNNING' });
  });

  it('a stuck job is diagnosable, then recovered end to end by the real light-worker', async () => {
    const owner = newOwner();
    const a = await seedUploadedFixture(owner);
    // The worker died mid-validate and its queue message is gone.
    await insertJob(a.id, 'RUNNING', { attempts: 1, lease: "now() - interval '1 minute'" });

    const seen = await listProblemJobs(pool, opts(owner));
    expect(seen).toMatchObject([{ asset_id: a.id, job_type: 'validate', problem: 'LEASE_EXPIRED', attempts: 1 }]);

    await reapStuckJobs(pool, opts(owner));
    expect(await requeueJobs(pool, sqs, opts(owner, { jobStaleSeconds: 3600 }))).toEqual([]); // not quiet long enough
    const sent = await requeueJobs(pool, sqs, opts(owner, { jobStaleSeconds: 0 }));
    expect(sent).toHaveLength(1);

    expect(await until(() => uploadStatus(a.id), (s) => s === 'VALIDATED')).toBe('VALIDATED');
    expect((await jobRow(a.id)).status).toBe('SUCCEEDED');
    expect(await listProblemJobs(pool, opts(owner))).toEqual([]);
  });

  it('does not requeue work for assets GC may delete', async () => {
    const owner = newOwner();
    const a = await seedUploadedFixture(owner);
    await pool.query(`UPDATE media_asset SET retention_status = 'ORPHANED', orphaned_at = now() WHERE id = $1`, [a.id]);
    await insertJob(a.id, 'QUEUED', { attempts: 0 });
    expect(await requeueJobs(pool, sqs, opts(owner, { jobStaleSeconds: 0 }))).toEqual([]);
  });
});

describe('DLQ diagnosis and redrive (POC-035)', () => {
  it('shows why a message is dead, then redrive gives the job a fresh start', async () => {
    const owner = newOwner();
    const a = await seedUploadedFixture(owner);
    await insertJob(a.id, 'FAILED_PERMANENT', { attempts: 3, error: 'injected permanent failure' });
    await sqs.send(new SendMessageCommand({ QueueUrl: config.queueLightProcessingDlqUrl, MessageBody: syntheticObjectCreated(config.bucketIngest, a.key) }));

    const report = await until(() => inspectDlq(pool, sqs, { ownerId: owner }), (r) => r.messages.length > 0, 10000);
    expect(report.depth).toBeGreaterThanOrEqual(1);
    expect(report.messages).toHaveLength(1);
    expect(report.messages[0]).toMatchObject({
      asset_id: a.id,
      upload_status: 'UPLOADED',
      jobs: [{ job_type: 'validate', status: 'FAILED_PERMANENT', attempts: 3, last_error: 'injected permanent failure' }],
    });
    // Inspecting does not consume.
    expect((await inspectDlq(pool, sqs, { ownerId: owner })).messages).toHaveLength(1);
    expect(await listProblemJobs(pool, opts(owner))).toMatchObject([{ problem: 'FAILED_PERMANENT' }]);

    const r = await redriveDlq(pool, sqs, { ownerId: owner });
    expect(r.moved).toHaveLength(1);
    expect(r.reset_jobs).toHaveLength(1);
    expect(await until(() => uploadStatus(a.id), (s) => s === 'VALIDATED')).toBe('VALIDATED');
    expect((await jobRow(a.id)).status).toBe('SUCCEEDED');
    expect((await inspectDlq(pool, sqs, { ownerId: owner })).messages).toEqual([]);
  });

  it('drops DLQ messages of deleted assets instead of reviving them, and keeps unknown ones', async () => {
    const owner = newOwner();
    const gone = await seedAsset({ owner, retention_status: 'DELETED' });
    await sqs.send(new SendMessageCommand({ QueueUrl: config.queueLightProcessingDlqUrl, MessageBody: syntheticObjectCreated(config.bucketIngest, gone.key) }));
    const r = await until(() => redriveDlq(pool, sqs, { ownerId: owner }), (x) => x.dropped.length > 0, 10000);
    expect(r.dropped).toHaveLength(1);
    expect(r.moved).toEqual([]);
    expect(await jobRow(gone.id)).toBeUndefined();
  });
});

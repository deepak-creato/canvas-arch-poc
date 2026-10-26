import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SFNClient } from '@aws-sdk/client-sfn';
import { readFile } from 'fs/promises';
import { Pool } from 'pg';
import { config } from '../../shared/config';
import { claimJob, failJob, PermanentError, succeedJob, withHeartbeat } from '../../shared/job-repo';
import { ensureJob } from '../../shared/jobs';
import { transcodeJobKey } from '../../shared/keys';
import { log } from '../../shared/log';
import { answerTask } from '../../shared/sfn';

/**
 * Mock transcode contract. Request (SQS body):
 *   { publication_id, asset_id, rendition_id, token, fail_mode? }
 * `token` is the Step Functions task token. The answer is SendTaskSuccess with
 *   { state: 'COMPLETE', asset_id, rendition_id, bucket, key }
 * or SendTaskFailure with error `TranscodeFailed` (mock state ERROR).
 *
 * Mock job states map onto processing_job: QUEUED, RUNNING, COMPLETE (SUCCEEDED), ERROR (FAILED, FAILED_PERMANENT).
 * This service does not transcode. It places a valid fixture at the requested output key.
 */
export interface TranscodeRequest {
  publication_id: string;
  asset_id: string;
  rendition_id: string;
  token: string;
  fail_mode?: string;
}

export type MockState = 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'ERROR';
export const mockState = (jobStatus: string): MockState =>
  jobStatus === 'RUNNING' ? 'RUNNING' : jobStatus === 'SUCCEEDED' ? 'COMPLETE' : jobStatus.startsWith('FAILED') ? 'ERROR' : 'QUEUED';

// ack: delete the message. retry: leave it for SQS redelivery.
export type Outcome = 'ack' | 'retry';

const WORKER_ID = `mock-transcoder-${process.pid}`;
const LEASE_SECONDS = 30;
const isNotFound = (e: any) => e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parseRequest(body: string): TranscodeRequest | null {
  try {
    const r = JSON.parse(body);
    if (r && ['publication_id', 'asset_id', 'rendition_id', 'token'].every((k) => typeof r[k] === 'string')) return r;
  } catch {
    /* fall through */
  }
  return null;
}

/** Test hook, same modes as the light-worker: "transient:N" or "permanent" (WORKER_TEST_HOOKS=true only). */
function injectFailure(attempts: number, mode: unknown) {
  if (process.env.WORKER_TEST_HOOKS !== 'true' || typeof mode !== 'string') return;
  if (mode === 'permanent') throw new PermanentError('injected permanent failure');
  const m = /^transient:(\d+)$/.exec(mode);
  if (m && attempts <= Number(m[1])) throw new Error(`injected transient failure (attempt ${attempts})`);
}

export async function handleMessage(pool: Pool, s3: S3Client, sfn: SFNClient, body: string, messageId: string): Promise<Outcome> {
  const req = parseRequest(body);
  if (!req) {
    // Cannot answer anything without a token; let the message reach the DLQ.
    log('error', 'unparseable transcode request, leaving for DLQ', { correlation_id: messageId });
    return 'retry';
  }
  const base = { asset_id: req.asset_id, publication_id: req.publication_id, correlation_id: messageId };

  const rendition = (
    await pool.query<{ id: string; bucket: string; s3_key: string; status: string }>(
      `SELECT id, bucket, s3_key, status FROM media_rendition WHERE id = $1 AND asset_id = $2 AND tier = 'FINAL'`,
      [req.rendition_id, req.asset_id],
    )
  ).rows[0];
  if (!rendition) {
    await answerTask(sfn, req.token, { ok: false, error: 'TranscodeFailed', cause: 'final rendition row not found' }, base);
    log('error', 'final rendition not found', base);
    return 'ack';
  }

  const key = transcodeJobKey(req.asset_id);
  await ensureJob(pool, { type: 'final-transcode', key, assetId: req.asset_id, payload: { rendition_id: rendition.id, fail_mode: req.fail_mode } });
  const claim = await claimJob(pool, key, WORKER_ID, LEASE_SECONDS);

  if (!claim.claimed) {
    if (claim.reason === 'busy') return 'retry';
    if (claim.reason === 'done') {
      // An earlier publication (or an earlier delivery) already produced the output: answer without work.
      const sent = await answerTask(sfn, req.token, { ok: true, output: complete(req, rendition) }, base);
      log('info', 'final already complete, no mock job run', { ...base, answered: sent });
      return 'ack';
    }
    await answerTask(sfn, req.token, { ok: false, error: 'TranscodeFailed', cause: 'job failed permanently' }, base);
    return 'ack';
  }

  const ctx = { ...base, job_id: claim.job.id };
  try {
    await withHeartbeat(pool, claim.job.id, WORKER_ID, LEASE_SECONDS, async () => {
      await pool.query(`UPDATE media_rendition SET status = 'PROCESSING', error = NULL WHERE id = $1`, [rendition.id]);
      await sleep(config.transcodeLatencyMs);
      injectFailure(claim.job.attempts, claim.job.payload?.fail_mode);
      // HEAD before work: a previous attempt may have placed the object and died before updating the row.
      if (!(await exists(s3, rendition.bucket, rendition.s3_key))) {
        const fixture = await readFile(config.transcodeFixturePath);
        await s3.send(new PutObjectCommand({ Bucket: rendition.bucket, Key: rendition.s3_key, Body: fixture, ContentType: 'video/mp4' }));
      }
      await pool.query(
        `UPDATE media_rendition SET status = 'READY', error = NULL, metadata = metadata || $2::jsonb WHERE id = $1`,
        [rendition.id, JSON.stringify({ content_type: 'video/mp4', mock: true })],
      );
    });
    await succeedJob(pool, claim.job.id);
    log('info', 'mock transcode complete', ctx);
  } catch (e) {
    const permanent = await failJob(pool, claim.job, String(e), e instanceof PermanentError);
    await pool.query(`UPDATE media_rendition SET status = $2, error = $3 WHERE id = $1`, [
      rendition.id,
      permanent ? 'FAILED_PERMANENT' : 'FAILED',
      String(e).slice(0, 1000),
    ]);
    if (!permanent) {
      log('warn', 'mock transcode failed, will retry', { ...ctx, attempts: claim.job.attempts, error: String(e) });
      return 'retry';
    }
    log('error', 'mock transcode failed permanently', { ...ctx, error: String(e) });
    await answerTask(sfn, req.token, { ok: false, error: 'TranscodeFailed', cause: String(e) }, ctx);
    return 'ack';
  }

  await answerTask(sfn, req.token, { ok: true, output: complete(req, rendition) }, ctx);
  return 'ack';
}

const complete = (req: TranscodeRequest, r: { id: string; bucket: string; s3_key: string }) => ({
  state: 'COMPLETE' as MockState,
  asset_id: req.asset_id,
  rendition_id: r.id,
  bucket: r.bucket,
  key: r.s3_key,
});

async function exists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

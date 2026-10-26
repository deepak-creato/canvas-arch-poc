import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { config } from '../../shared/config';
import { log } from '../../shared/log';
import { GcOptions } from './options';

// Jobs that the light-worker runs from S3 "Object Created" events. final-transcode jobs are not
// here: their messages carry Step Functions task tokens, so POST /v1/publications/{id}/retry owns them.
export const LIGHT_JOB_TYPES = ['validate', 'image-derive', 'video-derive'];

/** The event the S3 -> EventBridge -> SQS rule would have delivered for this object. */
export const syntheticObjectCreated = (bucket: string, key: string) =>
  JSON.stringify({ 'detail-type': 'Object Created', source: 'gc-worker', detail: { bucket: { name: bucket }, object: { key } } });

/**
 * RUNNING with an expired lease means the worker died. Mark the attempt failed so the job is
 * retryable at once (FAILED), or FAILED_PERMANENT when attempts are used up. A live worker that
 * is merely slow keeps its lease through the heartbeat and is never touched.
 */
export async function reapStuckJobs(pool: Pool, o: GcOptions): Promise<string[]> {
  const r = await pool.query<{ id: string; asset_id: string | null; status: string }>(
    `UPDATE processing_job j
        SET status = CASE WHEN attempts >= max_attempts THEN 'FAILED_PERMANENT' ELSE 'FAILED' END,
            last_error = 'LEASE_EXPIRED', lease_owner = NULL, lease_expires_at = NULL, available_at = now()
      WHERE j.id IN (
        SELECT j2.id FROM processing_job j2
         WHERE j2.status = 'RUNNING' AND j2.lease_expires_at < now()
           AND ($1::text IS NULL OR j2.asset_id IN (SELECT id FROM media_asset WHERE owner_id = $1))
         ORDER BY j2.lease_expires_at LIMIT $2
         FOR UPDATE SKIP LOCKED)
        AND j.status = 'RUNNING'
      RETURNING j.id, j.asset_id, j.status`,
    [o.ownerId ?? null, o.batchSize],
  );
  for (const j of r.rows) log('warn', 'lease expired, job reaped', { job_id: j.id, asset_id: j.asset_id ?? undefined, status: j.status });
  return r.rows.map((j) => j.id);
}

/**
 * Re-sends the event for light-processing jobs that are retryable but quiet for `jobStaleSeconds`
 * (the message was lost, or sits in the DLQ of a previous run). Assets GC may delete are skipped.
 * Sending touches the job row, which restarts the quiet period, so one lost job is not resent every run.
 */
export async function requeueJobs(pool: Pool, sqs: SQSClient, o: GcOptions): Promise<string[]> {
  const rows = (
    await pool.query<{ id: string; asset_id: string; bucket: string; key: string }>(
      `SELECT j.id, j.asset_id, a.original_bucket AS bucket, a.original_key AS key
         FROM processing_job j JOIN media_asset a ON a.id = j.asset_id
        WHERE j.job_type = ANY($1)
          AND j.attempts < j.max_attempts
          AND ((j.status = 'FAILED' AND j.available_at <= now()) OR j.status = 'QUEUED')
          AND j.updated_at <= now() - make_interval(secs => $2)
          AND a.upload_status IN ('UPLOADED', 'VALIDATED')
          AND a.retention_status IN ('UNATTACHED', 'REFERENCED', 'PUBLISHED')
          AND ($3::text IS NULL OR a.owner_id = $3)
        ORDER BY j.updated_at LIMIT $4`,
      [LIGHT_JOB_TYPES, o.jobStaleSeconds, o.ownerId ?? null, o.batchSize],
    )
  ).rows;
  const sent: string[] = [];
  for (const j of rows) {
    await sqs.send(new SendMessageCommand({ QueueUrl: config.queueLightProcessingUrl, MessageBody: syntheticObjectCreated(j.bucket, j.key) }));
    await pool.query(`UPDATE processing_job SET status = 'QUEUED' WHERE id = $1 AND status IN ('QUEUED', 'FAILED')`, [j.id]);
    log('info', 'job requeued', { job_id: j.id, asset_id: j.asset_id });
    sent.push(j.id);
  }
  return sent;
}

export interface JobReport {
  job_id: string;
  job_type: string;
  asset_id: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  problem: 'FAILED' | 'FAILED_PERMANENT' | 'LEASE_EXPIRED' | 'STALE_QUEUED';
  updated_at: string;
}

/** Jobs that need a human or the next GC run: failed, dead, stuck RUNNING, or quiet QUEUED. */
export async function listProblemJobs(pool: Pool, o: Pick<GcOptions, 'jobStaleSeconds' | 'ownerId' | 'batchSize'>): Promise<JobReport[]> {
  const rows = (
    await pool.query(
      `SELECT j.id, j.job_type, j.asset_id, j.status, j.attempts, j.max_attempts, j.last_error, j.updated_at,
              CASE WHEN j.status = 'RUNNING' THEN 'LEASE_EXPIRED'
                   WHEN j.status = 'QUEUED' THEN 'STALE_QUEUED'
                   ELSE j.status END AS problem
         FROM processing_job j LEFT JOIN media_asset a ON a.id = j.asset_id
        WHERE (j.status IN ('FAILED', 'FAILED_PERMANENT')
            OR (j.status = 'RUNNING' AND j.lease_expires_at < now())
            OR (j.status = 'QUEUED' AND j.updated_at <= now() - make_interval(secs => $1)))
          AND ($2::text IS NULL OR a.owner_id = $2)
        ORDER BY j.updated_at DESC LIMIT $3`,
      [o.jobStaleSeconds, o.ownerId ?? null, o.batchSize],
    )
  ).rows;
  return rows.map((r) => ({
    job_id: r.id,
    job_type: r.job_type,
    asset_id: r.asset_id,
    status: r.status,
    attempts: r.attempts,
    max_attempts: r.max_attempts,
    last_error: r.last_error,
    problem: r.problem,
    updated_at: r.updated_at.toISOString(),
  }));
}

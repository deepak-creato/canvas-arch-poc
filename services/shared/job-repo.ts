import { Pool } from 'pg';
import { log } from './log';

export interface Job {
  id: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, any>;
}

/** A failure retrying cannot fix: the job goes straight to FAILED_PERMANENT. */
export class PermanentError extends Error {}

// not claimed: done = nothing left to do, busy = someone holds the lease or backoff pending,
// failed = FAILED_PERMANENT (the message should end in the DLQ), missing = no row
export type ClaimResult =
  | { claimed: true; job: Job }
  | { claimed: false; reason: 'done' | 'busy' | 'failed' | 'missing' };

/** Atomically takes a QUEUED/FAILED job, or one whose lease expired, and counts the attempt. */
export async function claimJob(pool: Pool, key: string, owner: string, leaseSeconds: number): Promise<ClaimResult> {
  const r = await pool.query<Job>(
    `UPDATE processing_job
        SET status = 'RUNNING', attempts = attempts + 1, lease_owner = $2,
            lease_expires_at = now() + make_interval(secs => $3)
      WHERE idempotency_key = $1
        AND available_at <= now()
        AND attempts < max_attempts
        AND (status IN ('QUEUED', 'FAILED') OR (status = 'RUNNING' AND lease_expires_at < now()))
      RETURNING id, attempts, max_attempts, payload`,
    [key, owner, leaseSeconds],
  );
  if (r.rows[0]) return { claimed: true, job: r.rows[0] };

  const s = await pool.query<{ status: string; attempts: number; max_attempts: number }>(
    `SELECT status, attempts, max_attempts FROM processing_job WHERE idempotency_key = $1`,
    [key],
  );
  const row = s.rows[0];
  if (!row) return { claimed: false, reason: 'missing' };
  if (row.status === 'SUCCEEDED') return { claimed: false, reason: 'done' };
  // FAILED with no attempts left, or already marked permanent
  if (row.status === 'FAILED_PERMANENT' || (row.status === 'FAILED' && row.attempts >= row.max_attempts)) {
    return { claimed: false, reason: 'failed' };
  }
  return { claimed: false, reason: 'busy' };
}

export async function succeedJob(pool: Pool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE processing_job
        SET status = 'SUCCEEDED', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE id = $1`,
    [jobId],
  );
}

/**
 * Records a failed attempt. The job becomes FAILED with exponential backoff, or FAILED_PERMANENT
 * when `permanent` is set or attempts are used up. Returns true when it is now permanent.
 */
export async function failJob(pool: Pool, job: Job, error: string, permanent = false): Promise<boolean> {
  const isPermanent = permanent || job.attempts >= job.max_attempts;
  await pool.query(
    `UPDATE processing_job
        SET status = $2, last_error = $3, lease_owner = NULL, lease_expires_at = NULL,
            available_at = now() + make_interval(secs => $4)
      WHERE id = $1`,
    [job.id, isPermanent ? 'FAILED_PERMANENT' : 'FAILED', error.slice(0, 1000), isPermanent ? 0 : backoffSeconds(job.attempts)],
  );
  return isPermanent;
}

export const backoffSeconds = (attempts: number) => Math.min(2 ** attempts, 30);

/** Keeps the lease alive while `fn` runs, so long FFmpeg jobs are not taken over by another worker. */
export async function withHeartbeat<T>(
  pool: Pool,
  jobId: string,
  owner: string,
  leaseSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    pool
      .query(
        `UPDATE processing_job SET lease_expires_at = now() + make_interval(secs => $3)
          WHERE id = $1 AND lease_owner = $2 AND status = 'RUNNING'`,
        [jobId, owner, leaseSeconds],
      )
      .then((r) => {
        if (r.rowCount === 0) log('warn', 'lease lost', { job_id: jobId });
      })
      .catch((e) => log('error', 'heartbeat failed', { job_id: jobId, error: String(e) }));
  }, (leaseSeconds * 1000) / 3);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

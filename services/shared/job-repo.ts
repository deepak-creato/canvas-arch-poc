import { Pool } from 'pg';

export interface Job {
  id: string;
  attempts: number;
  max_attempts: number;
}

// not claimed: done = nothing left to do, busy = someone holds the lease or backoff pending, missing = no row
export type ClaimResult = { claimed: true; job: Job } | { claimed: false; reason: 'done' | 'busy' | 'missing' };

export async function claimJob(pool: Pool, key: string, owner: string, leaseSeconds: number): Promise<ClaimResult> {
  const r = await pool.query<Job>(
    `UPDATE processing_job
        SET status = 'RUNNING', attempts = attempts + 1, lease_owner = $2,
            lease_expires_at = now() + make_interval(secs => $3)
      WHERE idempotency_key = $1
        AND available_at <= now()
        AND attempts < max_attempts
        AND (status IN ('QUEUED', 'FAILED') OR (status = 'RUNNING' AND lease_expires_at < now()))
      RETURNING id, attempts, max_attempts`,
    [key, owner, leaseSeconds],
  );
  if (r.rows[0]) return { claimed: true, job: r.rows[0] };

  const s = await pool.query<{ status: string }>(`SELECT status FROM processing_job WHERE idempotency_key = $1`, [key]);
  if (!s.rows[0]) return { claimed: false, reason: 'missing' };
  return { claimed: false, reason: ['SUCCEEDED', 'FAILED_PERMANENT'].includes(s.rows[0].status) ? 'done' : 'busy' };
}

export async function succeedJob(pool: Pool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE processing_job
        SET status = 'SUCCEEDED', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE id = $1`,
    [jobId],
  );
}

/** Retryable failure: back to FAILED with backoff, or FAILED_PERMANENT once attempts run out. */
export async function failJob(pool: Pool, job: Job, error: string): Promise<void> {
  const permanent = job.attempts >= job.max_attempts;
  await pool.query(
    `UPDATE processing_job
        SET status = $2, last_error = $3, lease_owner = NULL, lease_expires_at = NULL,
            available_at = now() + make_interval(secs => $4)
      WHERE id = $1`,
    [job.id, permanent ? 'FAILED_PERMANENT' : 'FAILED', error.slice(0, 1000), 2 ** job.attempts],
  );
}

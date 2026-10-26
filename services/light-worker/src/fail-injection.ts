import { Job, PermanentError } from '../../shared/job-repo';

/**
 * Deterministic failures for tests, driven by the job's payload so a test can target one job:
 *   {"fail_mode": "transient:N"}  fails the first N attempts, then works
 *   {"fail_mode": "permanent"}    always fails, without retry
 * Only active when WORKER_TEST_HOOKS=true (local POC).
 */
export function injectFailure(job: Job): void {
  if (process.env.WORKER_TEST_HOOKS !== 'true') return;
  const mode = job.payload?.fail_mode;
  if (typeof mode !== 'string') return;
  if (mode === 'permanent') throw new PermanentError('injected permanent failure');
  const m = /^transient:(\d+)$/.exec(mode);
  if (m && job.attempts <= Number(m[1])) throw new Error(`injected transient failure (attempt ${job.attempts})`);
}

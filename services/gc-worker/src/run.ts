import { Pool } from 'pg';
import { log } from '../../shared/log';
import { expireUploads, markUnattached } from './expire';
import { createS3 } from '../../shared/s3';
import { createSqs } from '../../shared/sqs';
import { GcOptions } from './options';
import { pruneRevisions, purgeDiscardedDrafts } from './prune';
import { reapStuckJobs, requeueJobs } from './jobs';
import { sweep } from './sweep';

const s3 = createS3();
const sqs = createSqs();

export type Summary = Record<string, unknown>;

// Cycle order follows plan 7.4. Later tickets add their steps here.
export const STEPS: Record<string, (pool: Pool, o: GcOptions) => Promise<Summary>> = {
  expireUploads: async (pool, o) => ({ expired: await expireUploads(pool, o) }),
  purgeDiscardedDrafts: async (pool, o) => ({ purged: await purgeDiscardedDrafts(pool, o) }),
  pruneRevisions: async (pool, o) => ({ pruned: await pruneRevisions(pool, o) }),
  markUnattached: async (pool, o) => ({ orphaned: await markUnattached(pool, o) }),
  reapStuckJobs: async (pool, o) => ({ reaped: await reapStuckJobs(pool, o) }),
  requeueJobs: async (pool, o) => ({ requeued: await requeueJobs(pool, sqs, o) }),
  sweep: async (pool, o) => ({ ...(await sweep(pool, s3, o)) }),
};

const LOCK_KEY = 7_310_031; // arbitrary, shared by every gc-worker

/** Runs the steps in order under a Postgres advisory lock. Returns null when another run holds it. */
export async function runCycle(pool: Pool, o: GcOptions, only?: string): Promise<Summary | null> {
  const names = only ? [only] : Object.keys(STEPS);
  for (const n of names) if (!STEPS[n]) throw new Error(`unknown step ${n}`);
  const client = await pool.connect();
  try {
    const got = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY])).rows[0].ok;
    if (!got) {
      log('warn', 'gc cycle skipped, another run holds the lock');
      return null;
    }
    try {
      const out: Summary = {};
      for (const n of names) {
        try {
          out[n] = await STEPS[n](pool, o);
        } catch (e) {
          // One failing step must not stop the others.
          log('error', 'gc step failed', { step: n, error: String(e) });
          out[n] = { error: String(e) };
        }
      }
      log('info', 'gc cycle done', { summary: out });
      return out;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

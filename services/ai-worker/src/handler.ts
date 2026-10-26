import { Pool } from 'pg';
import { log } from '../../shared/log';
import { generateLayout, LayoutInput } from '../../shared/mock-layout';

export type Outcome = 'ack' | 'retry';

interface Generation {
  id: string;
  draft_id: string;
  model_version: string;
  seed: number;
  request: { assets: LayoutInput['assets']; canvas: LayoutInput['canvas']; test_fail?: 'permanent' | 'transient_once' };
}

// A PROCESSING row older than this has lost its worker; another delivery may take it.
const STALE_SECONDS = 120;

/**
 * One ai-requests message: { generation_id }.
 * QUEUED -> PROCESSING -> READY | FAILED. Safe under duplicate delivery: only one delivery wins the claim.
 * A transient error puts the row back to QUEUED and asks for redelivery, until `maxReceives` is used up.
 */
export async function handleMessage(pool: Pool, body: string, messageId: string, receives: number, maxReceives: number): Promise<Outcome> {
  let id: unknown;
  try {
    id = JSON.parse(body)?.generation_id;
  } catch {
    /* falls through */
  }
  if (typeof id !== 'string') {
    log('warn', 'dropping malformed ai message', { correlation_id: messageId });
    return 'ack';
  }

  const claimed = await pool.query<Generation>(
    `UPDATE ai_generation SET status = 'PROCESSING', error = NULL
      WHERE id = $1 AND (status = 'QUEUED' OR (status = 'PROCESSING' AND updated_at < now() - make_interval(secs => $2)))
      RETURNING id, draft_id, model_version, seed, request`,
    [id, STALE_SECONDS],
  );
  const gen = claimed.rows[0];
  if (!gen) {
    // Finished, in flight elsewhere, or unknown. Nothing to do for this delivery.
    log('info', 'ai generation not claimable, acking', { correlation_id: messageId, generation_id: id });
    return 'ack';
  }

  const fields = { generation_id: gen.id, draft_id: gen.draft_id, correlation_id: messageId };
  try {
    const result = run(gen, receives);
    await pool.query(`UPDATE ai_generation SET status = 'READY', result = $2, error = NULL WHERE id = $1`, [gen.id, JSON.stringify(result)]);
    log('info', 'ai layout ready', fields);
    return 'ack';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const permanent = e instanceof PermanentAiError || receives >= maxReceives;
    if (permanent) {
      await pool.query(`UPDATE ai_generation SET status = 'FAILED', error = $2 WHERE id = $1`, [gen.id, message]);
      log('error', 'ai layout failed', { ...fields, error: message });
      return 'ack';
    }
    await pool.query(`UPDATE ai_generation SET status = 'QUEUED', error = $2 WHERE id = $1`, [gen.id, message]);
    log('warn', 'ai layout attempt failed, will retry', { ...fields, receives, error: message });
    return 'retry';
  }
}

class PermanentAiError extends Error {}

function run(gen: Generation, receives: number) {
  // Test hooks, local POC only (same switch as light-worker).
  if (process.env.WORKER_TEST_HOOKS === 'true') {
    if (gen.request.test_fail === 'permanent') throw new PermanentAiError('injected permanent failure');
    if (gen.request.test_fail === 'transient_once' && receives <= 1) throw new Error('injected transient failure');
  }
  try {
    return generateLayout({ assets: gen.request.assets, canvas: gen.request.canvas, seed: gen.seed, model_version: gen.model_version });
  } catch (e) {
    // Bad input will not get better on retry.
    throw new PermanentAiError(e instanceof Error ? e.message : String(e));
  }
}

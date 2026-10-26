import { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

// Forward order of the happy path (plan section 6). FAILED is reachable from any non-LIVE state.
export const PUBLICATION_ORDER = ['REQUESTED', 'WAITING_FOR_ASSETS', 'TRANSCODING', 'AWAITING_CANVAS', 'FINALIZING', 'LIVE'];

/**
 * Moves a publication forward (or to FAILED) and records the transition, in one statement.
 * Returns false when nothing changed: already there, an older state than the current one
 * (a redelivered step), LIVE, or FAILED (leaving FAILED is `resetForRetry`'s job).
 */
export async function transition(
  db: Queryable,
  publicationId: string,
  to: string,
  step: string,
  opts: { reason?: string; detail?: Record<string, unknown> } = {},
): Promise<boolean> {
  const r = await db.query(
    `WITH cur AS (SELECT id, status FROM publication WHERE id = $1 FOR UPDATE),
          upd AS (
            UPDATE publication p
               SET status = $2,
                   failure_reason = CASE WHEN $2 = 'FAILED' THEN $4 ELSE p.failure_reason END,
                   task_token = CASE WHEN $2 IN ('FAILED', 'LIVE') THEN NULL ELSE p.task_token END
              FROM cur
             WHERE p.id = cur.id
               AND cur.status <> $2
               AND cur.status <> 'LIVE'
               AND ($2 = 'FAILED'
                    OR (cur.status <> 'FAILED'
                        AND array_position($5::text[], $2) > array_position($5::text[], cur.status)))
            RETURNING cur.status AS from_status)
     INSERT INTO publication_transition (publication_id, from_status, to_status, step, detail)
     SELECT $1, from_status, $2, $3, $6::jsonb FROM upd`,
    [publicationId, to, step, opts.reason ?? null, PUBLICATION_ORDER, JSON.stringify(opts.detail ?? {})],
  );
  return (r.rowCount ?? 0) > 0;
}

import { DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { config } from '../../shared/config';
import { log } from '../../shared/log';
import { LIGHT_JOB_TYPES } from './jobs';

interface Target {
  bucket: string;
  key: string;
}

function target(body: string): Target | null {
  try {
    const e = JSON.parse(body);
    const bucket = e?.detail?.bucket?.name;
    const key = e?.detail?.object?.key;
    return e?.['detail-type'] === 'Object Created' && typeof bucket === 'string' && typeof key === 'string' ? { bucket, key } : null;
  } catch {
    return null;
  }
}

export interface DlqEntry {
  message_id: string;
  receive_count: number;
  object: Target | null;
  asset_id: string | null;
  owner_id: string | null;
  upload_status: string | null;
  retention_status: string | null;
  jobs: { job_id: string; job_type: string; status: string; attempts: number; last_error: string | null }[];
}

/** Receives without hiding the messages for long, so an inspection leaves the queue as it was. */
async function peek(sqs: SQSClient, url: string, max: number) {
  const seen = new Map<string, { id: string; body: string; receives: number }>();
  for (let i = 0; i < 5 && seen.size < max; i++) {
    const r = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, VisibilityTimeout: 0, WaitTimeSeconds: 0, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }),
    );
    for (const m of r.Messages ?? []) {
      if (m.MessageId && !seen.has(m.MessageId)) seen.set(m.MessageId, { id: m.MessageId, body: m.Body ?? '', receives: Number(m.Attributes?.ApproximateReceiveCount ?? 1) });
    }
    if (!r.Messages?.length) break;
  }
  return [...seen.values()].slice(0, max);
}

async function describe(pool: Pool, t: Target | null) {
  if (!t) return { asset_id: null, owner_id: null, upload_status: null, retention_status: null, jobs: [] };
  const a = (
    await pool.query(`SELECT id, owner_id, upload_status, retention_status FROM media_asset WHERE original_bucket = $1 AND original_key = $2`, [t.bucket, t.key])
  ).rows[0];
  if (!a) return { asset_id: null, owner_id: null, upload_status: null, retention_status: null, jobs: [] };
  const jobs = (
    await pool.query(`SELECT id AS job_id, job_type, status, attempts, last_error FROM processing_job WHERE asset_id = $1 ORDER BY created_at`, [a.id])
  ).rows;
  return { asset_id: a.id as string, owner_id: a.owner_id as string, upload_status: a.upload_status as string, retention_status: a.retention_status as string, jobs };
}

/** What is in the DLQ and why: depth, and per message the asset and its jobs with their last errors. */
export async function inspectDlq(pool: Pool, sqs: SQSClient, o: { max?: number; ownerId?: string; url?: string } = {}) {
  const url = o.url ?? config.queueLightProcessingDlqUrl;
  const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }));
  const entries: DlqEntry[] = [];
  for (const m of await peek(sqs, url, o.max ?? 20)) {
    const t = target(m.body);
    const d = await describe(pool, t);
    if (o.ownerId && d.owner_id !== o.ownerId) continue;
    entries.push({ message_id: m.id, receive_count: m.receives, object: t, ...d });
  }
  return { queue: url, depth: Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0), messages: entries };
}

export interface RedriveResult {
  moved: string[];
  /** asset is gone or being deleted: message dropped */
  dropped: string[];
  /** not an S3 event or unknown object: left in the DLQ */
  kept: string[];
  reset_jobs: string[];
}

/**
 * Moves DLQ messages back to the source queue (receive, send, delete; no dependency on
 * StartMessageMoveTask) and resets the asset's FAILED_PERMANENT light jobs to QUEUED with
 * attempts 0, so the redelivered message gets a full set of attempts again.
 * `ownerId` limits the move to that owner's assets (tests, targeted recovery).
 */
export async function redriveDlq(pool: Pool, sqs: SQSClient, o: { max?: number; ownerId?: string } = {}): Promise<RedriveResult> {
  const max = o.max ?? 100;
  const dlq = config.queueLightProcessingDlqUrl;
  const source = config.queueLightProcessingUrl;
  const out: RedriveResult = { moved: [], dropped: [], kept: [], reset_jobs: [] };
  let handled = 0;
  while (handled < max) {
    // Hidden for a minute so this loop does not see its own kept messages again.
    const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, MaxNumberOfMessages: 10, VisibilityTimeout: 60, WaitTimeSeconds: 0 }));
    if (!r.Messages?.length) break;
    for (const m of r.Messages) {
      handled++;
      const t = target(m.Body ?? '');
      const d = await describe(pool, t);
      const del = () => sqs.send(new DeleteMessageCommand({ QueueUrl: dlq, ReceiptHandle: m.ReceiptHandle! }));
      if (!t || !d.asset_id || (o.ownerId && d.owner_id !== o.ownerId)) {
        out.kept.push(m.MessageId!);
        continue;
      }
      if (d.retention_status === 'DELETING' || d.retention_status === 'DELETED') {
        await del();
        out.dropped.push(m.MessageId!);
        continue;
      }
      const reset = await pool.query<{ id: string }>(
        `UPDATE processing_job SET status = 'QUEUED', attempts = 0, available_at = now(), lease_owner = NULL, lease_expires_at = NULL
          WHERE asset_id = $1 AND job_type = ANY($2) AND status IN ('FAILED', 'FAILED_PERMANENT') RETURNING id`,
        [d.asset_id, LIGHT_JOB_TYPES],
      );
      await sqs.send(new SendMessageCommand({ QueueUrl: source, MessageBody: m.Body! }));
      await del();
      out.moved.push(m.MessageId!);
      out.reset_jobs.push(...reset.rows.map((x) => x.id));
      log('info', 'dlq message redriven', { asset_id: d.asset_id, correlation_id: m.MessageId, reset_jobs: reset.rowCount });
    }
  }
  return out;
}

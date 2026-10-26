import { S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { confirmUpload, UPLOAD_ASSET_COLUMNS, UploadAssetRow } from '../../shared/confirm-upload';
import { log } from '../../shared/log';
import { parseObjectCreated } from './event';

// ack: delete the message. retry: leave it; SQS redelivers it, then moves it to the DLQ.
export type Outcome = 'ack' | 'retry';

// Failures that retrying cannot fix. Rejecting such assets is POC-009.
const TERMINAL = new Set(['UPLOAD_EXPIRED', 'UPLOAD_NOT_COMPLETABLE', 'SIZE_MISMATCH', 'CONTENT_TYPE_MISMATCH']);

export async function handleMessage(pool: Pool, s3: S3Client, body: string, messageId: string): Promise<Outcome> {
  const ev = parseObjectCreated(body);
  if (!ev) {
    log('error', 'unparseable event, leaving for DLQ', { correlation_id: messageId });
    return 'retry';
  }

  const found = await pool.query<UploadAssetRow>(
    `SELECT ${UPLOAD_ASSET_COLUMNS} FROM media_asset WHERE original_bucket = $1 AND original_key = $2`,
    [ev.bucket, ev.key],
  );
  const asset = found.rows[0];
  if (!asset) {
    log('warn', 'event for unknown object, dropping', { correlation_id: messageId, key: ev.key });
    return 'ack';
  }
  const ctx = { asset_id: asset.id, correlation_id: messageId };

  // The event can beat the API "complete" call; confirmUpload makes either order safe.
  const r = await confirmUpload(pool, s3, asset, messageId);
  if (r.ok) {
    // POC-009 runs the validate job from here.
    log('info', 'validate job ready', { ...ctx, status: r.status });
    return 'ack';
  }
  if (TERMINAL.has(r.code)) {
    log('warn', 'upload not processable', { ...ctx, code: r.code, reason: r.message });
    return 'ack';
  }
  log('warn', 'upload not confirmable yet, will retry', { ...ctx, code: r.code });
  return 'retry';
}

import { S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { confirmUpload, UPLOAD_ASSET_COLUMNS, UploadAssetRow } from '../../shared/confirm-upload';
import { log } from '../../shared/log';
import { deriveImage } from './derive-image';
import { deriveVideo } from './derive-video';
import { parseObjectCreated } from './event';
import { rejectAsset, validateAsset } from './validate';

// ack: delete the message.
// retry: leave it; SQS redelivers it after a short backoff.
// dead: the work failed for good; make it visible at once so SQS counts a receive and moves it to the DLQ.
export type Outcome = 'ack' | 'retry' | 'dead';

// Failures that retrying cannot fix. Rejecting such assets is POC-009.
const TERMINAL = new Set(['UPLOAD_EXPIRED', 'UPLOAD_NOT_COMPLETABLE']);
// The stored object disagrees with what was reserved: the upload is bad, so reject it.
const REJECTING = new Set(['SIZE_MISMATCH', 'CONTENT_TYPE_MISMATCH']);

export async function handleMessage(pool: Pool, s3: S3Client, body: string, messageId: string): Promise<Outcome> {
  const ev = parseObjectCreated(body);
  if (!ev) {
    log('error', 'unparseable event, leaving for DLQ', { correlation_id: messageId });
    return 'retry';
  }

  const found = await pool.query<UploadAssetRow & { retention_status: string }>(
    `SELECT ${UPLOAD_ASSET_COLUMNS}, retention_status FROM media_asset WHERE original_bucket = $1 AND original_key = $2`,
    [ev.bucket, ev.key],
  );
  const asset = found.rows[0];
  if (!asset) {
    log('warn', 'event for unknown object, dropping', { correlation_id: messageId, key: ev.key });
    return 'ack';
  }
  const ctx = { asset_id: asset.id, correlation_id: messageId };

  // GC owns the asset now (POC-033). Doing work would race the object deletes and could recreate files.
  if (asset.retention_status === 'DELETING' || asset.retention_status === 'DELETED') {
    log('warn', 'asset is being deleted, dropping event', { ...ctx, retention_status: asset.retention_status });
    return 'ack';
  }

  // The event can beat the API "complete" call; confirmUpload makes either order safe.
  const r = await confirmUpload(pool, s3, asset, messageId);
  if (r.ok) {
    // Both steps are idempotent, so a redelivered message resumes wherever the last attempt stopped.
    const steps = [
      () => validateAsset(pool, s3, asset.id, messageId),
      // Each derive only acts on its own kind and returns 'done' for the other.
      () => deriveImage(pool, s3, asset.id, messageId),
      () => deriveVideo(pool, s3, asset.id, messageId),
    ];
    for (const step of steps) {
      const out = await step();
      if (out === 'busy') return 'retry';
      if (out === 'failed') return 'dead';
    }
    return 'ack';
  }
  if (REJECTING.has(r.code)) {
    await rejectAsset(pool, asset.id, r.code, 'PENDING_UPLOAD');
    log('warn', 'asset rejected', { ...ctx, reason: r.code, detail: r.message });
    return 'ack';
  }
  if (TERMINAL.has(r.code)) {
    log('warn', 'upload not processable', { ...ctx, code: r.code, reason: r.message });
    return 'ack';
  }
  log('warn', 'upload not confirmable yet, will retry', { ...ctx, code: r.code });
  return 'retry';
}

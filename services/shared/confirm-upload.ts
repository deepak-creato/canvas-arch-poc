import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { ensureValidateJob } from './jobs';
import { log } from './log';

export interface UploadAssetRow {
  id: string;
  upload_status: string;
  original_bucket: string;
  original_key: string;
  content_type: string;
  size_bytes: string;
  upload_expires_at: Date;
}

export const UPLOAD_ASSET_COLUMNS =
  'id, upload_status, original_bucket, original_key, content_type, size_bytes, upload_expires_at';

export type ConfirmResult =
  | { ok: true; status: string }
  | { ok: false; code: string; message: string };

const isNotFound = (e: any) => e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;

const ref = (a: UploadAssetRow) => ({ id: a.id, bucket: a.original_bucket, key: a.original_key });

/**
 * Moves an asset PENDING_UPLOAD -> UPLOADED once the object is verified, and makes sure
 * the validate job exists. Used by both the API "complete" call and the S3 event consumer,
 * so whichever arrives first does the work and the other is a no-op.
 */
export async function confirmUpload(pool: Pool, s3: S3Client, a: UploadAssetRow, correlationId: string): Promise<ConfirmResult> {
  const ctx = { asset_id: a.id, correlation_id: correlationId };

  if (a.upload_status === 'UPLOADED' || a.upload_status === 'VALIDATED') {
    if (a.upload_status === 'UPLOADED') await ensureValidateJob(pool, ref(a));
    return { ok: true, status: a.upload_status };
  }
  if (a.upload_status !== 'PENDING_UPLOAD') {
    return { ok: false, code: 'UPLOAD_NOT_COMPLETABLE', message: `asset is ${a.upload_status}` };
  }
  if (a.upload_expires_at.getTime() < Date.now()) {
    return { ok: false, code: 'UPLOAD_EXPIRED', message: 'upload reservation expired' };
  }

  // The state only moves after the object is verified in S3.
  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: a.original_bucket, Key: a.original_key }));
  } catch (e) {
    if (isNotFound(e)) {
      log('warn', 'confirm before object exists', ctx);
      return { ok: false, code: 'OBJECT_NOT_FOUND', message: 'object not uploaded yet' };
    }
    throw e;
  }
  const size = Number(a.size_bytes);
  if (head.ContentLength !== size) {
    return { ok: false, code: 'SIZE_MISMATCH', message: `declared ${size} bytes, stored ${head.ContentLength}` };
  }
  if (head.ContentType !== a.content_type) {
    return {
      ok: false,
      code: 'CONTENT_TYPE_MISMATCH',
      message: `declared ${a.content_type}, stored ${head.ContentType}`,
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Guarded by the current status so a concurrent call cannot double-transition.
    await client.query(
      `UPDATE media_asset
          SET upload_status = 'UPLOADED',
              metadata = metadata || jsonb_build_object('etag', $2::text)
        WHERE id = $1 AND upload_status = 'PENDING_UPLOAD'`,
      [a.id, head.ETag ?? null],
    );
    await ensureValidateJob(client, ref(a));
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  log('info', 'upload confirmed', ctx);
  return { ok: true, status: 'UPLOADED' };
}

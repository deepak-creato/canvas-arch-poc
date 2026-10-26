import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { ensureValidateJob } from '../../../shared/jobs';
import { log } from '../../../shared/log';
import { PG_POOL, S3 } from '../tokens';

interface AssetRow {
  id: string;
  upload_status: string;
  original_bucket: string;
  original_key: string;
  content_type: string;
  size_bytes: string;
  upload_expires_at: Date;
}

export interface CompleteResult {
  asset_id: string;
  upload_status: string;
  size_bytes: number;
}

const isNotFound = (e: any) => e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;

@Injectable()
export class CompleteService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(S3) private readonly s3: S3Client,
  ) {}

  async complete(ownerId: string, assetId: string, correlationId: string): Promise<CompleteResult> {
    const ctx = { asset_id: assetId, correlation_id: correlationId };
    const found = await this.pool.query<AssetRow>(
      `SELECT id, upload_status, original_bucket, original_key, content_type, size_bytes, upload_expires_at
         FROM media_asset WHERE id = $1 AND owner_id = $2`,
      [assetId, ownerId],
    );
    const a = found.rows[0];
    if (!a) throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'asset not found' });

    const result = (status: string): CompleteResult => ({
      asset_id: a.id,
      upload_status: status,
      size_bytes: Number(a.size_bytes),
    });

    // Repeat calls are safe: make sure the job exists and report the current state.
    if (a.upload_status === 'UPLOADED' || a.upload_status === 'VALIDATED') {
      if (a.upload_status === 'UPLOADED') await ensureValidateJob(this.pool, this.ref(a));
      return result(a.upload_status);
    }
    if (a.upload_status !== 'PENDING_UPLOAD') {
      throw new ConflictException({ code: 'UPLOAD_NOT_COMPLETABLE', message: `asset is ${a.upload_status}` });
    }
    if (a.upload_expires_at.getTime() < Date.now()) {
      throw new ConflictException({ code: 'UPLOAD_EXPIRED', message: 'upload reservation expired' });
    }

    // The state only moves after the object is verified in S3.
    let head;
    try {
      head = await this.s3.send(new HeadObjectCommand({ Bucket: a.original_bucket, Key: a.original_key }));
    } catch (e) {
      if (isNotFound(e)) {
        log('warn', 'complete before object exists', ctx);
        throw new ConflictException({ code: 'OBJECT_NOT_FOUND', message: 'object not uploaded yet' });
      }
      throw e;
    }
    const size = Number(a.size_bytes);
    if (head.ContentLength !== size) {
      throw new ConflictException({
        code: 'SIZE_MISMATCH',
        message: `declared ${size} bytes, stored ${head.ContentLength}`,
      });
    }
    if (head.ContentType !== a.content_type) {
      throw new ConflictException({
        code: 'CONTENT_TYPE_MISMATCH',
        message: `declared ${a.content_type}, stored ${head.ContentType}`,
      });
    }

    const client = await this.pool.connect();
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
      await ensureValidateJob(client, this.ref(a));
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    log('info', 'upload completed', ctx);
    return result('UPLOADED');
  }

  private ref(a: AssetRow) {
    return { id: a.id, bucket: a.original_bucket, key: a.original_key };
  }
}

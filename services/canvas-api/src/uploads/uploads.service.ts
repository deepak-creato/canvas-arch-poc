import { randomUUID } from 'crypto';
import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Pool } from 'pg';
import { ALLOWED_CONTENT_TYPES, config } from '../../../shared/config';
import { originalKey } from '../../../shared/keys';
import { log } from '../../../shared/log';
import { CreateUploadDto } from './create-upload.dto';
import { PG_POOL, PRESIGN_S3 } from '../tokens';

interface AssetRow {
  id: string;
  upload_status: string;
  original_key: string;
  content_type: string;
  size_bytes: string;
  upload_expires_at: Date;
}

export interface UploadResult {
  asset_id: string;
  deduplicated: boolean;
  upload_status: string;
  upload_url: string | null;
  upload_headers: Record<string, string> | null;
  upload_expires_at: string | null;
}

// Same predicate as the partial unique index media_asset_owner_hash_active.
const LIVE_LOOKUP = `
  SELECT id, upload_status, original_key, content_type, size_bytes, upload_expires_at
    FROM media_asset
   WHERE owner_id = $1 AND client_sha256 = $2
     AND upload_status IN ('PENDING_UPLOAD', 'UPLOADED', 'VALIDATED')
     AND retention_status NOT IN ('DELETING', 'DELETED')`;

@Injectable()
export class UploadsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PRESIGN_S3) private readonly s3: S3Client,
  ) {}

  async createUpload(ownerId: string, dto: CreateUploadDto, correlationId: string): Promise<UploadResult> {
    const kind = ALLOWED_CONTENT_TYPES[dto.content_type];
    const max = kind === 'IMAGE' ? config.maxImageBytes : config.maxVideoBytes;
    if (dto.size_bytes > max) {
      throw new UnprocessableEntityException({ code: 'FILE_TOO_LARGE', message: `max ${max} bytes for ${kind}` });
    }

    const existing = await this.findLive(ownerId, dto.sha256);
    if (existing) return this.respondExisting(ownerId, existing, correlationId);

    const id = randomUUID();
    const key = originalKey(ownerId, id);
    const expires = new Date(Date.now() + config.uploadTtlSeconds * 1000);
    const inserted = await this.pool.query<AssetRow>(
      `INSERT INTO media_asset
         (id, owner_id, kind, client_sha256, content_type, size_bytes, original_bucket, original_key,
          metadata, upload_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (owner_id, client_sha256)
         WHERE upload_status IN ('PENDING_UPLOAD', 'UPLOADED', 'VALIDATED')
           AND retention_status NOT IN ('DELETING', 'DELETED')
       DO NOTHING
       RETURNING id, upload_status, original_key, content_type, size_bytes, upload_expires_at`,
      [id, ownerId, kind, dto.sha256, dto.content_type, dto.size_bytes, config.bucketIngest, key,
        JSON.stringify({ filename: dto.filename ?? null }), expires],
    );

    if (inserted.rowCount === 0) {
      // Lost a race with a concurrent identical request: return the winner.
      const winner = await this.findLive(ownerId, dto.sha256);
      if (!winner) throw new Error('dedup race: no live asset after conflict');
      return this.respondExisting(ownerId, winner, correlationId);
    }

    log('info', 'upload reserved', { asset_id: id, correlation_id: correlationId, owner_id: ownerId });
    return this.pending(inserted.rows[0], expires, false);
  }

  private async findLive(ownerId: string, sha256: string): Promise<AssetRow | undefined> {
    const r = await this.pool.query<AssetRow>(LIVE_LOOKUP, [ownerId, sha256]);
    return r.rows[0];
  }

  private async respondExisting(ownerId: string, a: AssetRow, correlationId: string): Promise<UploadResult> {
    log('info', 'upload dedup hit', { asset_id: a.id, correlation_id: correlationId, status: a.upload_status });
    if (a.upload_status === 'PENDING_UPLOAD') {
      // Client may not have uploaded yet (or the URL expired): extend the reservation, fresh URL.
      const expires = new Date(Date.now() + config.uploadTtlSeconds * 1000);
      await this.pool.query(`UPDATE media_asset SET upload_expires_at = $2 WHERE id = $1`, [a.id, expires]);
      return this.pending(a, expires, false);
    }
    return {
      asset_id: a.id,
      deduplicated: a.upload_status === 'VALIDATED',
      upload_status: a.upload_status,
      upload_url: null,
      upload_headers: null,
      upload_expires_at: null,
    };
  }

  private async pending(a: AssetRow, expires: Date, deduplicated: boolean): Promise<UploadResult> {
    const size = Number(a.size_bytes);
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: config.bucketIngest,
        Key: a.original_key,
        ContentType: a.content_type,
        ContentLength: size,
      }),
      { expiresIn: config.uploadTtlSeconds },
    );
    return {
      asset_id: a.id,
      deduplicated,
      upload_status: 'PENDING_UPLOAD',
      upload_url: url,
      upload_headers: { 'Content-Type': a.content_type, 'Content-Length': String(size) },
      upload_expires_at: expires.toISOString(),
    };
  }
}

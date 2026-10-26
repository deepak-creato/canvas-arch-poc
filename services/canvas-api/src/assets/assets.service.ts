import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { config } from '../../../shared/config';
import { PG_POOL, PRESIGN_S3 } from '../tokens';

// Client-facing roll-up of upload and processing state.
export type ProcessingStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED' | 'REJECTED' | 'EXPIRED';

interface AssetRow {
  id: string;
  kind: string;
  content_type: string;
  size_bytes: string | null;
  upload_status: string;
  reject_reason: string | null;
  retention_status: string;
  metadata: Record<string, any>;
  created_at: Date;
}

interface RenditionRow {
  kind: string;
  status: string;
  bucket: string;
  s3_key: string;
  error: string | null;
  metadata: Record<string, any>;
}

@Injectable()
export class AssetsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PRESIGN_S3) private readonly s3: S3Client,
  ) {}

  async get(ownerId: string, assetId: string) {
    const a = (
      await this.pool.query<AssetRow>(
        `SELECT id, kind, content_type, size_bytes, upload_status, reject_reason, retention_status, metadata, created_at
           FROM media_asset WHERE id = $1 AND owner_id = $2`,
        [assetId, ownerId],
      )
    ).rows[0];
    // Another owner's asset looks the same as a missing one.
    if (!a) throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'asset not found' });

    const renditions = (
      await this.pool.query<RenditionRow>(
        `SELECT kind, status, bucket, s3_key, error, metadata FROM media_rendition
          WHERE asset_id = $1 AND tier = 'DRAFT' ORDER BY kind, s3_key`,
        [a.id],
      )
    ).rows;
    const deriveJob = (
      await this.pool.query<{ status: string }>(
        `SELECT status FROM processing_job WHERE asset_id = $1 AND job_type IN ('image-derive', 'video-derive')`,
        [a.id],
      )
    ).rows[0]?.status;

    const { filename, ...info } = a.metadata ?? {};
    return {
      asset_id: a.id,
      kind: a.kind,
      filename: filename ?? null,
      content_type: a.content_type,
      size_bytes: a.size_bytes === null ? null : Number(a.size_bytes),
      upload_status: a.upload_status,
      reject_reason: a.reject_reason,
      processing_status: rollUp(a.upload_status, deriveJob, renditions.map((r) => r.status)),
      // Probed facts (dimensions, duration, codec, ...). The upload etag stays internal.
      media: Object.fromEntries(Object.entries(info).filter(([k]) => k !== 'etag')),
      renditions: await Promise.all(renditions.map((r) => this.rendition(r))),
      created_at: a.created_at.toISOString(),
    };
  }

  private async rendition(r: RenditionRow) {
    const ready = r.status === 'READY';
    const { reused, ...meta } = r.metadata ?? {};
    return {
      kind: r.kind,
      status: r.status,
      url: ready
        ? await getSignedUrl(this.s3, new GetObjectCommand({ Bucket: r.bucket, Key: r.s3_key }), { expiresIn: config.downloadTtlSeconds })
        : null,
      content_type: meta.content_type ?? null,
      width: meta.width ?? null,
      height: meta.height ?? null,
      bytes: meta.bytes ?? null,
      // sprite.json is served by url; the sheet and frame layout stays in that file.
      error: r.error,
    };
  }
}

/**
 * Upload state first, then the derive job and its rendition rows.
 * A transient FAILED job or rendition is still PROCESSING because the worker will retry it.
 */
export function rollUp(upload: string, deriveJob: string | undefined, renditions: string[]): ProcessingStatus {
  if (upload === 'REJECTED') return 'REJECTED';
  if (upload === 'EXPIRED') return 'EXPIRED';
  if (upload === 'PENDING_UPLOAD') return 'PENDING';
  if (upload === 'UPLOADED') return 'PROCESSING';
  // VALIDATED
  if (deriveJob === 'FAILED_PERMANENT' || renditions.includes('FAILED_PERMANENT')) return 'FAILED';
  if (deriveJob === 'SUCCEEDED' && renditions.length > 0 && renditions.every((s) => s === 'READY')) return 'READY';
  return 'PROCESSING';
}

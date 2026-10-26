import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import { confirmUpload, UPLOAD_ASSET_COLUMNS, UploadAssetRow } from '../../../shared/confirm-upload';
import { PG_POOL, S3 } from '../tokens';

export interface CompleteResult {
  asset_id: string;
  upload_status: string;
  size_bytes: number;
}

@Injectable()
export class CompleteService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(S3) private readonly s3: S3Client,
  ) {}

  async complete(ownerId: string, assetId: string, correlationId: string): Promise<CompleteResult> {
    const found = await this.pool.query<UploadAssetRow>(
      `SELECT ${UPLOAD_ASSET_COLUMNS} FROM media_asset WHERE id = $1 AND owner_id = $2`,
      [assetId, ownerId],
    );
    const a = found.rows[0];
    if (!a) throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'asset not found' });

    const r = await confirmUpload(this.pool, this.s3, a, correlationId);
    if (!r.ok) throw new ConflictException({ code: r.code, message: r.message });
    return { asset_id: a.id, upload_status: r.status, size_bytes: Number(a.size_bytes) };
  }
}

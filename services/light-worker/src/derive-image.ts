import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import sharp from 'sharp';
import { DeriveOutcome, RenditionSpec, runDerive } from './derive-common';
import { IMAGE_RECIPES, ImageRecipe, imageDeriveKey, paramsHash } from './recipes';

/** Creates the draft-tier thumbnail and preview for a VALIDATED image. Safe to call repeatedly. */
export async function deriveImage(pool: Pool, s3: S3Client, assetId: string, correlationId: string): Promise<DeriveOutcome> {
  const a = (
    await pool.query<{ id: string; kind: string; upload_status: string; original_bucket: string; original_key: string }>(
      `SELECT id, kind, upload_status, original_bucket, original_key FROM media_asset WHERE id = $1`,
      [assetId],
    )
  ).rows[0];
  if (!a || a.kind !== 'IMAGE' || a.upload_status !== 'VALIDATED') return 'done';

  let source: Buffer | undefined; // downloaded lazily, only if some output is missing
  const getSource = async () =>
    (source ??= Buffer.from(
      await (await s3.send(new GetObjectCommand({ Bucket: a.original_bucket, Key: a.original_key }))).Body!.transformToByteArray(),
    ));

  const specs: RenditionSpec[] = IMAGE_RECIPES.map((r) => ({
    kind: r.kind,
    version: r.version,
    paramsHash: paramsHash(r),
    ext: 'webp',
    contentType: 'image/webp',
    produce: async () => {
      const out = await render(await getSource(), r);
      return { body: out.data, metadata: { width: out.width, height: out.height } };
    },
  }));
  return runDerive(pool, s3, a.id, { type: 'image-derive', key: imageDeriveKey(a.id), leaseSeconds: 120 }, specs, correlationId);
}

async function render(source: Buffer, r: ImageRecipe) {
  const { data, info } = await sharp(source, { failOn: 'error' })
    .rotate() // apply EXIF orientation, then drop it
    .resize({ width: r.width, height: r.height, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: r.quality })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

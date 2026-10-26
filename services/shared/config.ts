const int = (v: string | undefined, d: number) => (v ? Number(v) : d);

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://canvas:canvas@localhost:5433/canvas',
  region: process.env.AWS_REGION ?? 'us-east-1',
  s3Endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  s3PublicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:4566',
  bucketIngest: process.env.BUCKET_INGEST ?? 'media-ingest-poc',
  bucketDerived: process.env.BUCKET_DERIVED ?? 'media-derived-poc',
  stagingPrefix: process.env.UPLOAD_STAGING_PREFIX ?? 'staging/',
  maxImageBytes: int(process.env.MAX_IMAGE_BYTES, 20 * 1024 * 1024),
  maxVideoBytes: int(process.env.MAX_VIDEO_BYTES, 200 * 1024 * 1024),
  queueLightProcessingUrl:
    process.env.QUEUE_LIGHT_PROCESSING_URL ?? 'http://localhost:4566/000000000000/light-processing',
  uploadTtlSeconds: int(process.env.UPLOAD_URL_TTL_SECONDS, 900),
};

// content type -> asset kind. The worker re-checks real bytes (POC-009).
export const ALLOWED_CONTENT_TYPES: Record<string, 'IMAGE' | 'VIDEO'> = {
  'image/png': 'IMAGE',
  'image/jpeg': 'IMAGE',
  'image/webp': 'IMAGE',
  'video/mp4': 'VIDEO',
};

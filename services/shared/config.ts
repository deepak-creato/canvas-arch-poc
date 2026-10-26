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
  downloadTtlSeconds: int(process.env.DOWNLOAD_URL_TTL_SECONDS, 3600),
  queueAiRequestsUrl: process.env.QUEUE_AI_REQUESTS_URL ?? 'http://localhost:4566/000000000000/ai-requests',
  sqsMaxReceiveCount: int(process.env.SQS_MAX_RECEIVE_COUNT, 3),
  bucketPublished: process.env.BUCKET_PUBLISHED ?? 'media-published-poc',
  queueTranscodeUrl: process.env.QUEUE_TRANSCODE_REQUESTS_URL ?? 'http://localhost:4566/000000000000/transcode-requests',
  queuePublishTasksUrl: process.env.QUEUE_PUBLISH_TASKS_URL ?? 'http://localhost:4566/000000000000/publish-tasks',
  publishStateMachineArn:
    process.env.PUBLISH_STATE_MACHINE_ARN ?? 'arn:aws:states:us-east-1:000000000000:stateMachine:canvas-publish',
  publishWaitSeconds: int(process.env.PUBLISH_WAIT_SECONDS, 2),
  publishMaxAssetPolls: int(process.env.PUBLISH_MAX_ASSET_POLLS, 30),
  publishCanvasTimeoutSeconds: int(process.env.PUBLISH_CANVAS_TIMEOUT_SECONDS, 900),
  publishTranscodeTimeoutSeconds: int(process.env.PUBLISH_TRANSCODE_TIMEOUT_SECONDS, 120),
  publishMaxAttempts: int(process.env.PUBLISH_MAX_ATTEMPTS, 5),
  workerTestHooks: process.env.WORKER_TEST_HOOKS === 'true',
  transcodeLatencyMs: int(process.env.MOCK_TRANSCODE_LATENCY_MS, 1500),
  transcodeFixturePath: process.env.TRANSCODE_FIXTURE_PATH ?? '/fixtures/sample.mp4',
  mockAiModelVersion: process.env.MOCK_AI_MODEL_VERSION ?? 'mock-layout-v1',
  uploadTtlSeconds: int(process.env.UPLOAD_URL_TTL_SECONDS, 900),
  maxDocumentBytes: int(process.env.MAX_DOCUMENT_BYTES, 2 * 1024 * 1024),
  draftPurgeGraceDays: int(process.env.DRAFT_PURGE_GRACE_DAYS, 30),
};

// content type -> asset kind. The worker re-checks real bytes (POC-009).
export const ALLOWED_CONTENT_TYPES: Record<string, 'IMAGE' | 'VIDEO'> = {
  'image/png': 'IMAGE',
  'image/jpeg': 'IMAGE',
  'image/webp': 'IMAGE',
  'video/mp4': 'VIDEO',
};

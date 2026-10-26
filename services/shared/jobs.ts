import { PoolClient } from 'pg';

// Validation job for an uploaded asset. The unique idempotency key makes the API
// "complete" call and the S3 event converge on one job, whichever arrives first.
export const validateJobKey = (assetId: string) => `validate:${assetId}`;

export async function ensureValidateJob(
  db: Pick<PoolClient, 'query'>,
  asset: { id: string; bucket: string; key: string },
): Promise<void> {
  await db.query(
    `INSERT INTO processing_job (job_type, idempotency_key, asset_id, payload)
     VALUES ('validate', $1, $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [validateJobKey(asset.id), asset.id, JSON.stringify({ bucket: asset.bucket, key: asset.key })],
  );
}

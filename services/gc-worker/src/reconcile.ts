import { DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { config } from '../../shared/config';
import { confirmUpload, UPLOAD_ASSET_COLUMNS, UploadAssetRow } from '../../shared/confirm-upload';
import { log } from '../../shared/log';
import { syntheticObjectCreated } from './jobs';
import { GcOptions } from './options';

const isNotFound = (e: any) => e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
const exists = async (s3: S3Client, Bucket: string, Key: string) => {
  try {
    await s3.send(new HeadObjectCommand({ Bucket, Key }));
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
};

export interface UploadReconcile {
  /** object was there, event missed: upload confirmed and processing restarted */
  recovered: string[];
  /** object there but size/type differ from the reservation */
  rejected: string[];
  /** no object (yet): left for the expiry step */
  waiting: string[];
}

/**
 * Stuck PENDING_UPLOAD: the client uploaded but the S3 event never reached the light-worker and the
 * client never called "complete". Looks at the bucket, confirms through the same code path as the API
 * and the event consumer, and sends the event the rule should have sent. Runs before expireUploads so
 * a late but real upload is not thrown away.
 */
export async function reconcileUploads(pool: Pool, s3: S3Client, sqs: SQSClient, o: GcOptions): Promise<UploadReconcile> {
  const out: UploadReconcile = { recovered: [], rejected: [], waiting: [] };
  const rows = (
    await pool.query<UploadAssetRow>(
      `SELECT ${UPLOAD_ASSET_COLUMNS} FROM media_asset
        WHERE upload_status = 'PENDING_UPLOAD' AND retention_status NOT IN ('DELETING', 'DELETED')
          AND created_at <= now() - make_interval(secs => $1)
          AND upload_expires_at > now() - make_interval(secs => $2)
          AND ($3::text IS NULL OR owner_id = $3)
        ORDER BY created_at LIMIT $4`,
      [o.reconcileAfterSeconds, o.uploadExpiryGraceSeconds, o.ownerId ?? null, o.batchSize],
    )
  ).rows;
  for (const a of rows) {
    if (!(await exists(s3, a.original_bucket, a.original_key))) {
      out.waiting.push(a.id);
      continue;
    }
    const r = await confirmUpload(pool, s3, a, `gc-reconcile-${a.id}`, { ignoreExpiry: true });
    if (r.ok) {
      await sqs.send(new SendMessageCommand({ QueueUrl: config.queueLightProcessingUrl, MessageBody: syntheticObjectCreated(a.original_bucket, a.original_key) }));
      log('warn', 'missed upload event recovered', { asset_id: a.id });
      out.recovered.push(a.id);
    } else if (r.code === 'SIZE_MISMATCH' || r.code === 'CONTENT_TYPE_MISMATCH') {
      await pool.query(`UPDATE media_asset SET upload_status = 'REJECTED', reject_reason = $2 WHERE id = $1 AND upload_status = 'PENDING_UPLOAD'`, [a.id, r.code]);
      log('warn', 'stuck upload rejected', { asset_id: a.id, reason: r.code });
      out.rejected.push(a.id);
    } else {
      out.waiting.push(a.id);
    }
  }
  return out;
}

export interface DriftReport {
  /** VALIDATED asset whose original is gone. Not repairable here: reported only. */
  missing_originals: string[];
  /** READY rendition whose object is gone: marked FAILED/OBJECT_MISSING; draft tier is rebuilt */
  missing_renditions: string[];
  rebuilt_assets: string[];
}

/**
 * DB says the object exists, storage disagrees. Draft-tier renditions are cheap to rebuild: the row is
 * marked FAILED, the derive job reset, and the event re-sent (the worker's HEAD-before-work then
 * regenerates exactly the missing keys). Finals and originals are reported; fixing those needs a
 * publication retry or a re-upload, which are decisions for a person.
 */
export async function reconcileDrift(pool: Pool, s3: S3Client, sqs: SQSClient, o: GcOptions): Promise<DriftReport> {
  const out: DriftReport = { missing_originals: [], missing_renditions: [], rebuilt_assets: [] };
  const active = `a.retention_status IN ('UNATTACHED', 'REFERENCED', 'PUBLISHED', 'ORPHANED') AND ($1::text IS NULL OR a.owner_id = $1)`;

  const originals = (
    await pool.query<{ id: string; original_bucket: string; original_key: string }>(
      `SELECT a.id, a.original_bucket, a.original_key FROM media_asset a
        WHERE a.upload_status = 'VALIDATED' AND ${active} ORDER BY random() LIMIT $2`,
      [o.ownerId ?? null, o.batchSize],
    )
  ).rows;
  for (const a of originals) {
    if (!(await exists(s3, a.original_bucket, a.original_key))) {
      log('error', 'original object missing', { asset_id: a.id });
      out.missing_originals.push(a.id);
    }
  }

  const renditions = (
    await pool.query<{ id: string; asset_id: string; bucket: string; s3_key: string; tier: string; original_bucket: string; original_key: string; upload_status: string }>(
      `SELECT r.id, r.asset_id, r.bucket, r.s3_key, r.tier, a.original_bucket, a.original_key, a.upload_status
         FROM media_rendition r JOIN media_asset a ON a.id = r.asset_id
        WHERE r.status = 'READY' AND ${active} ORDER BY random() LIMIT $2`,
      [o.ownerId ?? null, o.batchSize],
    )
  ).rows;
  const rebuild = new Map<string, { bucket: string; key: string }>();
  for (const r of renditions) {
    if (await exists(s3, r.bucket, r.s3_key)) continue;
    await pool.query(`UPDATE media_rendition SET status = 'FAILED', error = 'OBJECT_MISSING' WHERE id = $1 AND status = 'READY'`, [r.id]);
    log('error', 'rendition object missing', { asset_id: r.asset_id, rendition_id: r.id, tier: r.tier });
    out.missing_renditions.push(r.id);
    if (r.tier === 'DRAFT' && r.upload_status === 'VALIDATED') rebuild.set(r.asset_id, { bucket: r.original_bucket, key: r.original_key });
  }
  for (const [assetId, obj] of rebuild) {
    // Only when the original is still there; otherwise the rebuild would just fail again.
    if (out.missing_originals.includes(assetId) || !(await exists(s3, obj.bucket, obj.key))) continue;
    await pool.query(
      `UPDATE processing_job SET status = 'QUEUED', attempts = 0, available_at = now(), lease_owner = NULL, lease_expires_at = NULL, completed_at = NULL
        WHERE asset_id = $1 AND job_type IN ('image-derive', 'video-derive')`,
      [assetId],
    );
    await sqs.send(new SendMessageCommand({ QueueUrl: config.queueLightProcessingUrl, MessageBody: syntheticObjectCreated(obj.bucket, obj.key) }));
    out.rebuilt_assets.push(assetId);
  }
  return out;
}

export interface Stray {
  bucket: string;
  key: string;
  age_seconds: number;
  reason: 'NO_ASSET' | 'ASSET_DELETED';
  deleted: boolean;
}

const UUID_SEGMENT = /^(?:derived|final)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;

/** Why nothing in the database owns this object, or null when something does. Always asks the DB fresh. */
async function strayReason(pool: Pool, bucket: string, key: string): Promise<Stray['reason'] | null> {
  if (bucket === config.bucketIngest) {
    const a = (await pool.query(`SELECT retention_status FROM media_asset WHERE original_bucket = $1 AND original_key = $2`, [bucket, key])).rows[0];
    if (!a) return 'NO_ASSET';
    return a.retention_status === 'DELETED' ? 'ASSET_DELETED' : null;
  }
  const id = UUID_SEGMENT.exec(key)?.[1];
  if (!id) return null; // not a key this system writes: never touch
  const a = (await pool.query(`SELECT retention_status FROM media_asset WHERE id = $1`, [id.toLowerCase()])).rows[0];
  if (!a) return 'NO_ASSET';
  // A live asset's unrecorded object is a crashed worker's output; the retry reuses it.
  return a.retention_status === 'DELETED' ? 'ASSET_DELETED' : null;
}

/**
 * Objects the database knows nothing about. Always reported. Deleted only when `deleteStrays` is on,
 * the object is older than the stray grace (an upload may be in flight), and a fresh DB lookup right
 * before the delete still finds no owner. Scans at most `batchSize * 20` keys per prefix per run.
 */
export async function reconcileStrays(pool: Pool, s3: S3Client, o: GcOptions): Promise<Stray[]> {
  const prefixes: [string, string][] =
    o.strayPrefixes ?? [
      [config.bucketIngest, o.ownerId ? `${config.stagingPrefix}${o.ownerId}/` : config.stagingPrefix],
      [config.bucketDerived, 'derived/'],
      [config.bucketDerived, 'final/'],
    ];
  const out: Stray[] = [];
  for (const [bucket, prefix] of prefixes) {
    let token: string | undefined;
    let scanned = 0;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
      for (const obj of page.Contents ?? []) {
        scanned++;
        if (!obj.Key) continue;
        const age = obj.LastModified ? (Date.now() - obj.LastModified.getTime()) / 1000 : 0;
        if (age < o.strayGraceSeconds) continue;
        const reason = await strayReason(pool, bucket, obj.Key);
        if (!reason) continue;
        const stray: Stray = { bucket, key: obj.Key, age_seconds: Math.round(age), reason, deleted: false };
        if (o.deleteStrays && (await strayReason(pool, bucket, obj.Key))) {
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
          stray.deleted = true;
        }
        log(stray.deleted ? 'warn' : 'info', stray.deleted ? 'stray object deleted' : 'stray object found', { bucket, key: obj.Key, reason });
        out.push(stray);
      }
      token = page.IsTruncated && scanned < o.batchSize * 20 ? page.NextContinuationToken : undefined;
    } while (token);
  }
  return out;
}

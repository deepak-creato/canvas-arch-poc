import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { Pool } from 'pg';
import { config } from '../../shared/config';
import { claimJob, failJob, PermanentError, succeedJob, withHeartbeat } from '../../shared/job-repo';
import { validateJobKey } from '../../shared/jobs';
import { log } from '../../shared/log';
import { injectFailure } from './fail-injection';
import { CorruptError, probeImage, probeVideo, saveAndHash, sniffType, TooLargeError } from './inspect';

interface Asset {
  id: string;
  kind: 'IMAGE' | 'VIDEO';
  upload_status: string;
  original_bucket: string;
  original_key: string;
  content_type: string;
  client_sha256: string;
}

// done: nothing more to do for this message. busy: another worker holds the job, retry later.
export type ValidateOutcome = 'done' | 'busy' | 'failed';

const LEASE_SECONDS = 120;
const WORKER_ID = `light-worker-${process.pid}`;

/** Why an upload is rejected. Stored in media_asset.reject_reason. */
export type RejectReason = 'FILE_TOO_LARGE' | 'HASH_MISMATCH' | 'TYPE_MISMATCH' | 'CORRUPT_FILE';

export async function rejectAsset(pool: Pool, assetId: string, reason: string, from = 'UPLOADED') {
  await pool.query(
    `UPDATE media_asset SET upload_status = 'REJECTED', reject_reason = $2 WHERE id = $1 AND upload_status = $3`,
    [assetId, reason, from],
  );
}

export async function validateAsset(pool: Pool, s3: S3Client, assetId: string, correlationId: string): Promise<ValidateOutcome> {
  const ctx = { asset_id: assetId, correlation_id: correlationId };
  const a = (
    await pool.query<Asset>(
      `SELECT id, kind, upload_status, original_bucket, original_key, content_type, client_sha256
         FROM media_asset WHERE id = $1`,
      [assetId],
    )
  ).rows[0];
  if (!a || a.upload_status !== 'UPLOADED') return 'done'; // already VALIDATED or REJECTED

  const claim = await claimJob(pool, validateJobKey(a.id), WORKER_ID, LEASE_SECONDS);
  if (!claim.claimed) return claim.reason === 'busy' ? 'busy' : claim.reason === 'failed' ? 'failed' : 'done';
  const ctxJ = { ...ctx, job_id: claim.job.id };

  const dir = await mkdtemp(join(tmpdir(), 'validate-'));
  try {
    injectFailure(claim.job);
    const verdict = await withHeartbeat(pool, claim.job.id, WORKER_ID, LEASE_SECONDS, () => inspectAsset(s3, a, join(dir, 'source')));
    if (verdict.ok) {
      await pool.query(
        `UPDATE media_asset
            SET upload_status = 'VALIDATED', server_sha256 = $2, size_bytes = $3,
                metadata = metadata || $4::jsonb
          WHERE id = $1 AND upload_status = 'UPLOADED'`,
        [a.id, verdict.sha256, verdict.size, JSON.stringify(verdict.metadata)],
      );
      log('info', 'asset validated', ctxJ);
    } else {
      await rejectAsset(pool, a.id, verdict.reason);
      log('warn', 'asset rejected', { ...ctxJ, reason: verdict.reason, detail: verdict.detail });
    }
    // A rejection is a successful validation outcome, so the job succeeds either way.
    await succeedJob(pool, claim.job.id);
    return 'done';
  } catch (e) {
    await failJob(pool, claim.job, String(e), e instanceof PermanentError);
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Verdict =
  | { ok: true; sha256: string; size: number; metadata: Record<string, unknown> }
  | { ok: false; reason: RejectReason; detail?: string };

async function inspectAsset(s3: S3Client, a: Asset, file: string): Promise<Verdict> {
  const max = a.kind === 'IMAGE' ? config.maxImageBytes : config.maxVideoBytes;
  const obj = await s3.send(new GetObjectCommand({ Bucket: a.original_bucket, Key: a.original_key }));

  let hashed;
  try {
    hashed = await saveAndHash(obj.Body as Readable, file, max);
  } catch (e) {
    if (e instanceof TooLargeError) return { ok: false, reason: 'FILE_TOO_LARGE', detail: e.message };
    throw e;
  }
  // Order matters: the hash check catches a lying client even when the bytes are a valid file.
  if (hashed.sha256 !== a.client_sha256) {
    return { ok: false, reason: 'HASH_MISMATCH', detail: `client ${a.client_sha256} server ${hashed.sha256}` };
  }

  const real = await sniffType(file);
  if (real !== a.content_type) {
    return { ok: false, reason: 'TYPE_MISMATCH', detail: `declared ${a.content_type} actual ${real ?? 'unknown'}` };
  }

  try {
    const metadata = a.kind === 'IMAGE' ? await probeImage(file) : await probeVideo(file);
    return { ok: true, sha256: hashed.sha256, size: hashed.size, metadata };
  } catch (e) {
    if (e instanceof CorruptError) return { ok: false, reason: 'CORRUPT_FILE', detail: e.message };
    throw e;
  }
}

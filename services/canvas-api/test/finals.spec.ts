// Integration test: needs the compose stack (make up). Talks to Postgres and LocalStack S3 directly.
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomBytes, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { config } from '../../shared/config';
import { planFinals } from '../../shared/final-renditions';
import { finalVideoKey, transcodeJobKey } from '../../shared/keys';
import { createS3 } from '../../shared/s3';

const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
const s3 = createS3();
const owner = `fin-${randomBytes(4).toString('hex')}`;

async function asset(kind: 'VIDEO' | 'IMAGE' = 'VIDEO') {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO media_asset (id, owner_id, kind, client_sha256, content_type, original_bucket, original_key, upload_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'VALIDATED')`,
    [id, owner, kind, randomBytes(32).toString('hex'), kind === 'VIDEO' ? 'video/mp4' : 'image/png', config.bucketIngest, `staging/${owner}/${id}/source`],
  );
  return id;
}
const put = (key: string) => s3.send(new PutObjectCommand({ Bucket: config.bucketDerived, Key: key, Body: 'x' }));
const status = async (id: string) =>
  (await pool.query(`SELECT status FROM media_rendition WHERE asset_id = $1 AND tier = 'FINAL'`, [id])).rows[0]?.status;

afterAll(() => pool.end());

describe('final rendition planning (POC-024)', () => {
  it('creates one deterministic FINAL row per video and ignores images', async () => {
    const v = await asset();
    const img = await asset('IMAGE');
    const plan = await planFinals(pool, s3, [v, img]);
    expect(plan.missing).toHaveLength(1);
    expect(plan.missing[0]).toMatchObject({ asset_id: v, bucket: config.bucketDerived, key: finalVideoKey(v) });
    expect(plan.reused).toEqual([]);
    expect(await status(v)).toBe('QUEUED');
    expect(await status(img)).toBeUndefined();

    // Planning again adds no rows and returns the same row.
    const again = await planFinals(pool, s3, [v]);
    expect(again.missing[0].rendition_id).toBe(plan.missing[0].rendition_id);
    expect((await pool.query(`SELECT count(*)::int n FROM media_rendition WHERE asset_id = $1`, [v])).rows[0].n).toBe(1);
  });

  it('reuses a READY output whose object exists, and produces it again when the object is gone', async () => {
    const v = await asset();
    const first = await planFinals(pool, s3, [v]);
    await put(first.missing[0].key);
    await pool.query(`UPDATE media_rendition SET status = 'READY' WHERE id = $1`, [first.missing[0].rendition_id]);

    const reuse = await planFinals(pool, s3, [v]);
    expect(reuse.missing).toEqual([]);
    expect(reuse.reused.map((r) => r.asset_id)).toEqual([v]);
    expect(await status(v)).toBe('READY');

    await s3.send(new DeleteObjectCommand({ Bucket: config.bucketDerived, Key: first.missing[0].key }));
    const redo = await planFinals(pool, s3, [v]);
    expect(redo.missing.map((r) => r.asset_id)).toEqual([v]);
    expect(await status(v)).toBe('QUEUED');
  });

  it('keeps failed outputs failed unless a retry asks for a reset, then requeues only those', async () => {
    const ok = await asset();
    const bad = await asset();
    const p = await planFinals(pool, s3, [ok, bad]);
    const okRow = p.missing.find((m) => m.asset_id === ok)!;
    await put(okRow.key);
    await pool.query(`UPDATE media_rendition SET status = 'READY' WHERE id = $1`, [okRow.rendition_id]);
    await pool.query(`UPDATE media_rendition SET status = 'FAILED_PERMANENT', error = 'boom' WHERE asset_id = $1 AND tier = 'FINAL'`, [bad]);
    await pool.query(
      `INSERT INTO processing_job (job_type, idempotency_key, asset_id, status, attempts, last_error)
       VALUES ('final-transcode', $1, $2, 'FAILED_PERMANENT', 3, 'boom')`,
      [transcodeJobKey(bad), bad],
    );

    const noReset = await planFinals(pool, s3, [ok, bad]);
    expect(noReset.failed.map((f) => f.asset_id)).toEqual([bad]);
    expect(noReset.reused.map((f) => f.asset_id)).toEqual([ok]);
    expect(noReset.missing).toEqual([]);

    const retry = await planFinals(pool, s3, [ok, bad], { resetFailed: true });
    expect(retry.missing.map((f) => f.asset_id)).toEqual([bad]);
    expect(retry.reused.map((f) => f.asset_id)).toEqual([ok]);
    expect(await status(bad)).toBe('QUEUED');
    const job = (await pool.query(`SELECT status, attempts, last_error FROM processing_job WHERE idempotency_key = $1`, [transcodeJobKey(bad)])).rows[0];
    expect(job).toEqual({ status: 'QUEUED', attempts: 0, last_error: null });
  });
});

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { config } from '../../shared/config';
import { addRevisionReferences, recalcRetention } from '../../shared/refs';
import { createS3 } from '../../shared/s3';
import { createSqs } from '../../shared/sqs';
import { sweep } from '../src/sweep';
import { api, asset, docWith, draftWith, newOwner, opts, pool, seedAsset } from './helpers';

const s3 = createS3();
afterAll(() => pool.end());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const orphan = async (owner: string) => {
  const a = await seedAsset({ owner, retention_status: 'ORPHANED' });
  await pool.query(`UPDATE media_asset SET orphaned_at = now() - interval '1 hour' WHERE id = $1`, [a.id]);
  return a;
};
const job = (assetId: string, status: string, over: { lease?: string; attempts?: number; updated?: string } = {}) =>
  pool.query(
    `INSERT INTO processing_job (job_type, idempotency_key, asset_id, status, attempts, lease_expires_at, updated_at)
     VALUES ('derive', $1, $2, $3, $4, ${over.lease ?? 'NULL'}, ${over.updated ?? 'now()'})`,
    [`t:${assetId}:${status}`, assetId, status, over.attempts ?? 1],
  );

describe('GC skips assets with work in progress (POC-034)', () => {
  it.each([
    ['RUNNING with a live lease', 'RUNNING', { lease: "now() + interval '5 minutes'" }, false],
    ['QUEUED and recent', 'QUEUED', { attempts: 0 }, false],
    ['FAILED with attempts left, recent', 'FAILED', { attempts: 1 }, false],
    ['RUNNING with an expired lease', 'RUNNING', { lease: "now() - interval '1 minute'" }, true],
    ['QUEUED but untouched for hours (lost message)', 'QUEUED', { attempts: 0, updated: "now() - interval '5 hours'" }, true],
    ['FAILED with attempts used up', 'FAILED', { attempts: 3 }, true],
    ['FAILED_PERMANENT', 'FAILED_PERMANENT', { attempts: 3 }, true],
    ['SUCCEEDED', 'SUCCEEDED', { attempts: 1 }, true],
  ])('%s', async (_name, status, over, deleted) => {
    const owner = newOwner();
    const a = await orphan(owner);
    await job(a.id, status, over);
    await sweep(pool, s3, opts(owner));
    expect((await asset(a.id)).retention_status).toBe(deleted ? 'DELETED' : 'ORPHANED');
  });

  it('deletes once the job finishes', async () => {
    const owner = newOwner();
    const a = await orphan(owner);
    await job(a.id, 'RUNNING', { lease: "now() + interval '5 minutes'" });
    expect((await sweep(pool, s3, opts(owner))).skipped).toEqual([a.id]);
    await pool.query(`UPDATE processing_job SET status = 'SUCCEEDED' WHERE asset_id = $1`, [a.id]);
    expect((await sweep(pool, s3, opts(owner))).deleted).toEqual([a.id]);
  });
});

describe('GC versus a concurrent save (POC-034)', () => {
  it('a save holding the asset lock wins: the asset is skipped, then becomes REFERENCED', async () => {
    const owner = newOwner();
    const a = await orphan(owner);
    const d = await draftWith(owner);
    const rev = (await pool.query(`SELECT id FROM canvas_revision WHERE draft_id = $1`, [d])).rows[0].id;

    const save = await pool.connect();
    try {
      await save.query('BEGIN');
      // What the save transaction does first: lock the asset, add the reference.
      await addRevisionReferences(save, owner, rev, [a.id]);
      const mid = await sweep(pool, s3, opts(owner));
      expect(mid.claimed).toEqual([]);
      await recalcRetention(save, [a.id]);
      await save.query('COMMIT');
    } finally {
      save.release();
    }
    expect(await asset(a.id)).toMatchObject({ retention_status: 'REFERENCED', ref_count: 1 });
    const after = await sweep(pool, s3, opts(owner));
    expect(after).toEqual({ claimed: [], deleted: [], failed: [], skipped: [] });
  });

  it('a save that commits first is seen by the claim re-check', async () => {
    const owner = newOwner();
    const a = await orphan(owner);
    const d = await draftWith(owner);
    // Reference committed but counters not yet recomputed: still shows ORPHANED.
    const rev = (await pool.query(`SELECT id FROM canvas_revision WHERE draft_id = $1`, [d])).rows[0].id;
    await pool.query(`INSERT INTO media_reference (asset_id, revision_id) VALUES ($1, $2)`, [a.id, rev]);
    const r = await sweep(pool, s3, opts(owner));
    expect(r.deleted).toEqual([]);
    expect((await asset(a.id)).retention_status).toBe('REFERENCED');
  });

  it('save and sweep racing: never a live reference to a deleted asset', async () => {
    const owner = newOwner();
    const outcomes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const a = await orphan(owner);
      const key = `derived/${a.id}/thumbnail/v1/race.webp`;
      await s3.send(new PutObjectCommand({ Bucket: config.bucketDerived, Key: key, Body: 'x' }));
      const d = await draftWith(owner);
      const [save] = await Promise.all([api(owner, 'PUT', `/v1/drafts/${d}`, { base_revision: 1, document: docWith(a.id) }), sweep(pool, s3, opts(owner))]);
      const row = await asset(a.id);
      if (save.status === 200) {
        expect(row.retention_status).toBe('REFERENCED');
        outcomes.push('saved');
      } else {
        expect(save.body.code).toBe('ASSET_NOT_REFERENCEABLE');
        expect(['DELETING', 'DELETED']).toContain(row.retention_status);
        outcomes.push('deleted');
      }
      const refs = (await pool.query(`SELECT count(*)::int AS n FROM media_reference WHERE asset_id = $1`, [a.id])).rows[0].n;
      expect(refs).toBe(save.status === 200 ? 1 : 0);
    }
    expect(outcomes).toHaveLength(8);
  });

  it('restoring an old revision re-references through the normal path; GC leaves the asset alone', async () => {
    const owner = newOwner();
    const a = await seedAsset({ owner });
    const d = await draftWith(owner, docWith(a.id), docWith()); // rev 2 uses a, rev 3 empty
    expect(await asset(a.id)).toMatchObject({ retention_status: 'REFERENCED' });
    const r = await api(owner, 'POST', `/v1/drafts/${d}/revisions/2/restore`);
    expect(r.status).toBe(200);
    expect((await sweep(pool, s3, opts(owner))).claimed).toEqual([]);
    expect((await asset(a.id)).ref_count).toBe(2);
  });
});

describe('light-worker ignores events for deleted assets (POC-034)', () => {
  it('does not confirm or process an upload of a DELETING asset', async () => {
    const owner = newOwner();
    const a = await seedAsset({ owner, upload_status: 'PENDING_UPLOAD', retention_status: 'DELETING', size_bytes: 1, content_type: 'image/png' });
    await s3.send(new PutObjectCommand({ Bucket: config.bucketIngest, Key: a.key, Body: 'x', ContentType: 'image/png' }));
    await createSqs().send(
      new SendMessageCommand({
        QueueUrl: config.queueLightProcessingUrl,
        MessageBody: JSON.stringify({ 'detail-type': 'Object Created', detail: { bucket: { name: config.bucketIngest }, object: { key: a.key } } }),
      }),
    );
    await sleep(4000);
    expect((await asset(a.id)).upload_status).toBe('PENDING_UPLOAD');
    expect((await pool.query(`SELECT count(*)::int AS n FROM processing_job WHERE asset_id = $1`, [a.id])).rows[0].n).toBe(0);
  });
});

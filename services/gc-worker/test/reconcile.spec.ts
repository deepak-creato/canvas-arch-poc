import { PutObjectCommand } from '@aws-sdk/client-s3';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { config } from '../../shared/config';
import { createS3 } from '../../shared/s3';
import { createSqs } from '../../shared/sqs';
import { syntheticObjectCreated } from '../src/jobs';
import { reconcileDrift, reconcileStrays, reconcileUploads } from '../src/reconcile';
import { expireUploads } from '../src/expire';
import { asset, newOwner, objectExists, opts, pool, seedAsset, seedUploadedFixture } from './helpers';

const s3 = createS3();
const sqs = createSqs();
afterAll(() => pool.end());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 45000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(500);
    v = await fn();
  }
  return v;
}
const FIXTURE = readFileSync(resolve(__dirname, '../../../fixtures/sample-5.jpg'));
const past = (ms: number) => new Date(Date.now() - ms).toISOString();

/**
 * The client uploaded but nobody heard of it. The S3 event fires on PUT; it is dropped by the
 * light-worker because no row exists yet, which is the same outcome as a lost event. The row
 * is inserted afterwards.
 */
async function missedUpload(owner: string, over: { size?: number; expires?: string } = {}) {
  const id = randomUUID();
  const key = `${config.stagingPrefix}${owner}/${id}/source`;
  await s3.send(new PutObjectCommand({ Bucket: config.bucketIngest, Key: key, Body: FIXTURE, ContentType: 'image/jpeg' }));
  await sleep(3000);
  await seedAsset({
    id, key, owner, upload_status: 'PENDING_UPLOAD', content_type: 'image/jpeg', size_bytes: over.size ?? FIXTURE.length,
    sha256: createHash('sha256').update(FIXTURE).digest('hex'), upload_expires_at: over.expires,
  });
  return { id, key };
}

describe('stuck PENDING_UPLOAD (POC-036)', () => {
  it('finds the object, confirms the upload and the light-worker finishes it', async () => {
    const owner = newOwner();
    const a = await missedUpload(owner);
    expect((await asset(a.id)).upload_status).toBe('PENDING_UPLOAD');

    // Not old enough to be suspicious yet.
    expect((await reconcileUploads(pool, s3, sqs, opts(owner, { reconcileAfterSeconds: 3600 }))).recovered).toEqual([]);
    const r = await reconcileUploads(pool, s3, sqs, opts(owner));
    expect(r.recovered).toEqual([a.id]);
    expect(await until(async () => (await asset(a.id)).upload_status, (s) => s === 'VALIDATED')).toBe('VALIDATED');
  });

  it('rescues an upload whose reservation lapsed a moment ago, but not one past the expiry grace', async () => {
    const owner = newOwner();
    const late = await missedUpload(owner, { expires: past(60_000) });
    const r = await reconcileUploads(pool, s3, sqs, opts(owner, { uploadExpiryGraceSeconds: 600 }));
    expect(r.recovered).toEqual([late.id]);

    // Same bytes, so another owner (dedup is per owner).
    const owner2 = newOwner();
    const gone = await missedUpload(owner2, { expires: past(3_600_000) });
    const r2 = await reconcileUploads(pool, s3, sqs, opts(owner2, { uploadExpiryGraceSeconds: 600 }));
    expect(r2.recovered).toEqual([]);
    expect(await expireUploads(pool, opts(owner2, { uploadExpiryGraceSeconds: 600 }))).toEqual([gone.id]);
  });

  it('rejects an object that does not match the reservation, and waits when there is no object', async () => {
    const owner = newOwner();
    const wrong = await missedUpload(owner, { size: FIXTURE.length + 7 });
    const none = await seedAsset({ owner, upload_status: 'PENDING_UPLOAD' });
    const r = await reconcileUploads(pool, s3, sqs, opts(owner));
    expect(r.rejected).toEqual([wrong.id]);
    expect(r.waiting).toEqual([none.id]);
    expect(await asset(wrong.id)).toMatchObject({ upload_status: 'REJECTED' });
    expect((await pool.query(`SELECT reject_reason FROM media_asset WHERE id = $1`, [wrong.id])).rows[0].reject_reason).toBe('SIZE_MISMATCH');
    expect((await asset(none.id)).upload_status).toBe('PENDING_UPLOAD');
  });
});

describe('DB / object-storage drift (POC-036)', () => {
  const processed = async (owner: string) => {
    const a = await seedUploadedFixture(owner);
    await sqs.send(new SendMessageCommand({ QueueUrl: config.queueLightProcessingUrl, MessageBody: syntheticObjectCreated(config.bucketIngest, a.key) }));
    const ready = () => pool.query(`SELECT s3_key FROM media_rendition WHERE asset_id = $1 AND status = 'READY' ORDER BY kind`, [a.id]).then((r) => r.rows.map((x) => x.s3_key as string));
    const keys = await until(ready, (k) => k.length === 2);
    expect(keys).toHaveLength(2);
    return { ...a, keys };
  };

  it('rebuilds a draft rendition whose object vanished', async () => {
    const owner = newOwner();
    const a = await processed(owner);
    const lost = a.keys[0];
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await s3.send(new DeleteObjectCommand({ Bucket: config.bucketDerived, Key: lost }));

    const d = await reconcileDrift(pool, s3, sqs, opts(owner));
    expect(d.missing_renditions).toHaveLength(1);
    expect(d.rebuilt_assets).toEqual([a.id]);
    expect(d.missing_originals).toEqual([]);

    const status = () => pool.query(`SELECT status FROM media_rendition WHERE asset_id = $1 AND s3_key = $2`, [a.id, lost]).then((r) => r.rows[0].status as string);
    expect(await until(status, (s) => s === 'READY')).toBe('READY');
    expect(await objectExists(config.bucketDerived, lost)).toBe(true);
    // Healthy now: nothing to report.
    expect(await reconcileDrift(pool, s3, sqs, opts(owner))).toEqual({ missing_originals: [], missing_renditions: [], rebuilt_assets: [] });
  });

  it('reports a missing original and does not pretend to fix it', async () => {
    const owner = newOwner();
    const a = await processed(owner);
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await s3.send(new DeleteObjectCommand({ Bucket: config.bucketIngest, Key: a.key }));
    await s3.send(new DeleteObjectCommand({ Bucket: config.bucketDerived, Key: a.keys[0] }));

    const d = await reconcileDrift(pool, s3, sqs, opts(owner));
    expect(d.missing_originals).toEqual([a.id]);
    expect(d.missing_renditions).toHaveLength(1);
    expect(d.rebuilt_assets).toEqual([]); // no original, nothing to rebuild from
    expect((await asset(a.id)).upload_status).toBe('VALIDATED');
  });
});

describe('stray objects (POC-036)', () => {
  const put = (bucket: string, Key: string) => s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: 'x' }));

  async function scene() {
    const owner = newOwner();
    const noAsset = randomUUID();
    const liveId = randomUUID();
    const live = await seedAsset({ id: liveId, owner, key: `${config.stagingPrefix}${owner}/${liveId}/source` });
    const dead = await seedAsset({ owner, retention_status: 'DELETED' });
    const keys = {
      derivedStray: `derived/${noAsset}/thumbnail/v1/a.webp`,
      finalStray: `final/${noAsset}/video/v1/a.mp4`,
      deadAssetObject: `derived/${dead.id}/thumbnail/v1/a.webp`,
      ingestStray: `${config.stagingPrefix}${owner}/${randomUUID()}/source`,
      liveUnrecorded: `derived/${live.id}/sprite/v1/unrecorded.jpg`, // a crashed worker's output: its retry reuses it
      foreign: `derived/${randomUUID()}-notes.txt`, // not a key this system writes
    };
    await put(config.bucketDerived, keys.derivedStray);
    await put(config.bucketDerived, keys.finalStray);
    await put(config.bucketDerived, keys.deadAssetObject);
    await put(config.bucketDerived, keys.liveUnrecorded);
    await put(config.bucketDerived, keys.foreign);
    await put(config.bucketIngest, keys.ingestStray);
    await put(config.bucketIngest, live.key);
    const prefixes: [string, string][] = [
      [config.bucketDerived, `derived/${noAsset}/`],
      [config.bucketDerived, `final/${noAsset}/`],
      [config.bucketDerived, `derived/${dead.id}/`],
      [config.bucketDerived, `derived/${live.id}/`],
      [config.bucketDerived, keys.foreign],
      [config.bucketIngest, `${config.stagingPrefix}${owner}/`],
    ];
    return { owner, keys, live, prefixes };
  }

  it('reports strays and deletes nothing by default', async () => {
    const s = await scene();
    const found = await reconcileStrays(pool, s3, opts(s.owner, { strayPrefixes: s.prefixes }));
    expect(found.map((f) => f.key).sort()).toEqual([s.keys.derivedStray, s.keys.finalStray, s.keys.deadAssetObject, s.keys.ingestStray].sort());
    expect(found.every((f) => !f.deleted)).toBe(true);
    expect(found.find((f) => f.key === s.keys.deadAssetObject)!.reason).toBe('ASSET_DELETED');
    for (const k of Object.values(s.keys)) expect(await objectExists(k.startsWith(config.stagingPrefix) ? config.bucketIngest : config.bucketDerived, k)).toBe(true);
  });

  it('leaves young objects alone, then deletes only true strays when enabled', async () => {
    const s = await scene();
    const young = await reconcileStrays(pool, s3, opts(s.owner, { strayPrefixes: s.prefixes, deleteStrays: true, strayGraceSeconds: 3600 }));
    expect(young).toEqual([]);

    const found = await reconcileStrays(pool, s3, opts(s.owner, { strayPrefixes: s.prefixes, deleteStrays: true }));
    expect(found).toHaveLength(4);
    expect(found.every((f) => f.deleted)).toBe(true);
    expect(await objectExists(config.bucketDerived, s.keys.derivedStray)).toBe(false);
    expect(await objectExists(config.bucketDerived, s.keys.finalStray)).toBe(false);
    expect(await objectExists(config.bucketDerived, s.keys.deadAssetObject)).toBe(false);
    expect(await objectExists(config.bucketIngest, s.keys.ingestStray)).toBe(false);
    // Owned or unrecognised: untouched.
    expect(await objectExists(config.bucketIngest, s.live.key)).toBe(true);
    expect(await objectExists(config.bucketDerived, s.keys.liveUnrecorded)).toBe(true);
    expect(await objectExists(config.bucketDerived, s.keys.foreign)).toBe(true);
  });
});

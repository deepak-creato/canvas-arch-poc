import { HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../../shared/config';
import { createS3 } from '../../shared/s3';
import { sweep } from '../src/sweep';
import { api, asset, docWith, draftWith, newOwner, opts, pool, seedAsset } from './helpers';

const s3 = createS3();
afterAll(() => pool.end());

const put = (bucket: string, Key: string) => s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: 'x' }));
const exists = async (bucket: string, Key: string) => {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key }));
    return true;
  } catch {
    return false;
  }
};

/** An ORPHANED asset with an original, two recorded renditions and one unrecorded stray under its prefix. */
async function orphanWithObjects(owner: string, orphanedAt = "now() - interval '1 hour'") {
  const a = await seedAsset({ owner, retention_status: 'ORPHANED' });
  await pool.query(`UPDATE media_asset SET orphaned_at = ${orphanedAt} WHERE id = $1`, [a.id]);
  const keys = [`derived/${a.id}/thumbnail/v1/w320.webp`, `derived/${a.id}/preview/v1/w1280.webp`];
  for (const k of keys) {
    await pool.query(
      `INSERT INTO media_rendition (asset_id, kind, tier, bucket, s3_key, status) VALUES ($1, $2, 'DRAFT', $3, $4, 'READY')`,
      [a.id, k.split('/')[2], config.bucketDerived, k],
    );
    await put(config.bucketDerived, k);
  }
  const stray = `derived/${a.id}/sprite/v1/unrecorded.jpg`;
  await put(config.bucketDerived, stray);
  await put(config.bucketIngest, a.key);
  return { ...a, derived: [...keys, stray] };
}

describe('mark-and-sweep (POC-033)', () => {
  it('deletes original and every derived object, then writes the DELETED tombstone', async () => {
    const owner = newOwner();
    const a = await orphanWithObjects(owner);
    const r = await sweep(pool, s3, opts(owner));
    expect(r.claimed).toEqual([a.id]);
    expect(r.deleted).toEqual([a.id]);

    expect(await exists(config.bucketIngest, a.key)).toBe(false);
    for (const k of a.derived) expect(await exists(config.bucketDerived, k)).toBe(false);
    const row = await asset(a.id);
    expect(row.retention_status).toBe('DELETED');
    expect(row.deleted_at).not.toBeNull();
    expect((await pool.query(`SELECT count(*)::int AS n FROM media_rendition WHERE asset_id = $1`, [a.id])).rows[0].n).toBe(0);
    // Tombstone is stable: a second run does nothing.
    expect(await sweep(pool, s3, opts(owner))).toEqual({ claimed: [], deleted: [], failed: [], skipped: [] });
  });

  it('waits for the grace period', async () => {
    const owner = newOwner();
    const a = await orphanWithObjects(owner, 'now()');
    const r = await sweep(pool, s3, opts(owner, { orphanGraceSeconds: 3600 }));
    expect(r.claimed).toEqual([]);
    expect((await asset(a.id)).retention_status).toBe('ORPHANED');
    expect(await exists(config.bucketIngest, a.key)).toBe(true);
  });

  it('re-checks references under the lock: an orphan that is referenced again is put back, not deleted', async () => {
    const owner = newOwner();
    const a = await orphanWithObjects(owner);
    // Counters say ORPHANED, media_reference says otherwise (drift).
    const d = await draftWith(owner);
    const rev = (await pool.query(`SELECT id FROM canvas_revision WHERE draft_id = $1`, [d])).rows[0].id;
    await pool.query(`INSERT INTO media_reference (asset_id, revision_id) VALUES ($1, $2)`, [a.id, rev]);

    const r = await sweep(pool, s3, opts(owner));
    expect(r.skipped).toEqual([a.id]);
    expect(await asset(a.id)).toMatchObject({ retention_status: 'REFERENCED', ref_count: 1 });
    expect(await exists(config.bucketIngest, a.key)).toBe(true);
  });

  it('partial object failure leaves DELETING with the error; the next run finishes', async () => {
    const owner = newOwner();
    const a = await orphanWithObjects(owner);
    let calls = 0;
    const flaky = new Proxy(s3, {
      get(t, p, rcv) {
        if (p !== 'send') return Reflect.get(t, p, rcv);
        return (cmd: any) => {
          if (cmd.constructor.name === 'DeleteObjectsCommand' && calls++ === 0) return Promise.reject(new Error('boom'));
          return t.send(cmd);
        };
      },
    }) as S3Client;

    const first = await sweep(pool, flaky, opts(owner));
    expect(first.failed).toEqual([a.id]);
    const mid = await asset(a.id);
    expect(mid.retention_status).toBe('DELETING');
    expect(mid.delete_attempts).toBe(1);
    expect(mid.delete_error).toContain('boom');

    const second = await sweep(pool, s3, opts(owner));
    expect(second.deleted).toEqual([a.id]);
    expect(await asset(a.id)).toMatchObject({ retention_status: 'DELETED', delete_error: null });
    expect(await exists(config.bucketIngest, a.key)).toBe(false);
  });

  it('rejects new references to DELETING and DELETED assets', async () => {
    const owner = newOwner();
    const a = await orphanWithObjects(owner);
    const d = await draftWith(owner);
    await pool.query(`UPDATE media_asset SET retention_status = 'DELETING' WHERE id = $1`, [a.id]);
    let r = await api(owner, 'PUT', `/v1/drafts/${d}`, { base_revision: 1, document: docWith(a.id) });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('ASSET_NOT_REFERENCEABLE');

    await sweep(pool, s3, opts(owner));
    r = await api(owner, 'PUT', `/v1/drafts/${d}`, { base_revision: 1, document: docWith(a.id) });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('ASSET_NOT_REFERENCEABLE');
    expect((await asset(a.id)).retention_status).toBe('DELETED');
  });

  it('lists nothing left under the asset prefix', async () => {
    const owner = newOwner();
    const a = await orphanWithObjects(owner);
    await sweep(pool, s3, opts(owner));
    const l = await s3.send(new ListObjectsV2Command({ Bucket: config.bucketDerived, Prefix: `derived/${a.id}/` }));
    expect(l.KeyCount).toBe(0);
  });
});

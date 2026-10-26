import { expireUploads, markUnattached } from '../src/expire';
import { runCycle } from '../src/run';
import { asset, newOwner, opts, pool, seedAsset } from './helpers';

afterAll(() => pool.end());

describe('expire pending uploads (POC-031)', () => {
  it('expires only reservations past expiry plus grace', async () => {
    const owner = newOwner();
    const past = await seedAsset({ owner, upload_status: 'PENDING_UPLOAD', upload_expires_at: new Date(Date.now() - 60_000).toISOString() });
    const fresh = await seedAsset({ owner, upload_status: 'PENDING_UPLOAD' });
    const uploaded = await seedAsset({ owner, upload_status: 'UPLOADED', upload_expires_at: new Date(Date.now() - 60_000).toISOString() });

    // Grace longer than the age: nothing expires.
    expect(await expireUploads(pool, opts(owner, { uploadExpiryGraceSeconds: 3600 }))).toEqual([]);
    expect(await expireUploads(pool, opts(owner))).toEqual([past.id]);

    expect((await asset(past.id)).upload_status).toBe('EXPIRED');
    expect((await asset(fresh.id)).upload_status).toBe('PENDING_UPLOAD');
    expect((await asset(uploaded.id)).upload_status).toBe('UPLOADED');
    // Repeating changes nothing.
    expect(await expireUploads(pool, opts(owner))).toEqual([]);
  });

  it('a locked row (concurrent complete) is skipped, not waited on', async () => {
    const owner = newOwner();
    const a = await seedAsset({ owner, upload_status: 'PENDING_UPLOAD', upload_expires_at: new Date(Date.now() - 60_000).toISOString() });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT 1 FROM media_asset WHERE id = $1 FOR UPDATE`, [a.id]);
      expect(await expireUploads(pool, opts(owner))).toEqual([]);
      await c.query(`UPDATE media_asset SET upload_status = 'UPLOADED' WHERE id = $1`, [a.id]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect((await asset(a.id)).upload_status).toBe('UPLOADED');
  });
});

describe('mark unattached assets (POC-031)', () => {
  it('orphans old unreferenced assets and spares referenced, pending and fresh ones', async () => {
    const owner = newOwner();
    const old = await seedAsset({ owner });
    const rejected = await seedAsset({ owner, upload_status: 'REJECTED' });
    const expired = await seedAsset({ owner, upload_status: 'EXPIRED' });
    const pending = await seedAsset({ owner, upload_status: 'PENDING_UPLOAD' });
    const referenced = await seedAsset({ owner, retention_status: 'REFERENCED' });
    // UNATTACHED with a stray reference row must not be orphaned: the reference check wins.
    const withRef = await seedAsset({ owner });
    const draft = (await pool.query(`INSERT INTO canvas_draft (owner_id, head_revision_no) VALUES ($1, 1) RETURNING id`, [owner])).rows[0].id;
    const rev = (
      await pool.query(`INSERT INTO canvas_revision (draft_id, revision_no, document, content_hash, source) VALUES ($1, 1, '{}', $2, 'INITIAL') RETURNING id`, [draft, 'a'.repeat(64)])
    ).rows[0].id;
    await pool.query(`INSERT INTO media_reference (asset_id, revision_id) VALUES ($1, $2)`, [withRef.id, rev]);

    expect(await markUnattached(pool, opts(owner, { unattachedGraceSeconds: 3600 }))).toEqual([]);
    const done = await markUnattached(pool, opts(owner));
    expect(done.sort()).toEqual([old.id, rejected.id, expired.id].sort());

    for (const a of [old, rejected, expired]) {
      const r = await asset(a.id);
      expect(r.retention_status).toBe('ORPHANED');
      expect(r.orphaned_at).not.toBeNull();
    }
    for (const a of [pending, withRef]) expect((await asset(a.id)).retention_status).toBe('UNATTACHED');
    expect((await asset(referenced.id)).retention_status).toBe('REFERENCED');
  });
});

describe('gc cycle runner', () => {
  it('runs steps in order and refuses a second concurrent run', async () => {
    const owner = newOwner();
    const a = await seedAsset({ owner });
    const lock = await pool.connect();
    await lock.query('SELECT pg_advisory_lock(7310031)');
    try {
      expect(await runCycle(pool, opts(owner))).toBeNull();
    } finally {
      await lock.query('SELECT pg_advisory_unlock(7310031)');
      lock.release();
    }
    const out: any = await runCycle(pool, opts(owner));
    expect(out.markUnattached.orphaned).toEqual([a.id]);
    await expect(runCycle(pool, opts(owner), 'nope')).rejects.toThrow('unknown step');
  });
});

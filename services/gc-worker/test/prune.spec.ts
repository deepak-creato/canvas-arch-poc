import { pruneRevisions, purgeDiscardedDrafts } from '../src/prune';
import { api, asset, docWith, draftWith, newOwner, opts, pool, seedAsset } from './helpers';

afterAll(() => pool.end());

const revisionNos = async (draftId: string) =>
  (await pool.query(`SELECT revision_no FROM canvas_revision WHERE draft_id = $1 ORDER BY revision_no`, [draftId])).rows.map((r) => r.revision_no);
const refCount = async (assetId: string) => (await pool.query(`SELECT count(*)::int AS n FROM media_reference WHERE asset_id = $1`, [assetId])).rows[0].n;

describe('purge discarded drafts (POC-032)', () => {
  it('releases references, orphans only unshared assets, keeps the tombstone', async () => {
    const owner = newOwner();
    const solo = await seedAsset({ owner });
    const shared = await seedAsset({ owner });
    const gone = await draftWith(owner, docWith(solo.id, shared.id));
    const other = await draftWith(owner, docWith(shared.id));
    expect((await api(owner, 'DELETE', `/v1/drafts/${gone}`)).status).toBe(200);

    // purge_after is in the future: nothing happens.
    expect(await purgeDiscardedDrafts(pool, opts(owner))).toEqual([]);
    expect(await refCount(solo.id)).toBe(1);

    await pool.query(`UPDATE canvas_draft SET purge_after = now() - interval '1 second' WHERE id = $1`, [gone]);
    expect(await purgeDiscardedDrafts(pool, opts(owner))).toEqual([gone]);

    expect((await pool.query(`SELECT status FROM canvas_draft WHERE id = $1`, [gone])).rows[0].status).toBe('PURGED');
    expect(await revisionNos(gone)).toEqual([]);
    expect(await refCount(solo.id)).toBe(0);
    expect(await asset(solo.id)).toMatchObject({ retention_status: 'ORPHANED', ref_count: 0 });
    expect((await asset(solo.id)).orphaned_at).not.toBeNull();
    // Still used by the other draft.
    expect(await asset(shared.id)).toMatchObject({ retention_status: 'REFERENCED', ref_count: 1 });
    expect(await revisionNos(other)).toEqual([1, 2]);

    // A purged draft cannot come back, and a second run is a no-op.
    expect((await api(owner, 'POST', `/v1/drafts/${gone}/restore`)).body.code).toBe('DRAFT_PURGED');
    expect(await purgeDiscardedDrafts(pool, opts(owner))).toEqual([]);
  });

  it('skips a draft that a restore holds, and never purges an active one', async () => {
    const owner = newOwner();
    const a = await seedAsset({ owner });
    const d = await draftWith(owner, docWith(a.id));
    await api(owner, 'DELETE', `/v1/drafts/${d}`);
    await pool.query(`UPDATE canvas_draft SET purge_after = now() - interval '1 second' WHERE id = $1`, [d]);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT 1 FROM canvas_draft WHERE id = $1 FOR UPDATE`, [d]);
      expect(await purgeDiscardedDrafts(pool, opts(owner))).toEqual([]);
      await c.query(`UPDATE canvas_draft SET status = 'ACTIVE', discarded_at = NULL, purge_after = NULL WHERE id = $1`, [d]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(await purgeDiscardedDrafts(pool, opts(owner))).toEqual([]);
    expect(await revisionNos(d)).toEqual([1, 2]);
    expect((await asset(a.id)).retention_status).toBe('REFERENCED');
  });
});

describe('prune old revisions (POC-032)', () => {
  it('keeps head, pinned and the newest N; releases references only the pruned revisions held', async () => {
    const owner = newOwner();
    const [a1, a2, a3, a4] = await Promise.all([1, 2, 3, 4].map(() => seedAsset({ owner })));
    // revisions: 1 empty, 2 a1, 3 a2, 4 a3, 5 a4 (head)
    const d = await draftWith(owner, docWith(a1.id), docWith(a2.id), docWith(a3.id), docWith(a4.id));
    await pool.query(`UPDATE canvas_revision SET pinned = true WHERE draft_id = $1 AND revision_no = 3`, [d]);

    // Too young for the age policy: nothing.
    expect(await pruneRevisions(pool, opts(owner, { revisionKeepLast: 1, revisionMinAgeSeconds: 3600 }))).toEqual([]);

    const pruned = await pruneRevisions(pool, opts(owner, { revisionKeepLast: 2 }));
    expect(pruned.sort()).toEqual([`${d}:1`, `${d}:2`]);
    expect(await revisionNos(d)).toEqual([3, 4, 5]);

    expect(await asset(a1.id)).toMatchObject({ retention_status: 'ORPHANED', ref_count: 0 });
    expect(await asset(a2.id)).toMatchObject({ retention_status: 'REFERENCED', ref_count: 1 }); // pinned rev 3
    expect(await asset(a4.id)).toMatchObject({ retention_status: 'REFERENCED', ref_count: 1 });
    expect(await pruneRevisions(pool, opts(owner, { revisionKeepLast: 2 }))).toEqual([]);
    // The head still reads fine.
    expect((await api(owner, 'GET', `/v1/drafts/${d}`)).body.head_revision).toBe(5);
  });

  it('never prunes revisions of a publishing draft or one a publication points to', async () => {
    const owner = newOwner();
    const a = await seedAsset({ owner });
    const d = await draftWith(owner, docWith(a.id), docWith(), docWith());
    // Freeze it as publishing with a publication on revision 2 (not pinned on purpose: the publication row alone protects it).
    const rev2 = (await pool.query(`SELECT id FROM canvas_revision WHERE draft_id = $1 AND revision_no = 2`, [d])).rows[0].id;
    await pool.query(`INSERT INTO publication (draft_id, revision_id, owner_id, idempotency_key) VALUES ($1, $2, $3, 'k')`, [d, rev2, owner]);
    await pool.query(`UPDATE canvas_draft SET status = 'PUBLISHING' WHERE id = $1`, [d]);
    expect(await pruneRevisions(pool, opts(owner))).toEqual([]);

    await pool.query(`UPDATE canvas_draft SET status = 'ACTIVE' WHERE id = $1`, [d]);
    const pruned = await pruneRevisions(pool, opts(owner));
    expect(await revisionNos(d)).toContain(2);
    expect(pruned).not.toContain(`${d}:2`);
  });
});

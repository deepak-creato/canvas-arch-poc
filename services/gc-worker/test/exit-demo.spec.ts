// M6 exit demo: short grace periods, discard a draft, run GC, only unreferenced media goes.
import { config } from '../../shared/config';
import { createS3 } from '../../shared/s3';
import { runCycle } from '../src/run';
import { api, asset, docWith, draftWith, newOwner, objectExists, opts, pool, seedWithObjects } from './helpers';

afterAll(() => pool.end());

const alive = async (a: { key: string; derived: string }) => (await objectExists(config.bucketIngest, a.key)) && (await objectExists(config.bucketDerived, a.derived));
const gone = async (a: { key: string; derived: string }) => !(await objectExists(config.bucketIngest, a.key)) && !(await objectExists(config.bucketDerived, a.derived));

it('M6 exit demo: discarding a draft deletes only media nobody else uses', async () => {
  const owner = newOwner();
  const only1 = await seedWithObjects(owner); // draft 1 only
  const shared = await seedWithObjects(owner); // draft 1 and draft 2
  const published = await seedWithObjects(owner); // draft 1 and a live publication of draft 3
  const only2 = await seedWithObjects(owner); // draft 2 only
  const loose = await seedWithObjects(owner); // uploaded, never used

  const d1 = await draftWith(owner, docWith(only1.id, shared.id, published.id));
  const d2 = await draftWith(owner, docWith(shared.id, only2.id));
  const d3 = await draftWith(owner, docWith(published.id));
  // Publish d3 the way mark-live does: a publication row, a reference from it, the draft frozen.
  const rev = (await pool.query(`SELECT id FROM canvas_revision WHERE draft_id = $1 AND revision_no = 2`, [d3])).rows[0].id;
  const pub = (
    await pool.query(`INSERT INTO publication (draft_id, revision_id, owner_id, idempotency_key, status, live_at) VALUES ($1, $2, $3, 'demo', 'LIVE', now()) RETURNING id`, [d3, rev, owner])
  ).rows[0].id;
  await pool.query(`INSERT INTO media_reference (asset_id, publication_id) VALUES ($1, $2)`, [published.id, pub]);
  await pool.query(`UPDATE canvas_revision SET pinned = true WHERE id = $1`, [rev]);
  await pool.query(`UPDATE canvas_draft SET status = 'PUBLISHED' WHERE id = $1`, [d3]);
  await pool.query(`UPDATE media_asset SET retention_status = 'PUBLISHED' WHERE id = $1`, [published.id]);

  // 1. The user discards draft 1; its purge date comes (short grace for the demo).
  expect((await api(owner, 'DELETE', `/v1/drafts/${d1}`)).status).toBe(200);
  await pool.query(`UPDATE canvas_draft SET purge_after = now() - interval '1 second' WHERE id = $1`, [d1]);

  // 2. A GC cycle with every grace at 0 stands in for "minutes later".
  const out: any = await runCycle(pool, opts(owner));
  expect(out.purgeDiscardedDrafts.purged).toEqual([d1]);
  expect(out.markUnattached.orphaned).toEqual([loose.id]);
  expect(out.sweep.deleted.sort()).toEqual([only1.id, loose.id].sort());

  // 3. Only the unreferenced media is gone, in the database and in S3.
  for (const a of [only1, loose]) {
    expect((await asset(a.id)).retention_status).toBe('DELETED');
    expect(await gone(a)).toBe(true);
  }
  expect(await asset(shared.id)).toMatchObject({ retention_status: 'REFERENCED', ref_count: 1 });
  expect(await asset(published.id)).toMatchObject({ retention_status: 'PUBLISHED', ref_count: 2 });
  expect(await asset(only2.id)).toMatchObject({ retention_status: 'REFERENCED', ref_count: 1 });
  for (const a of [shared, published, only2]) expect(await alive(a)).toBe(true);

  // 4. The other drafts and the publication still read fine and reference intact media.
  expect((await api(owner, 'GET', `/v1/drafts/${d2}`)).body.revision.document).toEqual(docWith(shared.id, only2.id));
  expect((await api(owner, 'GET', `/v1/drafts/${d3}`)).status).toBe(200);
  expect((await pool.query(`SELECT status FROM canvas_draft WHERE id = $1`, [d1])).rows[0].status).toBe('PURGED');

  // 5. A new save cannot reference deleted media; the next cycle changes nothing.
  const fresh = await draftWith(owner);
  const bad = await api(owner, 'PUT', `/v1/drafts/${fresh}`, { base_revision: 1, document: docWith(only1.id) });
  expect(bad.body.code).toBe('ASSET_NOT_REFERENCEABLE');
  const again: any = await runCycle(pool, opts(owner));
  expect(again.purgeDiscardedDrafts.purged).toEqual([]);
  expect(again.sweep).toEqual({ claimed: [], deleted: [], failed: [], skipped: [] });
  void createS3;
});

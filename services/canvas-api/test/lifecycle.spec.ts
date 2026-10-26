// POC-037: the whole media lifecycle for one owner, in order. Needs the compose stack (make up).
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { config } from '../../shared/config';
import { createS3 } from '../../shared/s3';
import { runCycle } from '../../gc-worker/src/run';
import { call, json, owner, publish, pubStatus, readyAsset, readyVideo, sql, until, uploadCanvas } from './publish-helpers';

jest.setTimeout(300000);

const doc = (ids: string[], shift = 0) => ({
  version: 1,
  canvas: { width: 1080, height: 1080 },
  elements: ids.map((id, i) => ({ id: `e${i}`, type: 'media', asset_id: id, x: shift + i, y: 0, width: 100, height: 100 })),
});
const jobs = (o: string) => Number(sql(`SELECT count(*) FROM processing_job j JOIN media_asset a ON a.id = j.asset_id WHERE a.owner_id = '${o}'`));
const retention = (id: string) => sql(`SELECT retention_status FROM media_asset WHERE id = '${id}'`);
const s3 = createS3();
const original = async (id: string) => {
  const [bucket, key] = sql(`SELECT original_bucket || ' ' || original_key FROM media_asset WHERE id = '${id}'`).split(' ');
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
};

describe('media lifecycle (POC-037)', () => {
  const o = owner('life');
  const pool = new Pool({ connectionString: config.databaseUrl });
  afterAll(() => pool.end());
  const S: Record<string, any> = {};

  it('1. uploads five images and one video; all READY, no final-tier work', async () => {
    const files: [string, string][] = [
      ['sample-1.png', 'image/png'], ['sample-2.jpg', 'image/jpeg'], ['sample-3.webp', 'image/webp'],
      ['sample-4.png', 'image/png'], ['sample-5.jpg', 'image/jpeg'],
    ];
    const ids = await Promise.all(files.map(([n, ct]) => readyAsset(o, n, ct)));
    [S.img1, S.img2, S.img3, S.img4, S.img5] = ids;
    S.vid = await readyVideo(o);
    for (const id of [...ids, S.vid]) {
      const a = await json(await call(o, 'GET', `/v1/assets/${id}`));
      expect(a).toMatchObject({ upload_status: 'VALIDATED', processing_status: 'READY' });
      expect(a.renditions.length).toBeGreaterThanOrEqual(2);
    }
    expect(sql(`SELECT count(*) FROM media_rendition r JOIN media_asset a ON a.id = r.asset_id WHERE a.owner_id = '${o}' AND r.tier = 'FINAL'`)).toBe('0');
    expect(sql(`SELECT count(*) FROM processing_job j JOIN media_asset a ON a.id = j.asset_id WHERE a.owner_id = '${o}' AND j.job_type ILIKE '%transcode%'`)).toBe('0');
  });

  it('2. deduplicates by owner, never across owners', async () => {
    const before = { jobs: jobs(o), assets: sql(`SELECT count(*) FROM media_asset WHERE owner_id = '${o}'`) };
    expect(await readyAsset(o, 'sample-1.png', 'image/png')).toBe(S.img1);
    expect(jobs(o)).toBe(before.jobs);
    expect(sql(`SELECT count(*) FROM media_asset WHERE owner_id = '${o}'`)).toBe(before.assets);
    const other = owner('other');
    expect(await readyAsset(other, 'sample-1.png', 'image/png')).not.toBe(S.img1);
  });

  it('3. saves 20 revisions without any media processing, and rejects a stale save with 409', async () => {
    S.draftA = (await json(await call(o, 'POST', '/v1/drafts', { document: doc([S.img1, S.img2, S.vid]) }))).draft_id;
    const baseline = jobs(o);
    let head = 1;
    for (let i = 1; i <= 20; i++) {
      const r = await json(await call(o, 'PUT', `/v1/drafts/${S.draftA}`, { base_revision: head, document: doc([S.img1, S.img2, S.vid], i) }));
      expect(r.unchanged).toBe(false);
      head = r.head_revision;
    }
    expect(head).toBe(21);
    expect(jobs(o)).toBe(baseline);
    expect((await call(o, 'PUT', `/v1/drafts/${S.draftA}`, { base_revision: 5, document: doc([S.img1], 99) })).status).toBe(409);
    expect((await json(await call(o, 'GET', `/v1/drafts/${S.draftA}/revisions`))).revisions).toHaveLength(21);
  });

  it('4. mock AI: known assets only, repeat served from cache, accepted result is a new revision', async () => {
    const url = `/v1/drafts/${S.draftA}/ai-layouts`;
    const first = await json(await call(o, 'POST', url, { asset_ids: [S.img1, S.img2], seed: 3 }));
    const ready = await until(async () => json(await call(o, 'GET', `/v1/ai-layouts/${first.generation_id}`)), (g) => g.status === 'READY' || g.status === 'FAILED', 30000);
    expect(ready.status).toBe('READY');
    const used = JSON.stringify(ready.result).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
    expect(new Set(used)).toEqual(new Set([S.img1, S.img2]));

    const baseline = jobs(o);
    const again = await json(await call(o, 'POST', url, { asset_ids: [S.img1, S.img2], seed: 3 }));
    expect(again).toMatchObject({ status: 'READY', cached: true });
    expect(jobs(o)).toBe(baseline);

    const acc = await json(await call(o, 'POST', `${url}/${first.generation_id}/accept`, { base_revision: 21 }));
    expect(acc).toMatchObject({ head_revision: 22, revision: { source: 'AI_GENERATION' } });
  });

  it('5. cross-draft reuse, discard and restore keep media without re-uploading', async () => {
    S.draftB = (await json(await call(o, 'POST', '/v1/drafts', { document: doc([S.img1]) }))).draft_id;
    expect(await retention(S.img1)).toBe('REFERENCED');
    // draft A has 22 revisions, all but the first reference img1, plus draft B's one: counted per revision
    expect(Number(sql(`SELECT ref_count FROM media_asset WHERE id = '${S.img1}'`))).toBe(Number(sql(`SELECT count(*) FROM media_reference WHERE asset_id = '${S.img1}'`)));
    expect(Number(sql(`SELECT count(DISTINCT r.draft_id) FROM media_reference m JOIN canvas_revision r ON r.id = m.revision_id WHERE m.asset_id = '${S.img1}'`))).toBe(2);

    expect((await call(o, 'DELETE', `/v1/drafts/${S.draftA}`)).status).toBe(200);
    const back = await json(await call(o, 'POST', `/v1/drafts/${S.draftA}/restore`));
    expect(back.status).toBe('ACTIVE');
    expect(back.head_revision).toBe(22);
    expect(await original(S.img2)).toBe(true);
    expect(await retention(S.img2)).toBe('REFERENCED');
  });

  it('6. publishes a draft to LIVE with manifest, canvas and mock final video', async () => {
    S.draftC = (await json(await call(o, 'POST', '/v1/drafts', { document: doc([S.img5, S.vid]) }))).draft_id;
    const key = `life-${randomUUID()}`;
    const pub = await json(await publish(o, S.draftC, key));
    S.pub = pub.publication_id;
    // same key and request: same publication; other key: rejected
    expect((await json(await publish(o, S.draftC, key))).publication_id).toBe(S.pub);
    expect((await publish(o, S.draftC, `other-${randomUUID()}`)).status).toBe(409);

    expect(await until(() => pubStatus(S.pub), (s) => s === 'AWAITING_CANVAS' || s === 'FAILED')).toBe('AWAITING_CANVAS');
    await uploadCanvas(o, S.pub);
    expect((await call(o, 'POST', `/v1/publications/${S.pub}/canvas-uploaded`, { content_type: 'image/png' })).status).toBe(202);
    expect(await until(() => pubStatus(S.pub), (s) => s === 'LIVE' || s === 'FAILED')).toBe('LIVE');

    const view = await json(await call(o, 'GET', `/v1/publications/${S.pub}`));
    const manifest = await (await fetch(view.manifest_url)).json();
    expect(manifest.revision.revision_no).toBe(1);
    expect(view.finals).toHaveLength(1);
    expect(await retention(S.img5)).toBe('PUBLISHED');
    expect(await retention(S.vid)).toBe('PUBLISHED');
  });

  it('7. GC after discard deletes only unreferenced media', async () => {
    expect((await call(o, 'DELETE', `/v1/drafts/${S.draftA}`)).status).toBe(200);
    sql(`UPDATE canvas_draft SET purge_after = now() - interval '1 second' WHERE id = '${S.draftA}'`);

    const out: any = await runCycle(pool as any, {
      batchSize: 100, uploadExpiryGraceSeconds: 0, unattachedGraceSeconds: 0, orphanGraceSeconds: 0, jobStaleSeconds: 3600,
      reconcileAfterSeconds: 3600, strayGraceSeconds: 3600, deleteStrays: false, revisionKeepLast: 1000, revisionMinAgeSeconds: 0, ownerId: o,
    });
    expect(out.purgeDiscardedDrafts.purged).toEqual([S.draftA]);

    // img2 only lived in draft A; img3 and img4 were never used: gone, objects included.
    for (const id of [S.img2, S.img3, S.img4]) {
      expect(await retention(id)).toBe('DELETED');
      expect(await original(id)).toBe(false);
    }
    // img1 is in draft B, img5 and vid are published: intact.
    expect(await retention(S.img1)).toBe('REFERENCED');
    expect(await retention(S.img5)).toBe('PUBLISHED');
    expect(await retention(S.vid)).toBe('PUBLISHED');
    for (const id of [S.img1, S.img5, S.vid]) expect(await original(id)).toBe(true);
    expect((await call(o, 'GET', `/v1/drafts/${S.draftB}`)).status).toBe(200);
    expect((await json(await call(o, 'GET', `/v1/publications/${S.pub}`))).status).toBe('LIVE');
    expect((await call(o, 'POST', `/v1/drafts/${S.draftB}/restore`)).status).toBe(200);
    expect((await call(o, 'PUT', `/v1/drafts/${S.draftB}`, { base_revision: 1, document: doc([S.img2]) })).status).toBe(422);
  });
});

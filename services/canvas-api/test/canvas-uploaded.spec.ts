// Integration test: needs the compose stack (make up).
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../../shared/config';
import { createS3 } from '../../shared/s3';
import { call, json, owner, publishToGate, sql, until, uploadCanvas } from './publish-helpers';

const s3 = createS3();
const uploaded = (o: string, id: string, content_type = 'image/png') => call(o, 'POST', `/v1/publications/${id}/canvas-uploaded`, { content_type });
const manifestKey = (id: string) => sql(`SELECT coalesce(manifest_key, '') FROM publication WHERE id = '${id}'`);

describe('canvas-uploaded and manifest (POC-028)', () => {
  it('verifies the canvas, resumes the workflow and writes the manifest', async () => {
    const o = owner();
    const g = await publishToGate(o);
    expect(g.status).toBe('AWAITING_CANVAS');
    const { put, bytes } = await uploadCanvas(o, g.id);
    expect(put.status).toBe(200);

    const res = await uploaded(o, g.id);
    expect(res.status).toBe(202);
    // Repeating the confirmation is harmless: the token was taken once.
    expect((await uploaded(o, g.id)).status).toBe(202);
    expect(await until(() => manifestKey(g.id), (k) => k !== '')).toBe(`publications/${g.id}/manifest.json`);
    expect(sql(`SELECT task_token IS NULL FROM publication WHERE id = '${g.id}'`)).toBe('t');
    expect(sql(`SELECT canvas_bytes || ',' || canvas_content_type FROM publication WHERE id = '${g.id}'`)).toBe(`${bytes.length},image/png`);

    const obj = await s3.send(new GetObjectCommand({ Bucket: config.bucketPublished, Key: `publications/${g.id}/manifest.json` }));
    const m = JSON.parse(await obj.Body!.transformToString());
    expect(m).toMatchObject({
      manifest_version: 1,
      publication_id: g.id,
      draft_id: g.draft,
      owner_id: o,
      revision: { revision_no: 1, content_hash: sql(`SELECT content_hash FROM canvas_revision WHERE draft_id = '${g.draft}' AND revision_no = 1`) },
      render: { bucket: config.bucketPublished, key: `publications/${g.id}/canvas.png`, content_type: 'image/png', bytes: bytes.length },
    });
    expect(m.revision.document.elements.map((e: any) => e.asset_id).sort()).toEqual([g.img, g.vid].sort());
    expect(m.assets.map((a: any) => a.asset_id).sort()).toEqual([g.img, g.vid].sort());
    // Only the video has a final rendition; its key is the deterministic final key.
    expect(Object.keys(m.finals)).toEqual([g.vid]);
    expect(m.finals[g.vid].key).toBe(`final/${g.vid}/video/v1/mock-h264-720p.mp4`);
    expect(m.finals[g.vid].bucket).toBe(config.bucketDerived);
  });

  it('refuses a missing canvas without losing the wait, then accepts it after the upload', async () => {
    const o = owner();
    const g = await publishToGate(o);
    const miss = await uploaded(o, g.id);
    expect(miss.status).toBe(422);
    expect((await json(miss)).code).toBe('CANVAS_NOT_FOUND');
    expect(sql(`SELECT status || ',' || (task_token IS NOT NULL) FROM publication WHERE id = '${g.id}'`)).toBe('AWAITING_CANVAS,true');

    await uploadCanvas(o, g.id);
    expect((await uploaded(o, g.id)).status).toBe(202);
    expect(await until(() => manifestKey(g.id), (k) => k !== '')).not.toBe('');
  });

  it('refuses an object that is not the declared file type, and a mismatching type', async () => {
    const o = owner();
    const g = await publishToGate(o);
    await uploadCanvas(o, g.id, 'fake.png', 'image/png'); // text pretending to be a PNG
    const bad = await uploaded(o, g.id);
    expect(bad.status).toBe(422);
    expect((await json(bad)).code).toBe('CANVAS_INVALID');
    expect((await uploaded(o, g.id, 'video/mp4')).status).toBe(422); // nothing uploaded as mp4
    expect((await call(o, 'POST', `/v1/publications/${g.id}/canvas-uploaded`, { content_type: 'image/gif' })).status).toBe(400);
    expect(sql(`SELECT status FROM publication WHERE id = '${g.id}'`)).toBe('AWAITING_CANVAS');
  });

  it('accepts a video canvas', async () => {
    const o = owner();
    const g = await publishToGate(o);
    await uploadCanvas(o, g.id, 'canvas-render.mp4', 'video/mp4');
    expect((await uploaded(o, g.id, 'video/mp4')).status).toBe(202);
    await until(() => manifestKey(g.id), (k) => k !== '');
    const obj = await s3.send(new GetObjectCommand({ Bucket: config.bucketPublished, Key: `publications/${g.id}/manifest.json` }));
    expect(JSON.parse(await obj.Body!.transformToString()).render).toMatchObject({ key: `publications/${g.id}/canvas.mp4`, content_type: 'video/mp4' });
  });

  it('is owner-scoped and only valid at the gate', async () => {
    const o = owner();
    const g = await publishToGate(o, { test_fail_mode: 'permanent' });
    expect(g.status).toBe('FAILED');
    const res = await uploaded(o, g.id);
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('PUBLICATION_STATE');
    expect((await uploaded(owner(), g.id)).status).toBe(404);
  });
});

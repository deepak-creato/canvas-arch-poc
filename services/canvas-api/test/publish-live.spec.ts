// Integration test: needs the compose stack (make up).
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { config } from '../../shared/config';
import { StepError } from '../src/publish/errors';
import { markPublicationLive } from '../src/publish/mark-live';
import { call, executionStatus, FIX, json, owner, publish, publishToGate, pubStatus, sql, trail, until, uploadCanvas } from './publish-helpers';

const confirm = (o: string, id: string) => call(o, 'POST', `/v1/publications/${id}/canvas-uploaded`, { content_type: 'image/png' });

describe('go live (POC-029)', () => {
  it('goes LIVE with the exact revision, publication references and final renditions', async () => {
    const o = owner();
    const g = await publishToGate(o);
    await uploadCanvas(o, g.id);
    expect((await confirm(o, g.id)).status).toBe(202);
    expect(await until(() => pubStatus(g.id), (s) => s === 'LIVE' || s === 'FAILED')).toBe('LIVE');

    expect(trail(g.id)).toEqual(['REQUESTED', 'WAITING_FOR_ASSETS', 'TRANSCODING', 'AWAITING_CANVAS', 'FINALIZING', 'LIVE']);
    expect(sql(`SELECT live_at IS NOT NULL FROM publication WHERE id = '${g.id}'`)).toBe('t');
    expect(await executionStatus(sql(`SELECT execution_arn FROM publication WHERE id = '${g.id}'`))).toBe('SUCCEEDED');

    // Draft, revision and assets
    expect(sql(`SELECT status FROM canvas_draft WHERE id = '${g.draft}'`)).toBe('PUBLISHED');
    expect(sql(`SELECT r.revision_no || ',' || r.pinned FROM publication p JOIN canvas_revision r ON r.id = p.revision_id WHERE p.id = '${g.id}'`)).toBe('1,true');
    for (const a of [g.img, g.vid]) {
      expect(sql(`SELECT retention_status || ',' || ref_count FROM media_asset WHERE id = '${a}'`)).toBe('PUBLISHED,2'); // revision + publication
      expect(sql(`SELECT count(*) FROM media_reference WHERE asset_id = '${a}' AND publication_id = '${g.id}'`)).toBe('1');
    }
    expect(sql(`SELECT asset_id FROM publication_asset WHERE publication_id = '${g.id}'`)).toBe(g.vid);

    // API view: manifest, render and finals are reachable
    const pub = await json(await call(o, 'GET', `/v1/publications/${g.id}`));
    expect(pub.status).toBe('LIVE');
    expect(pub.transitions.map((t: any) => t.to)).toEqual(['REQUESTED', 'WAITING_FOR_ASSETS', 'TRANSCODING', 'AWAITING_CANVAS', 'FINALIZING', 'LIVE']);
    const manifest = await (await fetch(pub.manifest_url)).json();
    expect(manifest.publication_id).toBe(g.id);
    expect((await fetch(pub.render.url)).headers.get('content-length')).toBe(String(statSync(`${FIX}/canvas-render.png`).size));
    expect(pub.finals).toHaveLength(1);
    expect(pub.finals[0].asset_id).toBe(g.vid);
    expect((await fetch(pub.finals[0].url)).headers.get('content-length')).toBe(String(statSync(`${FIX}/sample.mp4`).size));

    // Frozen afterwards
    const doc = { version: 1, canvas: { width: 1080, height: 1080 }, elements: [] };
    expect((await call(o, 'PUT', `/v1/drafts/${g.draft}`, { base_revision: 1, document: doc })).status).toBe(409);
    expect((await publish(o, g.draft, randomUUID())).status).toBe(409);
    expect((await call(o, 'DELETE', `/v1/drafts/${g.draft}`)).status).toBe(409);
  });

  it('is atomic and repeatable: a bad asset rolls everything back, a rerun after the fix goes LIVE once', async () => {
    const o = owner();
    const g = await publishToGate(o);
    // Put the publication where MARK_LIVE runs, without letting the workflow run it.
    sql(`UPDATE publication SET status = 'FINALIZING', manifest_key = 'publications/${g.id}/manifest.json', task_token = NULL WHERE id = '${g.id}'`);
    sql(`UPDATE media_asset SET retention_status = 'DELETING' WHERE id = '${g.vid}'`);

    const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
    try {
      const run = () => markPublicationLive(pool, g.id, 'MARK_LIVE');

      await expect(run()).rejects.toMatchObject({ code: 'ASSET_NOT_REFERENCEABLE' });
      await expect(run()).rejects.toBeInstanceOf(StepError);
      expect(sql(`SELECT status FROM publication WHERE id = '${g.id}'`)).toBe('FINALIZING');
      expect(sql(`SELECT count(*) FROM media_reference WHERE publication_id = '${g.id}'`)).toBe('0');
      expect(sql(`SELECT count(*) FROM publication_asset WHERE publication_id = '${g.id}'`)).toBe('0');
      expect(sql(`SELECT status FROM canvas_draft WHERE id = '${g.draft}'`)).toBe('PUBLISHING');
      expect(sql(`SELECT retention_status FROM media_asset WHERE id = '${g.img}'`)).toBe('REFERENCED');

      sql(`UPDATE media_asset SET retention_status = 'REFERENCED' WHERE id = '${g.vid}'`);
      expect(await run()).toEqual({ live: true, already: false });
      expect(await run()).toEqual({ live: true, already: true });
      expect(sql(`SELECT count(*) FROM media_reference WHERE publication_id = '${g.id}'`)).toBe('2');
      expect(sql(`SELECT count(*) FROM publication_transition WHERE publication_id = '${g.id}' AND to_status = 'LIVE'`)).toBe('1');
      expect(sql(`SELECT status FROM canvas_draft WHERE id = '${g.draft}'`)).toBe('PUBLISHED');
    } finally {
      await pool.end();
    }
  });
});

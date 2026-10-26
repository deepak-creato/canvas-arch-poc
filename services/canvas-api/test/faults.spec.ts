// POC-038: duplicates, concurrency, worker crash and consistency invariants. Needs the compose stack (make up).
// Mock transcode failures and GC/save races have their own specs (retry.spec.ts, gc-worker/test/protect.spec.ts).
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { execSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { config } from '../../shared/config';
import { createSqs } from '../../shared/sqs';
import { call, draftWith, FIX, json, owner, publish, readyAsset, sleep, sql, until } from './publish-helpers';

jest.setTimeout(480000);
const COMPOSE = resolve(__dirname, '../../../docker-compose.yml');
const compose = (cmd: string) => execSync(`docker compose -f ${COMPOSE} ${cmd}`, { stdio: 'pipe' });
const owners: string[] = [];
const newOwner = (p: string) => {
  const o = owner(p);
  owners.push(o);
  return o;
};
const doc = (n: number) => ({ version: 1, canvas: { width: 1080, height: 1080 }, elements: [{ id: 'e', type: 'text', x: n, y: 0 }] });

/** Cross-cutting invariants over everything these tests created. */
afterAll(() => {
  const list = owners.map((o) => `'${o}'`).join(',');
  if (!list) return;
  // 1. nothing references an asset GC has claimed
  expect(sql(`SELECT count(*) FROM media_reference m JOIN media_asset a ON a.id = m.asset_id WHERE a.owner_id IN (${list}) AND a.retention_status IN ('DELETING', 'DELETED')`)).toBe('0');
  // 2. every LIVE publication references each asset of its revision
  expect(
    sql(`SELECT count(*) FROM publication p WHERE p.owner_id IN (${list}) AND p.status = 'LIVE' AND EXISTS (
           SELECT 1 FROM canvas_revision r, jsonb_path_query(r.document, 'strict $.**.asset_id') x
            WHERE r.id = p.revision_id AND NOT EXISTS (
              SELECT 1 FROM media_reference m WHERE m.publication_id = p.id AND m.asset_id = (x #>> '{}')::uuid))`),
  ).toBe('0');
  // 3. ref_count matches media_reference
  expect(sql(`SELECT count(*) FROM media_asset a WHERE a.owner_id IN (${list}) AND a.retention_status NOT IN ('DELETING','DELETED') AND a.ref_count <> (SELECT count(*) FROM media_reference m WHERE m.asset_id = a.id)`)).toBe('0');
  // 4. one job per idempotency key, one rendition per recipe (also enforced by constraints)
  expect(sql(`SELECT count(*) FROM (SELECT idempotency_key FROM processing_job GROUP BY 1 HAVING count(*) > 1) d`)).toBe('0');
});

describe('duplicates (POC-038)', () => {
  it('redelivered S3 events do not repeat processing', async () => {
    const o = newOwner('dup');
    const id = await readyAsset(o);
    const snapshot = () => sql(`SELECT string_agg(job_type || ':' || status || ':' || attempts, ',' ORDER BY job_type) FROM processing_job WHERE asset_id = '${id}'`) +
      '|' + sql(`SELECT count(*) FROM media_rendition WHERE asset_id = '${id}'`) + '|' + sql(`SELECT max(updated_at) FROM media_rendition WHERE asset_id = '${id}'`);
    const before = snapshot();
    const key = sql(`SELECT original_key FROM media_asset WHERE id = '${id}'`);
    const body = JSON.stringify({ 'detail-type': 'Object Created', detail: { bucket: { name: config.bucketIngest }, object: { key } } });
    const sqs = createSqs();
    for (let i = 0; i < 5; i++) await sqs.send(new SendMessageCommand({ QueueUrl: config.queueLightProcessingUrl, MessageBody: body }));
    await sleep(8000);
    expect(snapshot()).toBe(before);
    expect(sql(`SELECT upload_status FROM media_asset WHERE id = '${id}'`)).toBe('VALIDATED');
  });

  it('parallel identical uploads make one asset and one set of jobs', async () => {
    const o = newOwner('dup');
    const bytes = readFileSync(`${FIX}/sample-2.jpg`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const rs = await Promise.all(
      Array.from({ length: 8 }, async () => json(await call(o, 'POST', '/v1/uploads', { sha256, content_type: 'image/jpeg', size_bytes: bytes.length }))),
    );
    const ids = new Set(rs.map((r) => r.asset_id));
    expect(ids.size).toBe(1);
    const res = rs[0];
    await Promise.all([1, 2, 3].map(() => fetch(res.upload_url, { method: 'PUT', headers: res.upload_headers, body: new Uint8Array(bytes) })));
    await Promise.all([1, 2, 3].map(() => call(o, 'POST', `/v1/uploads/${res.asset_id}/complete`)));
    await until(() => call(o, 'GET', `/v1/assets/${res.asset_id}`).then(json).then((a) => a.processing_status), (s) => s === 'READY', 90000);
    expect(sql(`SELECT count(*) FROM media_asset WHERE owner_id = '${o}'`)).toBe('1');
    expect(sql(`SELECT count(*) FROM processing_job WHERE asset_id = '${res.asset_id}' AND job_type = 'validate'`)).toBe('1');
    expect(sql(`SELECT count(*) FROM processing_job WHERE asset_id = '${res.asset_id}' AND job_type = 'image-derive'`)).toBe('1');
    expect(sql(`SELECT count(*) FROM media_rendition WHERE asset_id = '${res.asset_id}'`)).toBe('2');
  });
});

describe('concurrency (POC-038)', () => {
  it('parallel saves on one base revision: one winner, the rest 409, gapless revisions', async () => {
    const o = newOwner('race');
    const d = (await json(await call(o, 'POST', '/v1/drafts', {}))).draft_id;
    const codes = await Promise.all(Array.from({ length: 8 }, async (_, i) => (await call(o, 'PUT', `/v1/drafts/${d}`, { base_revision: 1, document: doc(i + 1) })).status));
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(7);
    expect(sql(`SELECT string_agg(revision_no::text, ',' ORDER BY revision_no) FROM canvas_revision WHERE draft_id = '${d}'`)).toBe('1,2');
    expect(sql(`SELECT head_revision_no FROM canvas_draft WHERE id = '${d}'`)).toBe('2');
  });

  it('parallel publish with one key makes one publication; with different keys only one is accepted', async () => {
    const o = newOwner('race');
    const a = await readyAsset(o);
    const d1 = await draftWith(o, [a]);
    const key = randomUUID();
    const same = await Promise.all(Array.from({ length: 6 }, async () => json(await publish(o, d1, key))));
    expect(new Set(same.map((p) => p.publication_id)).size).toBe(1);
    expect(sql(`SELECT count(*) FROM publication WHERE draft_id = '${d1}'`)).toBe('1');

    const d2 = await draftWith(o, [a]);
    const statuses = await Promise.all(Array.from({ length: 5 }, async () => (await publish(o, d2, randomUUID())).status));
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
    expect(statuses.filter((s) => s !== 409)).toHaveLength(1);
    expect(sql(`SELECT count(*) FROM publication WHERE draft_id = '${d2}'`)).toBe('1');
    // one execution per publication
    expect(sql(`SELECT count(DISTINCT execution_arn) FROM publication WHERE owner_id = '${o}'`)).toBe('2');
  });
});

describe('worker crash (POC-038)', () => {
  it('a light-worker killed mid-job is recovered by lease expiry and redelivery, without duplicates', async () => {
    const o = newOwner('crash');
    const bytes = readFileSync(`${FIX}/sample-long.mp4`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const res = await json(await call(o, 'POST', '/v1/uploads', { sha256, content_type: 'video/mp4', size_bytes: bytes.length }));
    await fetch(res.upload_url, { method: 'PUT', headers: res.upload_headers, body: new Uint8Array(bytes) });
    const id = res.asset_id as string;

    const running = await until(
      () => sql(`SELECT count(*) FROM processing_job WHERE asset_id = '${id}' AND status = 'RUNNING'`),
      (n) => n !== '0',
      30000,
      50,
    );
    expect(running).not.toBe('0');
    compose('kill light-worker');
    try {
      // The dead worker's job stays RUNNING until the lease runs out.
      expect(sql(`SELECT count(*) FROM processing_job WHERE asset_id = '${id}' AND status = 'RUNNING'`)).not.toBe('0');
    } finally {
      compose('start light-worker');
    }
    const final = await until(() => call(o, 'GET', `/v1/assets/${id}`).then(json).then((a) => a.processing_status), (s) => ['READY', 'FAILED', 'REJECTED'].includes(s), 400000, 2000);
    expect(final).toBe('READY');
    expect(sql(`SELECT count(*) FROM processing_job WHERE asset_id = '${id}' GROUP BY job_type HAVING count(*) > 1`)).toBe('');
    expect(sql(`SELECT count(*) FROM media_rendition WHERE asset_id = '${id}'`)).toBe(sql(`SELECT count(DISTINCT (kind, recipe_version, params_hash)) FROM media_rendition WHERE asset_id = '${id}'`));
    // at least one job needed a second attempt after the crash
    expect(Number(sql(`SELECT max(attempts) FROM processing_job WHERE asset_id = '${id}'`))).toBeGreaterThanOrEqual(2);
  });
});

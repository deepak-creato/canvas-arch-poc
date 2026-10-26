// Integration test: needs the compose stack (make up) with light-worker running.
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { execSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import sharp from 'sharp';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const COMPOSE = resolve(__dirname, '../../../docker-compose.yml');
const FIX = resolve(__dirname, '../../../fixtures');
const s3 = new S3Client({
  region: 'us-east-1', endpoint: 'http://127.0.0.1:4566', forcePathStyle: true,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const sql = (q: string) =>
  execSync(`docker compose -f ${COMPOSE} exec -T postgres psql -U canvas -tA -c "${q}"`).toString().trim();

async function waitFor(fn: () => boolean, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function uploadVideo(name: string) {
  const bytes = readFileSync(`${FIX}/${name}`);
  const res: any = await (
    await fetch(`${API}/v1/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owner-id': `v-${randomBytes(4).toString('hex')}` },
      body: JSON.stringify({ sha256: createHash('sha256').update(bytes).digest('hex'), content_type: 'video/mp4', size_bytes: bytes.length }),
    })
  ).json();
  await fetch(res.upload_url, { method: 'PUT', headers: res.upload_headers, body: new Uint8Array(bytes) });
  return res.asset_id as string;
}

const rows = (id: string) =>
  sql(`select kind||'|'||status||'|'||s3_key from media_rendition where asset_id='${id}' order by kind, s3_key`).split('\n').filter(Boolean).map((r) => r.split('|'));
const get = async (key: string) => {
  const o = await s3.send(new GetObjectCommand({ Bucket: 'media-derived-poc', Key: key }));
  return { type: o.ContentType, body: Buffer.from(await o.Body!.transformToByteArray()) };
};

describe('video renditions', () => {
  it('3s clip: poster, proxy, one sprite sheet and sprite.json, all READY', async () => {
    const id = await uploadVideo('sample.mp4'); // 320x180, 3s
    expect(await waitFor(() => rows(id).length === 4 && rows(id).every((r) => r[1] === 'READY'))).toBe(true);
    const byKind = Object.fromEntries(rows(id).map((r) => [r[0], r[2]]));

    const poster = await get(byKind.poster);
    expect(poster.type).toBe('image/jpeg');
    expect(byKind.poster).toBe(`derived/${id}/poster/v1/w640-q3.jpg`);
    expect(await sharp(poster.body).metadata()).toMatchObject({ format: 'jpeg', width: 320, height: 180 });

    const proxy = await get(byKind.proxy);
    expect(proxy.type).toBe('video/mp4');
    expect(proxy.body.toString('ascii', 4, 8)).toBe('ftyp');

    const sheet = await get(byKind.sprite);
    expect(await sharp(sheet.body).metadata()).toMatchObject({ format: 'jpeg', width: 800, height: 450 });

    const manifest = JSON.parse((await get(byKind.sprite_manifest)).body.toString());
    expect(byKind.sprite_manifest).toBe(`derived/${id}/sprite_manifest/v1/manifest.json`);
    expect(manifest).toMatchObject({ frame_width: 160, frame_height: 90, columns: 5, rows: 5, frame_count: 3, interval_seconds: 1 });
    expect(manifest.sheets).toHaveLength(1);
    expect(manifest.sheets[0].key).toBe(byKind.sprite);
    expect(manifest.sheets[0].frames).toEqual([
      { index: 0, time_seconds: 0, x: 0, y: 0 },
      { index: 1, time_seconds: 1, x: 160, y: 0 },
      { index: 2, time_seconds: 2, x: 320, y: 0 },
    ]);
    expect(sql(`select metadata->>'frame_count' from media_rendition where asset_id='${id}' and kind='sprite_manifest'`)).toBe('3');
    expect(sql(`select status from processing_job where asset_id='${id}' and job_type='video-derive'`)).toBe('SUCCEEDED');
  });

  it('60s clip: 50 frames over two sheets with timestamps', async () => {
    const id = await uploadVideo('sample-long.mp4');
    expect(await waitFor(() => rows(id).length === 5 && rows(id).every((r) => r[1] === 'READY'))).toBe(true);
    const sheets = rows(id).filter((r) => r[0] === 'sprite');
    expect(sheets).toHaveLength(2);
    for (const s of sheets) await head(s[2]);
    const mkey = rows(id).find((r) => r[0] === 'sprite_manifest')![2];
    const m = JSON.parse((await get(mkey)).body.toString());
    expect(m.frame_count).toBe(50);
    expect(m.interval_seconds).toBeCloseTo(1.2, 5);
    expect(m.sheets[0].frames).toHaveLength(25);
    expect(m.sheets[1].frames).toHaveLength(25);
    expect(m.sheets[1].frames[0]).toMatchObject({ index: 25, time_seconds: 30, x: 0, y: 0 });
  });

  it('re-run after crash reuses outputs and does not rewrite them', async () => {
    const id = await uploadVideo('sample.mp4');
    expect(await waitFor(() => rows(id).length === 4 && rows(id).every((r) => r[1] === 'READY'))).toBe(true);
    const key = rows(id).find((r) => r[0] === 'proxy')![2];
    const before = (await head(key)).LastModified!.getTime();
    const orig = sql(`select original_key from media_asset where id='${id}'`);
    sql(`update media_rendition set status='QUEUED' where asset_id='${id}'`);
    sql(`update processing_job set status='QUEUED' where asset_id='${id}' and job_type='video-derive'`);
    execSync(
      `docker compose -f ${COMPOSE} exec -T localstack sh -c 'AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test aws --endpoint-url http://localhost:4566 --region us-east-1 sqs send-message --queue-url http://localhost:4566/000000000000/light-processing --message-body "{\\"detail-type\\":\\"Object Created\\",\\"detail\\":{\\"bucket\\":{\\"name\\":\\"media-ingest-poc\\"},\\"object\\":{\\"key\\":\\"${orig}\\"}}}"'`,
    );
    expect(await waitFor(() => rows(id).every((r) => r[1] === 'READY') && sql(`select count(*) from media_rendition where asset_id='${id}' and metadata ? 'reused'`) === '4')).toBe(true);
    expect((await head(key)).LastModified!.getTime()).toBe(before);
  });
});

const head = (key: string) => s3.send(new HeadObjectCommand({ Bucket: 'media-derived-poc', Key: key }));

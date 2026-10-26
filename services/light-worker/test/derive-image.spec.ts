// Integration test: needs the compose stack (make up) with light-worker running.
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { execSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import sharp from 'sharp';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const COMPOSE = resolve(__dirname, '../../../docker-compose.yml');
const FIX = resolve(__dirname, '../../../fixtures');
const creds = { accessKeyId: 'test', secretAccessKey: 'test' };
const s3 = new S3Client({ region: 'us-east-1', endpoint: 'http://127.0.0.1:4566', forcePathStyle: true, credentials: creds });
const sqs = new SQSClient({ region: 'us-east-1', endpoint: 'http://127.0.0.1:4566', credentials: creds });
const QUEUE = 'http://127.0.0.1:4566/000000000000/light-processing';

const sql = (q: string) =>
  execSync(`docker compose -f ${COMPOSE} exec -T postgres psql -U canvas -tA -c "${q}"`).toString().trim();

async function waitFor(fn: () => boolean, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function upload(name: string, ct: string) {
  const bytes = readFileSync(`${FIX}/${name}`);
  const res: any = await (
    await fetch(`${API}/v1/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owner-id': `d-${randomBytes(4).toString('hex')}` },
      body: JSON.stringify({ sha256: createHash('sha256').update(bytes).digest('hex'), content_type: ct, size_bytes: bytes.length }),
    })
  ).json();
  await fetch(res.upload_url, { method: 'PUT', headers: res.upload_headers, body: new Uint8Array(bytes) });
  return res.asset_id as string;
}

const renditions = (id: string) =>
  sql(`select kind||'|'||status||'|'||s3_key from media_rendition where asset_id='${id}' order by kind`).split('\n').filter(Boolean);
const allReady = (id: string) => {
  const r = renditions(id);
  return r.length === 2 && r.every((x) => x.split('|')[1] === 'READY');
};

describe('image renditions', () => {
  it('creates thumbnail and WebP preview at deterministic keys', async () => {
    const id = await upload('sample-5.jpg', 'image/jpeg'); // 1280x720
    expect(await waitFor(() => allReady(id))).toBe(true);

    const [preview, thumb] = renditions(id).map((r) => r.split('|')[2]);
    expect(preview).toBe(`derived/${id}/preview/v1/inside-1280x1280-q80.webp`);
    expect(thumb).toBe(`derived/${id}/thumbnail/v1/inside-320x320-q75.webp`);

    for (const [key, w, h] of [[preview, 1280, 720], [thumb, 320, 180]] as const) {
      const obj = await s3.send(new GetObjectCommand({ Bucket: 'media-derived-poc', Key: key }));
      expect(obj.ContentType).toBe('image/webp');
      const m = await sharp(Buffer.from(await obj.Body!.transformToByteArray())).metadata();
      expect([m.format, m.width, m.height]).toEqual(['webp', w, h]);
    }
    expect(sql(`select status from processing_job where asset_id='${id}' and job_type='image-derive'`)).toBe('SUCCEEDED');
  });

  it('does not enlarge small images', async () => {
    const id = await upload('sample-1.png', 'image/png'); // 320x240
    expect(await waitFor(() => allReady(id))).toBe(true);
    const md = sql(`select metadata->>'width'||'x'||(metadata->>'height') from media_rendition where asset_id='${id}' and kind='preview'`);
    expect(md).toBe('320x240');
  });

  it('duplicate events and re-queued rows reuse existing outputs (HEAD before work)', async () => {
    const id = await upload('sample-2.jpg', 'image/jpeg');
    expect(await waitFor(() => allReady(id))).toBe(true);
    const key = sql(`select original_key from media_asset where id='${id}'`);
    const thumbKey = renditions(id)[1].split('|')[2];
    const before = (await s3.send(new HeadObjectCommand({ Bucket: 'media-derived-poc', Key: thumbKey }))).LastModified!.getTime();

    // Simulate a crash after the object was written: row and job go back to QUEUED.
    sql(`update media_rendition set status='QUEUED' where asset_id='${id}'`);
    sql(`update processing_job set status='QUEUED' where asset_id='${id}' and job_type='image-derive'`);
    const event = JSON.stringify({ 'detail-type': 'Object Created', detail: { bucket: { name: 'media-ingest-poc' }, object: { key } } });
    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE, MessageBody: event }));
    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE, MessageBody: event }));

    expect(await waitFor(() => allReady(id))).toBe(true);
    await new Promise((r) => setTimeout(r, 3000));
    const after = (await s3.send(new HeadObjectCommand({ Bucket: 'media-derived-poc', Key: thumbKey }))).LastModified!.getTime();
    expect(after).toBe(before); // not rewritten
    expect(sql(`select count(*) from media_rendition where asset_id='${id}'`)).toBe('2');
    expect(sql(`select count(*) from processing_job where asset_id='${id}' and job_type='image-derive'`)).toBe('1');
  });

  it('rejected images and videos get no image renditions', async () => {
    const bad = await upload('corrupt.png', 'image/png');
    const vid = await upload('sample.mp4', 'video/mp4');
    expect(await waitFor(() => sql(`select upload_status from media_asset where id='${bad}'`) === 'REJECTED')).toBe(true);
    expect(await waitFor(() => sql(`select upload_status from media_asset where id='${vid}'`) === 'VALIDATED')).toBe(true);
    await new Promise((r) => setTimeout(r, 2000));
    expect(renditions(bad)).toEqual([]);
    expect(renditions(vid)).toEqual([]);
  });
});

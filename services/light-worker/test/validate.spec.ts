// Integration test: needs the compose stack (make up) with light-worker running.
import { execSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Readable } from 'stream';
import { saveAndHash, TooLargeError } from '../src/inspect';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const COMPOSE = resolve(__dirname, '../../../docker-compose.yml');
const FIX = resolve(__dirname, '../../../fixtures');

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

/** Uploads bytes through the real API + presigned PUT and waits for the worker's verdict. */
async function upload(bytes: Buffer, contentType: string, opts: { claimedSha?: string } = {}) {
  const owner = `v-${randomBytes(4).toString('hex')}`;
  const sha256 = opts.claimedSha ?? createHash('sha256').update(bytes).digest('hex');
  const res: any = await (
    await fetch(`${API}/v1/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-owner-id': owner },
      body: JSON.stringify({ sha256, content_type: contentType, size_bytes: bytes.length }),
    })
  ).json();
  await fetch(res.upload_url, { method: 'PUT', headers: res.upload_headers, body: new Uint8Array(bytes) });
  const id = res.asset_id as string;
  const done = await waitFor(() => ['VALIDATED', 'REJECTED'].includes(row(id, 'upload_status')));
  expect(done).toBe(true);
  return {
    id,
    status: row(id, 'upload_status'),
    reason: row(id, 'reject_reason'),
    server_sha256: row(id, 'server_sha256'),
    metadata: JSON.parse(row(id, 'metadata')),
    jobStatus: sql(`select status from processing_job where asset_id='${id}' and job_type='validate'`),
    sha256,
  };
}
const row = (id: string, col: string) => sql(`select coalesce(${col}::text,'') from media_asset where id='${id}'`);
const fix = (n: string) => readFileSync(`${FIX}/${n}`);

describe('validation', () => {
  it.each([
    ['sample-1.png', 'image/png', 320, 240],
    ['sample-2.jpg', 'image/jpeg', 640, 360],
    ['sample-3.webp', 'image/webp', 400, 400],
  ])('%s becomes VALIDATED with metadata', async (name, ct, w, h) => {
    const r = await upload(fix(name), ct);
    expect(r.status).toBe('VALIDATED');
    expect(r.server_sha256).toBe(r.sha256);
    expect(r.metadata).toMatchObject({ width: w, height: h });
    expect(r.jobStatus).toBe('SUCCEEDED');
  });

  it('mp4 becomes VALIDATED with duration and dimensions', async () => {
    const r = await upload(fix('sample.mp4'), 'video/mp4');
    expect(r.status).toBe('VALIDATED');
    expect(r.metadata).toMatchObject({ width: 320, height: 180, video_codec: 'h264', has_audio: true });
    expect(r.metadata.duration_seconds).toBeGreaterThan(2.5);
  });

  it('truncated PNG is REJECTED as CORRUPT_FILE', async () => {
    const r = await upload(fix('corrupt.png'), 'image/png');
    expect(r.status).toBe('REJECTED');
    expect(r.reason).toBe('CORRUPT_FILE');
    expect(r.jobStatus).toBe('SUCCEEDED');
  });

  it('truncated MP4 is REJECTED as CORRUPT_FILE', async () => {
    const r = await upload(fix('corrupt.mp4'), 'video/mp4');
    expect(r.status).toBe('REJECTED');
    expect(r.reason).toBe('CORRUPT_FILE');
  });

  it('text declared as PNG is REJECTED as TYPE_MISMATCH', async () => {
    const r = await upload(fix('fake.png'), 'image/png');
    expect(r.status).toBe('REJECTED');
    expect(r.reason).toBe('TYPE_MISMATCH');
  });

  it('valid PNG with a lying client hash is REJECTED as HASH_MISMATCH', async () => {
    const lie = createHash('sha256').update('something else').digest('hex');
    const r = await upload(fix('sample-1.png'), 'image/png', { claimedSha: lie });
    expect(r.status).toBe('REJECTED');
    expect(r.reason).toBe('HASH_MISMATCH');
    expect(r.server_sha256).toBe('');
  });

  it('a rejected upload does not block re-uploading the same content', async () => {
    const png = fix('sample-4.png');
    const lie = createHash('sha256').update('x').digest('hex');
    await upload(png, 'image/png', { claimedSha: lie });
    const ok = await upload(png, 'image/png');
    expect(ok.status).toBe('VALIDATED');
  });
});

describe('saveAndHash', () => {
  it('aborts a stream larger than the limit', async () => {
    const body = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]);
    await expect(saveAndHash(body, '/tmp/should-not-matter', 1000)).rejects.toBeInstanceOf(TooLargeError);
  });
});

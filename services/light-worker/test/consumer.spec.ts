// Integration test: needs the compose stack (make up) with light-worker running.
import { execSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const COMPOSE = resolve(__dirname, '../../../docker-compose.yml');
const QUEUE = 'http://127.0.0.1:4566/000000000000/light-processing';
const INGEST = 'media-ingest-poc';
const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

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

const event = (key: string) =>
  JSON.stringify({
    'detail-type': 'Object Created',
    source: 'aws.s3',
    detail: { bucket: { name: INGEST }, object: { key } },
  });

// Reserve and PUT, but never call "complete": only the S3 event can advance the asset.
async function uploadWithoutComplete() {
  const bytes = readFileSync(resolve(__dirname, '../../../fixtures/sample-1.png'));
  const owner = `w-${randomBytes(4).toString('hex')}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const res = await fetch(`${API}/v1/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-owner-id': owner },
    body: JSON.stringify({ sha256, content_type: 'image/png', size_bytes: bytes.length }),
  });
  const b: any = await res.json();
  await fetch(b.upload_url, { method: 'PUT', headers: b.upload_headers, body: new Uint8Array(bytes) });
  return b.asset_id as string;
}
// The worker confirms the upload and then validates it, so UPLOADED may already be VALIDATED.
const confirmed = (id: string) => status(id) !== 'PENDING_UPLOAD';
const status = (id: string) => sql(`select upload_status from media_asset where id='${id}'`);
const jobs = (id: string) => sql(`select count(*) from processing_job where asset_id='${id}'`);

describe('light-worker consumer', () => {
  it('S3 event from a presigned PUT confirms the asset without a complete call, with one job', async () => {
    const id = await uploadWithoutComplete();
    expect(await waitFor(() => confirmed(id))).toBe(true);
    expect(jobs(id)).toBe('1');
  });

  it('duplicate events do not create duplicate jobs', async () => {
    const id = await uploadWithoutComplete();
    expect(await waitFor(() => confirmed(id))).toBe(true);
    const key = sql(`select original_key from media_asset where id='${id}'`);
    for (let i = 0; i < 3; i++) {
      await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE, MessageBody: event(key) }));
    }
    await new Promise((r) => setTimeout(r, 8000));
    expect(jobs(id)).toBe('1');
    expect(status(id)).toBe('VALIDATED');
  });

  it('drops events for unknown objects', async () => {
    await sqs.send(
      new SendMessageCommand({ QueueUrl: QUEUE, MessageBody: event(`staging/nobody/${randomBytes(4).toString('hex')}/source`) }),
    );
    let drained = false;
    const end = Date.now() + 20000;
    while (!drained && Date.now() < end) {
      const r = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: QUEUE,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      drained = Object.values(r.Attributes ?? {}).every((v) => v === '0');
      if (!drained) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(drained).toBe(true);
  });
});

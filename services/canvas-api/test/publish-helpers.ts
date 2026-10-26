// Shared helpers for the publish integration tests (M5). Need the running compose stack.
import { DescribeExecutionCommand, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { execSync } from 'child_process';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { config } from '../../shared/config';
import { createSfn } from '../../shared/sfn';

export const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const COMPOSE = resolve(__dirname, '../../../docker-compose.yml');
export const FIX = resolve(__dirname, '../../../fixtures');
export const sql = (q: string) => execSync(`docker compose -f ${COMPOSE} exec -T postgres psql -U canvas -tA -c "${q}"`).toString().trim();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const owner = (p = 'pub') => `${p}-${randomBytes(4).toString('hex')}`;
export const sfn: SFNClient = createSfn();

export const call = (o: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${API}${path}`, {
    method,
    headers: { ...(o ? { 'x-owner-id': o } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
export const json = async (r: Response) => (await r.json()) as any;

/** Uploads a fixture and waits until the asset is READY (validated, draft renditions done). */
export async function readyAsset(o: string, name = 'sample-5.jpg', ct = 'image/jpeg'): Promise<string> {
  const bytes = readFileSync(`${FIX}/${name}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const res = await json(await call(o, 'POST', '/v1/uploads', { sha256, content_type: ct, size_bytes: bytes.length, filename: name }));
  if (!res.deduplicated) await fetch(res.upload_url, { method: 'PUT', headers: res.upload_headers, body: new Uint8Array(bytes) });
  for (let i = 0; i < 180; i++) {
    const a = await json(await call(o, 'GET', `/v1/assets/${res.asset_id}`));
    if (a.processing_status === 'READY') return res.asset_id;
    if (a.processing_status === 'REJECTED' || a.processing_status === 'FAILED') throw new Error(`fixture ${name} ${a.processing_status}`);
    await sleep(500);
  }
  throw new Error('asset never ready');
}

export const readyVideo = (o: string) => readyAsset(o, 'sample.mp4', 'video/mp4');

/** A draft whose head revision references the given assets. */
export async function draftWith(o: string, assetIds: string[]): Promise<string> {
  const doc = { version: 1, canvas: { width: 1080, height: 1080 }, elements: assetIds.map((id, i) => ({ id: `e${i}`, type: 'media', asset_id: id, x: 0, y: 0, width: 100, height: 100 })) };
  return (await json(await call(o, 'POST', '/v1/drafts', { document: doc }))).draft_id;
}

export async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 60000, step = 400): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < end) {
    await sleep(step);
    v = await fn();
  }
  return v;
}

export const pubStatus = (id: string) => sql(`SELECT status FROM publication WHERE id = '${id}'`);
export const trail = (id: string) => sql(`SELECT string_agg(to_status, ',' ORDER BY id) FROM publication_transition WHERE publication_id = '${id}'`).split(',');
export const executionStatus = async (arn: string) => (await sfn.send(new DescribeExecutionCommand({ executionArn: arn }))).status;

export const publish = (o: string, draftId: string, key: string | null, body: unknown = { revision: 1 }) =>
  call(o, 'POST', `/v1/drafts/${draftId}/publications`, body, key ? { 'idempotency-key': key } : {});

/** Publishes a fresh draft that uses one image and one video, and waits until the canvas gate opens. */
export async function publishToGate(o: string, extra: Record<string, unknown> = {}) {
  const img = await readyAsset(o);
  const vid = await readyVideo(o);
  const draft = await draftWith(o, [img, vid]);
  const pub = await json(await publish(o, draft, `k-${randomBytes(6).toString('hex')}`, { revision: 1, ...extra }));
  await until(() => pubStatus(pub.publication_id), (s) => s === 'AWAITING_CANVAS' || s === 'FAILED');
  return { img, vid, draft, id: pub.publication_id as string, status: pubStatus(pub.publication_id) };
}

/** Requests an upload URL and uploads a fixture as the rendered canvas. */
export async function uploadCanvas(o: string, id: string, name = 'canvas-render.png', ct = 'image/png') {
  const bytes = readFileSync(`${FIX}/${name}`);
  const res = await json(await call(o, 'POST', `/v1/publications/${id}/canvas-upload`, { content_type: ct, size_bytes: bytes.length }));
  const put = await fetch(res.upload_url, { method: 'PUT', headers: res.upload_headers, body: new Uint8Array(bytes) });
  return { put, bytes, res };
}

/** What POST /v1/drafts/{id}/publications does, minus the API, so a test can choose the timeouts. */
export async function startPublication(o: string, draftId: string, opts: { failMode?: string; canvasTimeout?: number } = {}) {
  const rev = sql(`SELECT id FROM canvas_revision WHERE draft_id = '${draftId}' AND revision_no = 1`);
  const id = randomUUID();
  sql(
    `INSERT INTO publication (id, draft_id, revision_id, owner_id, idempotency_key, test_fail_mode)
     VALUES ('${id}', '${draftId}', '${rev}', '${o}', '${randomUUID()}', ${opts.failMode ? `'${opts.failMode}'` : 'NULL'})`,
  );
  sql(`INSERT INTO publication_transition (publication_id, to_status, step) VALUES ('${id}', 'REQUESTED', 'PUBLISH_REQUEST')`);
  sql(`UPDATE canvas_draft SET status = 'PUBLISHING' WHERE id = '${draftId}'`);
  const out = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: config.publishStateMachineArn,
      name: `${id}-a1`,
      input: JSON.stringify({
        publication_id: id,
        attempt: 1,
        validation: { iteration: 0 },
        wait_seconds: 1,
        canvas_timeout_seconds: opts.canvasTimeout ?? 60,
        transcode_timeout_seconds: 60,
      }),
    }),
  );
  sql(`UPDATE publication SET execution_arn = '${out.executionArn}' WHERE id = '${id}'`);
  return { id, arn: out.executionArn! };
}

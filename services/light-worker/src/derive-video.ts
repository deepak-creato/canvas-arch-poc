import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { execFile } from 'child_process';
import { createWriteStream } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import { Pool } from 'pg';
import { config } from '../../shared/config';
import { renditionKey } from '../../shared/keys';
import { DeriveOutcome, RenditionSpec, runDerive } from './derive-common';
import { POSTER, PROXY, SPRITE, spritePlan, videoDeriveKey } from './recipes';

const run = promisify(execFile);
const FFMPEG_TIMEOUT_MS = 300_000;
// Proxy encoding can be slow; POC-012 adds lease heartbeats instead of relying on this.
const LEASE_SECONDS = 600;

const ffmpeg = (args: string[]) => run('ffmpeg', ['-v', 'error', '-y', ...args], { timeout: FFMPEG_TIMEOUT_MS });

/** Creates poster, low-res proxy, sprite sheets and sprite.json for a VALIDATED video. Safe to call repeatedly. */
export async function deriveVideo(pool: Pool, s3: S3Client, assetId: string, correlationId: string): Promise<DeriveOutcome> {
  const a = (
    await pool.query<{
      id: string; kind: string; upload_status: string; original_bucket: string; original_key: string; metadata: any;
    }>(`SELECT id, kind, upload_status, original_bucket, original_key, metadata FROM media_asset WHERE id = $1`, [assetId])
  ).rows[0];
  if (!a || a.kind !== 'VIDEO' || a.upload_status !== 'VALIDATED') return 'done';

  const { duration_seconds: duration, width, height } = a.metadata as { duration_seconds: number; width: number; height: number };
  const plan = spritePlan(duration, width, height);
  const dir = await mkdtemp(join(tmpdir(), 'derive-video-'));
  const src = join(dir, 'source');

  let downloaded = false;
  const getSource = async () => {
    if (!downloaded) {
      const obj = await s3.send(new GetObjectCommand({ Bucket: a.original_bucket, Key: a.original_key }));
      await pipeline(obj.Body as Readable, createWriteStream(src));
      downloaded = true;
    }
    return src;
  };

  // One ffmpeg run produces every sheet, so it is shared between the sheet specs.
  let sheets: Promise<Buffer[]> | undefined;
  const makeSheets = () =>
    (sheets ??= (async () => {
      const input = await getSource();
      const vf = `fps=1/${plan.interval},scale=${SPRITE.frameWidth}:${plan.frameHeight},tile=${SPRITE.columns}x${SPRITE.rows}`;
      await ffmpeg(['-i', input, '-vf', vf, '-an', '-q:v', String(SPRITE.quality), '-frames:v', String(plan.sheets), join(dir, 'sheet-%d.jpg')]);
      return Promise.all(Array.from({ length: plan.sheets }, (_, i) => readFile(join(dir, `sheet-${i + 1}.jpg`))));
    })());

  const sheetHash = (i: number) => `s${i}-${SPRITE.frameWidth}x${plan.frameHeight}-c${SPRITE.columns}r${SPRITE.rows}-q${SPRITE.quality}`;
  const sheetKey = (i: number) => renditionKey(a.id, 'sprite', SPRITE.version, sheetHash(i), 'jpg');

  const specs: RenditionSpec[] = [
    {
      kind: 'poster', version: POSTER.version, paramsHash: `w${POSTER.maxWidth}-q${POSTER.quality}`, ext: 'jpg', contentType: 'image/jpeg',
      produce: async () => {
        const out = join(dir, 'poster.jpg');
        const at = Math.min(1, duration / 2);
        await ffmpeg(['-ss', String(at), '-i', await getSource(), '-frames:v', '1', '-vf', `scale='min(${POSTER.maxWidth},iw)':-2`, '-q:v', String(POSTER.quality), out]);
        return { body: await readFile(out), metadata: { at_seconds: at } };
      },
    },
    {
      kind: 'proxy', version: PROXY.version, paramsHash: `w${PROXY.maxWidth}-crf${PROXY.crf}-${PROXY.preset}`, ext: 'mp4', contentType: 'video/mp4',
      produce: async () => {
        const out = join(dir, 'proxy.mp4');
        await ffmpeg([
          '-i', await getSource(), '-map', '0:v:0', '-map', '0:a:0?',
          '-vf', `scale='min(${PROXY.maxWidth},iw)':-2`,
          '-c:v', 'libx264', '-preset', PROXY.preset, '-crf', String(PROXY.crf), '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', `${PROXY.audioKbps}k`, '-movflags', '+faststart', out,
        ]);
        return { body: await readFile(out), metadata: {} };
      },
    },
    ...Array.from({ length: plan.sheets }, (_, i): RenditionSpec => ({
      kind: 'sprite', version: SPRITE.version, paramsHash: sheetHash(i), ext: 'jpg', contentType: 'image/jpeg',
      produce: async () => ({
        body: (await makeSheets())[i],
        metadata: { sheet: i, frames: Math.min(plan.perSheet, plan.frameCount - i * plan.perSheet) },
      }),
    })),
    {
      kind: 'sprite_manifest', version: SPRITE.version, paramsHash: 'manifest', ext: 'json', contentType: 'application/json',
      // Built from the plan alone: it needs no ffmpeg output, only the sheet keys.
      produce: async () => {
        const manifest = spriteManifest(a.id, duration, plan, sheetKey);
        return { body: Buffer.from(JSON.stringify(manifest)), metadata: manifest };
      },
    },
  ];

  try {
    return await runDerive(pool, s3, a.id, { type: 'video-derive', key: videoDeriveKey(a.id), leaseSeconds: LEASE_SECONDS }, specs, correlationId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function spriteManifest(assetId: string, duration: number, plan: ReturnType<typeof spritePlan>, sheetKey: (i: number) => string) {
  return {
    version: SPRITE.version,
    asset_id: assetId,
    bucket: config.bucketDerived,
    duration_seconds: duration,
    interval_seconds: plan.interval,
    frame_width: SPRITE.frameWidth,
    frame_height: plan.frameHeight,
    columns: SPRITE.columns,
    rows: SPRITE.rows,
    frame_count: plan.frameCount,
    sheets: Array.from({ length: plan.sheets }, (_, s) => ({
      index: s,
      key: sheetKey(s),
      frames: Array.from({ length: Math.min(plan.perSheet, plan.frameCount - s * plan.perSheet) }, (_, f) => {
        const n = s * plan.perSheet + f;
        return {
          index: n,
          time_seconds: Math.round(n * plan.interval * 1000) / 1000,
          x: (f % SPRITE.columns) * SPRITE.frameWidth,
          y: Math.floor(f / SPRITE.columns) * plan.frameHeight,
        };
      }),
    })),
  };
}

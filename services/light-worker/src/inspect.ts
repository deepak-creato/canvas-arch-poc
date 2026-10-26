import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { createWriteStream } from 'fs';
import { open } from 'fs/promises';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import sharp from 'sharp';

const run = promisify(execFile);

export class TooLargeError extends Error {}
/** The file itself is bad (not a transient failure). */
export class CorruptError extends Error {}

/** Streams `body` to `dest`, computing SHA-256 and size on the way. Aborts past `maxBytes`. */
export async function saveAndHash(body: Readable, dest: string, maxBytes: number) {
  const hash = createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new TooLargeError(`more than ${maxBytes} bytes`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(body, tap, createWriteStream(dest));
  return { sha256: hash.digest('hex'), size };
}

/** Detects the real type from magic bytes. The declared content type is never trusted. */
export async function sniffType(path: string): Promise<string | null> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    const b = buf.subarray(0, bytesRead);
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
    return null;
  } finally {
    await fh.close();
  }
}

/** Reads metadata and forces a full decode, so truncated or damaged images are caught. */
export async function probeImage(path: string): Promise<Record<string, unknown>> {
  try {
    const img = sharp(path, { failOn: 'error' });
    const m = await img.metadata();
    await img.stats();
    if (!m.width || !m.height) throw new Error('no dimensions');
    return { width: m.width, height: m.height, format: m.format, has_alpha: m.hasAlpha ?? false, orientation: m.orientation ?? null };
  } catch (e) {
    throw new CorruptError(String(e));
  }
}

export async function probeVideo(path: string): Promise<Record<string, unknown>> {
  let out: string;
  try {
    ({ stdout: out } = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], {
      timeout: 30_000,
    }));
  } catch (e: any) {
    // Non-zero exit means ffprobe could not parse the file. Spawn errors and timeouts are not the file's fault.
    if (typeof e.code === 'number' && !e.killed) throw new CorruptError(String(e.stderr || e.message).slice(0, 300));
    throw e;
  }
  // ffprobe only reads headers. A full decode catches truncated or damaged media data.
  // Exit code decides; stderr warnings alone do not reject.
  try {
    await run('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { timeout: 120_000 });
  } catch (e: any) {
    if (typeof e.code === 'number' && !e.killed) throw new CorruptError(String(e.stderr || e.message).slice(0, 300));
    throw e;
  }
  const info = JSON.parse(out);
  const v = (info.streams ?? []).find((s: any) => s.codec_type === 'video');
  const duration = Number(info.format?.duration);
  if (!v || !v.width || !v.height) throw new CorruptError('no video stream');
  if (!Number.isFinite(duration) || duration <= 0) throw new CorruptError('no duration');
  const [n, d] = String(v.avg_frame_rate ?? v.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    width: v.width,
    height: v.height,
    duration_seconds: duration,
    video_codec: v.codec_name,
    fps: d ? Math.round((n / d) * 100) / 100 : null,
    has_audio: (info.streams as any[]).some((s) => s.codec_type === 'audio'),
    bit_rate: info.format?.bit_rate ? Number(info.format.bit_rate) : null,
  };
}

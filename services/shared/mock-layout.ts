import { createHash } from 'crypto';

// Mock AI: deterministic, schema-valid canvas JSON. No model is involved.

export interface AssetFacts {
  asset_id: string;
  kind: 'IMAGE' | 'VIDEO';
  width: number;
  height: number;
  duration_seconds?: number;
}

export interface LayoutInput {
  assets: AssetFacts[];
  canvas: { width: number; height: number };
  seed: number;
  model_version: string;
}

export interface CanvasElement {
  id: string;
  type: 'image' | 'video';
  asset_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  fit: 'contain';
}

export interface CanvasDocument {
  version: 1;
  canvas: { width: number; height: number };
  elements: CanvasElement[];
}

export const DEFAULT_CANVAS = { width: 1080, height: 1080 };
const MARGIN = 40;
const GAP = 20;

/** mulberry32 over a 32-bit seed taken from the input hash. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedFrom = (input: LayoutInput) =>
  createHash('sha256')
    .update(`${input.model_version}|${input.seed}|${input.assets.map((a) => a.asset_id).join(',')}`)
    .digest()
    .readUInt32BE(0);

interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Splits the usable canvas area into one cell per asset. */
function cells(n: number, cw: number, ch: number, pattern: number): Cell[] {
  const ux = MARGIN;
  const uy = MARGIN;
  const uw = cw - 2 * MARGIN;
  const uh = ch - 2 * MARGIN;
  if (n === 1) return [{ x: ux, y: uy, w: uw, h: uh }];

  // hero: first cell takes half the height, the rest share a strip below
  if (pattern === 0) {
    const heroH = Math.floor((uh - GAP) / 2);
    const rest = n - 1;
    const w = Math.floor((uw - GAP * (rest - 1)) / rest);
    return [
      { x: ux, y: uy, w: uw, h: heroH },
      ...Array.from({ length: rest }, (_, i) => ({ x: ux + i * (w + GAP), y: uy + heroH + GAP, w, h: uh - heroH - GAP })),
    ];
  }
  // stack: one column
  if (pattern === 1) {
    const h = Math.floor((uh - GAP * (n - 1)) / n);
    return Array.from({ length: n }, (_, i) => ({ x: ux, y: uy + i * (h + GAP), w: uw, h }));
  }
  // grid
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const w = Math.floor((uw - GAP * (cols - 1)) / cols);
  const h = Math.floor((uh - GAP * (rows - 1)) / rows);
  return Array.from({ length: n }, (_, i) => ({ x: ux + (i % cols) * (w + GAP), y: uy + Math.floor(i / cols) * (h + GAP), w, h }));
}

/** Fits an asset inside a cell, keeping its aspect ratio, centred. */
function fit(asset: AssetFacts, c: Cell) {
  const scale = Math.min(c.w / asset.width, c.h / asset.height);
  const w = Math.max(1, Math.floor(asset.width * scale));
  const h = Math.max(1, Math.floor(asset.height * scale));
  return { x: c.x + Math.floor((c.w - w) / 2), y: c.y + Math.floor((c.h - h) / 2), width: w, height: h };
}

export function generateLayout(input: LayoutInput): CanvasDocument {
  const { assets, canvas } = input;
  if (assets.length === 0) throw new Error('at least one asset required');
  const rnd = prng(seedFrom(input));

  // Seeded order and pattern; same input always gives the same pick.
  const order = assets.map((a, i) => ({ a, k: rnd(), i })).sort((x, y) => x.k - y.k || x.i - y.i).map((x) => x.a);
  const pattern = assets.length === 1 ? 2 : Math.floor(rnd() * 3);
  const slots = cells(order.length, canvas.width, canvas.height, pattern);

  const doc: CanvasDocument = {
    version: 1,
    canvas: { width: canvas.width, height: canvas.height },
    elements: order.map((a, i) => ({
      id: `el-${i + 1}`,
      type: a.kind === 'VIDEO' ? 'video' : 'image',
      asset_id: a.asset_id,
      ...fit(a, slots[i]),
      z: i,
      fit: 'contain' as const,
    })),
  };
  const errors = validateCanvas(doc, assets.map((a) => a.asset_id));
  if (errors.length) throw new Error(`generated layout invalid: ${errors.join('; ')}`);
  return doc;
}

/** Schema check for canvas JSON. Empty list means valid. `known` limits which assets may be referenced. */
export function validateCanvas(doc: unknown, known: string[]): string[] {
  const errs: string[] = [];
  const d = doc as any;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['document must be an object'];
  if (d.version !== 1) errs.push('version must be 1');
  const cw = d.canvas?.width;
  const ch = d.canvas?.height;
  if (!Number.isInteger(cw) || !Number.isInteger(ch) || cw < 1 || ch < 1) errs.push('canvas.width and canvas.height must be positive integers');
  if (!Array.isArray(d.elements)) return [...errs, 'elements must be an array'];

  const ids = new Set<string>();
  const allowed = new Set(known);
  d.elements.forEach((e: any, i: number) => {
    const at = `elements[${i}]`;
    if (!e || typeof e !== 'object') return errs.push(`${at} must be an object`);
    if (typeof e.id !== 'string' || !e.id) errs.push(`${at}.id must be a non-empty string`);
    else if (ids.has(e.id)) errs.push(`${at}.id "${e.id}" is duplicated`);
    else ids.add(e.id);
    if (e.type !== 'image' && e.type !== 'video') errs.push(`${at}.type must be image or video`);
    if (!allowed.has(e.asset_id)) errs.push(`${at}.asset_id ${JSON.stringify(e.asset_id)} is not a known asset`);
    for (const k of ['x', 'y', 'width', 'height', 'z']) {
      if (!Number.isInteger(e[k])) errs.push(`${at}.${k} must be an integer`);
    }
    if (Number.isInteger(e.width) && Number.isInteger(e.height) && (e.width < 1 || e.height < 1)) errs.push(`${at} must have positive size`);
    if (
      [e.x, e.y, e.width, e.height].every(Number.isInteger) &&
      Number.isInteger(cw) &&
      Number.isInteger(ch) &&
      (e.x < 0 || e.y < 0 || e.x + e.width > cw || e.y + e.height > ch)
    ) {
      errs.push(`${at} lies outside the canvas`);
    }
  });
  return errs;
}

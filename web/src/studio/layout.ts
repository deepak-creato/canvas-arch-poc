import type { CanvasDoc, CanvasElement } from '../renderCanvas';
import type { Media } from './media';

export const PRESETS = [
  { label: 'Square 1080×1080', width: 1080, height: 1080 },
  { label: 'Story 1080×1920', width: 1080, height: 1920 },
  { label: 'Landscape 1920×1080', width: 1920, height: 1080 },
];

export const emptyDoc = (width = 1080, height = 1080): CanvasDoc => ({ version: 1, canvas: { width, height }, elements: [] });
export const newId = () => `el-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// Largest box with the media's aspect ratio that fits inside (cw, ch), centred at (cx, cy), all integers inside the canvas.
export function fitBox(m: Media | undefined, cw: number, ch: number, maxW: number, maxH: number, cx: number, cy: number) {
  const ratio = m?.width && m?.height ? m.width / m.height : 4 / 3;
  let w = Math.min(maxW, cw);
  let h = w / ratio;
  if (h > Math.min(maxH, ch)) {
    h = Math.min(maxH, ch);
    w = h * ratio;
  }
  w = Math.max(1, Math.floor(w));
  h = Math.max(1, Math.floor(h));
  const x = Math.min(Math.max(0, Math.round(cx - w / 2)), cw - w);
  const y = Math.min(Math.max(0, Math.round(cy - h / 2)), ch - h);
  return { x, y, width: w, height: h };
}

export function makeElement(m: Media | undefined, assetId: string, doc: CanvasDoc, z: number, box?: Partial<CanvasElement>): CanvasElement {
  const { width: cw, height: ch } = doc.canvas!;
  const n = doc.elements?.length ?? 0;
  const b = fitBox(m, cw, ch, cw * 0.5, ch * 0.5, cw / 2 + n * 24, ch / 2 + n * 24);
  return { id: newId(), type: m?.kind === 'VIDEO' ? 'video' : 'image', asset_id: assetId, ...b, z, fit: 'contain', ...box };
}

// Manual starting layout: a simple grid, one cell per asset.
export function gridLayout(ids: string[], media: Record<string, Media>, width: number, height: number): CanvasDoc {
  const doc = emptyDoc(width, height);
  const cols = Math.ceil(Math.sqrt(ids.length));
  const rows = Math.ceil(ids.length / cols);
  const cellW = Math.floor(width / cols);
  const cellH = Math.floor(height / rows);
  doc.elements = ids.map((id, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const b = fitBox(media[id], width, height, cellW - 40, cellH - 40, col * cellW + cellW / 2, row * cellH + cellH / 2);
    return { id: newId(), type: media[id]?.kind === 'VIDEO' ? 'video' : 'image', asset_id: id, ...b, z: i, fit: 'contain' };
  });
  return doc;
}

export const assetIdsOf = (doc?: CanvasDoc) => [...new Set((doc?.elements ?? []).map((e) => e.asset_id))];

// Keep elements inside the canvas after a size change.
export function clampDoc(doc: CanvasDoc, width: number, height: number): CanvasDoc {
  return {
    ...doc,
    canvas: { width, height },
    elements: (doc.elements ?? []).map((e) => {
      const w = Math.min(e.width, width);
      const h = Math.min(e.height, height);
      return { ...e, width: w, height: h, x: Math.min(Math.max(0, e.x), width - w), y: Math.min(Math.max(0, e.y), height - h) };
    }),
  };
}

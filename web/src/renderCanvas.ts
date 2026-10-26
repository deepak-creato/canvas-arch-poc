// Draws a draft document onto an offscreen canvas and returns PNG bytes (client-side render; no server composition).

export interface CanvasElement {
  id: string;
  type: 'image' | 'video';
  asset_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  fit?: string;
}
export interface CanvasDoc {
  version?: number;
  canvas?: { width: number; height: number };
  elements?: CanvasElement[];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const hasPngSignature = (b: Uint8Array) => PNG_SIGNATURE.every((v, i) => b[i] === v);

// Draw order is by z. Placeholders are drawn when the image is not supplied, so the render never blocks on media.
export function drawDoc(ctx: CanvasRenderingContext2D, doc: CanvasDoc, images: Map<string, CanvasImageSource>) {
  const { width, height } = doc.canvas ?? { width: 1080, height: 1080 };
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  for (const el of [...(doc.elements ?? [])].sort((a, b) => a.z - b.z)) {
    const img = images.get(el.asset_id);
    if (img) {
      const iw = Number((img as any).naturalWidth ?? (img as any).videoWidth ?? el.width);
      const ih = Number((img as any).naturalHeight ?? (img as any).videoHeight ?? el.height);
      const s = Math.min(el.width / iw, el.height / ih);
      const w = iw * s;
      const h = ih * s;
      ctx.drawImage(img, el.x + (el.width - w) / 2, el.y + (el.height - h) / 2, w, h);
    } else {
      ctx.fillStyle = el.type === 'video' ? '#9cf' : '#cf9';
      ctx.fillRect(el.x, el.y, el.width, el.height);
      ctx.fillStyle = '#000';
      ctx.fillText(el.id, el.x + 4, el.y + 14);
    }
  }
}

export async function renderPng(doc: CanvasDoc, images: Map<string, CanvasImageSource>): Promise<Blob> {
  const { width, height } = doc.canvas ?? { width: 1080, height: 1080 };
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  drawDoc(c.getContext('2d')!, doc, images);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
}

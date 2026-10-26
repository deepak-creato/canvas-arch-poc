import { useRef } from 'react';
import type { CanvasDoc, CanvasElement } from '../renderCanvas';
import type { Media } from './media';

type Handle = 'nw' | 'ne' | 'sw' | 'se';
interface Gesture {
  mode: 'move' | Handle;
  id: string;
  sx: number;
  sy: number;
  o: CanvasElement;
}

const MIN = 24;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

interface Props {
  doc: CanvasDoc;
  media: Record<string, Media>;
  maxW?: number;
  maxH?: number;
  editable?: boolean;
  selectedId?: string;
  onSelect?: (id?: string) => void;
  onBegin?: () => void; // called once at the start of a drag, so the editor can snapshot for undo
  onChange?: (doc: CanvasDoc) => void;
}

// Positioned DOM stage. Coordinates in the document are canvas pixels; `scale` maps them to screen pixels.
export function Stage({ doc, media, maxW = 640, maxH = 520, editable, selectedId, onSelect, onBegin, onChange }: Props) {
  const { width: cw, height: ch } = doc.canvas!;
  const scale = Math.min(maxW / cw, maxH / ch);
  const g = useRef<Gesture | null>(null);
  const elements = [...(doc.elements ?? [])].sort((a, b) => a.z - b.z);

  const patch = (id: string, p: Partial<CanvasElement>) => onChange?.({ ...doc, elements: doc.elements!.map((e) => (e.id === id ? { ...e, ...p } : e)) });

  function start(e: React.PointerEvent, el: CanvasElement, mode: Gesture['mode']) {
    if (!editable) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect?.(el.id);
    onBegin?.();
    g.current = { mode, id: el.id, sx: e.clientX, sy: e.clientY, o: el };
  }

  function move(e: React.PointerEvent) {
    const s = g.current;
    if (!s) return;
    const dx = (e.clientX - s.sx) / scale;
    const dy = (e.clientY - s.sy) / scale;
    const { o } = s;
    if (s.mode === 'move') {
      patch(s.id, { x: Math.round(clamp(o.x + dx, 0, cw - o.width)), y: Math.round(clamp(o.y + dy, 0, ch - o.height)) });
      return;
    }
    // Corner resize keeps the aspect ratio and the opposite corner fixed.
    const ratio = o.width / o.height;
    const left = s.mode === 'nw' || s.mode === 'sw';
    const top = s.mode === 'nw' || s.mode === 'ne';
    const maxByX = left ? o.x + o.width : cw - o.x;
    const maxByY = (top ? o.y + o.height : ch - o.y) * ratio;
    const w = Math.round(clamp(left ? o.width - dx : o.width + dx, MIN, Math.min(maxByX, maxByY)));
    const h = Math.max(1, Math.round(w / ratio));
    patch(s.id, { width: w, height: h, x: left ? o.x + o.width - w : o.x, y: top ? o.y + o.height - h : o.y });
  }

  return (
    <div className="stage" style={{ width: cw * scale, height: ch * scale }} onPointerDown={() => editable && onSelect?.(undefined)}>
      {elements.map((el) => {
        const m = media[el.asset_id];
        const sel = editable && el.id === selectedId;
        return (
          <div
            key={el.id}
            className={`el${sel ? ' sel' : ''}${editable ? ' editable' : ''}`}
            style={{ left: el.x * scale, top: el.y * scale, width: el.width * scale, height: el.height * scale, zIndex: el.z }}
            onPointerDown={(e) => start(e, el, 'move')}
            onPointerMove={move}
            onPointerUp={() => (g.current = null)}
            onPointerCancel={() => (g.current = null)}
          >
            {m?.display ? <img src={m.display} alt="" draggable={false} /> : <div className="ph">{m ? m.status : 'loading'}</div>}
            {el.type === 'video' && <span className="vtag">▶ video</span>}
            {sel &&
              (['nw', 'ne', 'sw', 'se'] as Handle[]).map((h) => <span key={h} className={`handle ${h}`} onPointerDown={(e) => start(e, el, h)} />)}
          </div>
        );
      })}
    </div>
  );
}

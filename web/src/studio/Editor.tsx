import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get, put } from '../api';
import { ErrorBanner, type KnownAsset } from '../components/ui';
import type { CanvasDoc } from '../renderCanvas';
import { Stage } from './Stage';
import { PRESETS, assetIdsOf, clampDoc, makeElement } from './layout';
import { useMedia } from './media';

interface Props {
  draftId: string;
  library: KnownAsset[];
  onPublish: () => void;
}

const AUTOSAVE_MS = 2000;

export function Editor({ draftId, library, onPublish }: Props) {
  const [doc, setDoc] = useState<CanvasDoc>();
  const [head, setHead] = useState(0);
  const [status, setStatus] = useState('ACTIVE');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sel, setSel] = useState<string>();
  const [error, setError] = useState<unknown>();
  const [savedAt, setSavedAt] = useState('');
  const history = useRef<CanvasDoc[]>([]);

  const media = useMedia([...assetIdsOf(doc), ...library.map((a) => a.asset_id)]);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const d = await get(`/v1/drafts/${draftId}`);
      setDoc(d.revision.document);
      setHead(d.head_revision);
      setStatus(d.status);
      setDirty(false);
      history.current = [];
    } catch (e) {
      setError(e);
    }
  }, [draftId]);
  useEffect(() => void load(), [load]);

  const frozen = status !== 'ACTIVE';

  const save = useCallback(async (): Promise<boolean> => {
    if (!doc || frozen) return true;
    setSaving(true);
    setError(undefined);
    try {
      const r = await put(`/v1/drafts/${draftId}`, { base_revision: head, document: doc });
      setHead(r.head_revision);
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString());
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setSaving(false);
    }
  }, [doc, draftId, head, frozen]);

  // Autosave a moment after the last change.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!dirty || frozen) return;
    const t = setTimeout(() => void saveRef.current(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [dirty, doc, frozen]);

  const edit = (next: CanvasDoc) => {
    setDoc(next);
    setDirty(true);
  };
  const begin = () => {
    if (doc) history.current = [...history.current.slice(-49), doc];
  };
  const undo = () => {
    const prev = history.current.pop();
    if (prev) edit(prev);
  };

  // Layers: highest z first. Reorder by swapping, then renumber z to 0..n-1.
  const layers = [...(doc?.elements ?? [])].sort((a, b) => b.z - a.z);
  const reorder = (ordered: typeof layers) => {
    begin();
    const byTop = ordered.map((e, i) => ({ ...e, z: ordered.length - 1 - i }));
    edit({ ...doc!, elements: byTop });
  };
  const moveLayer = (id: string, dir: -1 | 1) => {
    const i = layers.findIndex((l) => l.id === id);
    const j = i + dir;
    if (j < 0 || j >= layers.length) return;
    const next = [...layers];
    [next[i], next[j]] = [next[j], next[i]];
    reorder(next);
  };
  const remove = (id: string) => {
    begin();
    const rest = layers.filter((l) => l.id !== id);
    edit({ ...doc!, elements: rest.map((e, i) => ({ ...e, z: rest.length - 1 - i })) });
    if (sel === id) setSel(undefined);
  };
  const add = (assetId: string) => {
    begin();
    const el = makeElement(media[assetId], assetId, doc!, layers.length);
    edit({ ...doc!, elements: [...(doc!.elements ?? []), el] });
    setSel(el.id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || !doc || frozen) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        return undo();
      }
      if (!sel) return;
      if (e.key === 'Delete' || e.key === 'Backspace') return remove(sel);
      const step = e.shiftKey ? 10 : 1;
      const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (!d[e.key]) return;
      e.preventDefault();
      const { width: cw, height: ch } = doc.canvas!;
      edit({
        ...doc,
        elements: doc.elements!.map((el) =>
          el.id === sel ? { ...el, x: Math.min(Math.max(0, el.x + d[e.key][0]), cw - el.width), y: Math.min(Math.max(0, el.y + d[e.key][1]), ch - el.height) } : el,
        ),
      });
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  if (!doc) return <div>{error ? <ErrorBanner error={error} /> : 'Loading draft…'}</div>;
  const conflict = error instanceof ApiError && error.code === 'REVISION_CONFLICT';
  const usable = library.filter((a) => media[a.asset_id]?.status === 'READY');
  const presetIdx = PRESETS.findIndex((p) => p.width === doc.canvas!.width && p.height === doc.canvas!.height);

  return (
    <div>
      <div className="toolbar">
        <h2>Edit your design</h2>
        <select
          value={presetIdx}
          disabled={frozen}
          onChange={(e) => {
            const p = PRESETS[Number(e.target.value)];
            if (p) {
              begin();
              edit(clampDoc(doc, p.width, p.height));
            }
          }}
        >
          {presetIdx < 0 && <option value={-1}>{doc.canvas!.width}×{doc.canvas!.height}</option>}
          {PRESETS.map((p, i) => (
            <option key={p.label} value={i}>{p.label}</option>
          ))}
        </select>
        <button disabled={frozen || !history.current.length} onClick={undo}>↶ Undo</button>
        <span className="dim">{frozen ? `Read only (${status})` : saving ? 'Saving…' : dirty ? 'Unsaved changes' : savedAt ? `Draft saved ${savedAt} · v${head}` : `v${head}`}</span>
        <button disabled={frozen || saving || !dirty} onClick={() => void save()}>Save draft</button>
        <button
          className="primary"
          disabled={saving || (!frozen && (doc.elements ?? []).length === 0)}
          onClick={async () => {
            if (await save()) onPublish();
          }}
        >
          Publish →
        </button>
      </div>
      {conflict ? (
        <div className="error">This draft changed elsewhere. <button onClick={() => void load()}>Reload latest</button></div>
      ) : (
        <ErrorBanner error={error} />
      )}
      <div className="editor">
        <div className="canvas-col">
          <Stage doc={doc} media={media} editable={!frozen} selectedId={sel} onSelect={setSel} onBegin={begin} onChange={edit} />
          <p className="dim">Drag to move, drag corners to resize, arrows nudge (Shift = 10), Delete removes.</p>
        </div>
        <aside>
          <h3>Layers</h3>
          <ul className="layers">
            {layers.map((l, i) => (
              <li key={l.id} className={l.id === sel ? 'on' : ''} onClick={() => setSel(l.id)}>
                {media[l.asset_id]?.thumb ? <img src={media[l.asset_id].thumb} alt="" /> : <span className="ph" />}
                <span className="name">{media[l.asset_id]?.filename ?? l.id}</span>
                <button title="Bring forward" disabled={frozen || i === 0} onClick={(e) => (e.stopPropagation(), moveLayer(l.id, -1))}>▲</button>
                <button title="Send backward" disabled={frozen || i === layers.length - 1} onClick={(e) => (e.stopPropagation(), moveLayer(l.id, 1))}>▼</button>
                <button title="Delete" disabled={frozen} onClick={(e) => (e.stopPropagation(), remove(l.id))}>✕</button>
              </li>
            ))}
            {layers.length === 0 && <li className="dim">No layers. Add one below.</li>}
          </ul>
          <h3>Add from library</h3>
          <div className="mini">
            {usable.map((a) => (
              <button key={a.asset_id} disabled={frozen} title={a.filename} onClick={() => add(a.asset_id)}>
                <img src={media[a.asset_id].thumb} alt={a.filename} />
              </button>
            ))}
            {usable.length === 0 && <span className="dim">Nothing ready yet.</span>}
          </div>
        </aside>
      </div>
    </div>
  );
}

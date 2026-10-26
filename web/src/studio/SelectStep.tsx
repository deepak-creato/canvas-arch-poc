import { useRef, useState } from 'react';
import { post, putPresigned } from '../api';
import { sha256Hex } from '../hash';
import { ErrorBanner, type KnownAsset } from '../components/ui';
import { useMedia, type Media } from './media';

interface Props {
  assets: KnownAsset[];
  setAssets: (f: (a: KnownAsset[]) => KnownAsset[]) => void;
  selected: string[];
  setSelected: (ids: string[]) => void;
  onNext: (media: Record<string, Media>) => void;
}

export function SelectStep({ assets, setAssets, selected, setSelected, onNext }: Props) {
  const media = useMedia(assets.map((a) => a.asset_id));
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<unknown>();
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function uploadFile(f: File) {
    const data = await f.arrayBuffer();
    const sha256 = await sha256Hex(data);
    const up = await post('/v1/uploads', { sha256, content_type: f.type, size_bytes: data.byteLength, filename: f.name });
    if (up.upload_url) await putPresigned(up.upload_url, new Blob([data], { type: f.type }), f.type);
    setAssets((a) => (a.some((x) => x.asset_id === up.asset_id) ? a : [{ asset_id: up.asset_id, filename: f.name, content_type: f.type }, ...a]));
    setSelected([...new Set([...selectedRef.current, up.asset_id])]);
  }
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  async function addFiles(files: FileList | File[]) {
    setError(undefined);
    for (const f of Array.from(files)) {
      setBusy((n) => n + 1);
      try {
        await uploadFile(f);
      } catch (e) {
        setError(e);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  }

  const toggle = (id: string) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const ready = selected.length > 0 && selected.every((id) => media[id]?.status === 'READY');
  const processing = selected.some((id) => media[id] && !['READY', 'FAILED', 'REJECTED', 'EXPIRED'].includes(media[id].status));

  return (
    <div>
      <h2>Choose your photos and videos</h2>
      <div
        className={`drop${drag ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void addFiles(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
      >
        {busy > 0 ? `Uploading ${busy}…` : 'Drop files here or click to browse (PNG, JPG, WebP, MP4)'}
        <input ref={input} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,video/mp4" onChange={(e) => e.target.files && void addFiles(e.target.files)} />
      </div>
      <ErrorBanner error={error} />
      <div className="library">
        {assets.map((a) => {
          const m = media[a.asset_id];
          const bad = m && ['FAILED', 'REJECTED', 'EXPIRED'].includes(m.status);
          const on = selected.includes(a.asset_id);
          return (
            <button key={a.asset_id} disabled={!!bad} className={`tile${on ? ' on' : ''}`} onClick={() => toggle(a.asset_id)}>
              {m?.thumb ? <img src={m.thumb} alt={a.filename} /> : <div className="ph">{m?.status ?? '…'}</div>}
              {m?.kind === 'VIDEO' && <span className="vtag">▶</span>}
              {on && <span className="check">✓</span>}
              <span className="cap">{bad ? `Can't use: ${m.reject_reason ?? m.status}` : m && m.status !== 'READY' ? 'Processing…' : a.filename}</span>
            </button>
          );
        })}
        {assets.length === 0 && <p className="dim">No files yet.</p>}
      </div>
      <div className="actions">
        <span className="dim">{selected.length} selected{processing ? ' · waiting for processing' : ''}</span>
        <button className="primary" disabled={!ready} onClick={() => onNext(media)}>Next: AI layout →</button>
      </div>
    </div>
  );
}

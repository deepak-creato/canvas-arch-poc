import { useState } from 'react';
import { get, post, putPresigned, errText } from '../api';
import { sha256Hex } from '../hash';
import { usePoll } from '../usePoll';
import { ErrorBanner, JsonView, StatusBadge, type KnownAsset } from '../components/ui';

const FIXTURES = [
  ['sample-1.png', 'image/png'],
  ['sample.mp4', 'video/mp4'],
  ['fake.png', 'image/png'],
  ['corrupt.png', 'image/png'],
  ['corrupt.mp4', 'video/mp4'],
] as const;
const TERMINAL = ['READY', 'FAILED', 'REJECTED', 'EXPIRED'];

export function Assets({ assets, setAssets }: { assets: KnownAsset[]; setAssets: (f: (a: KnownAsset[]) => KnownAsset[]) => void }) {
  const [error, setError] = useState<unknown>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<string>();

  async function upload(name: string, type: string, data: ArrayBuffer) {
    setBusy(true);
    setError(undefined);
    try {
      const sha256 = await sha256Hex(data);
      const up = await post('/v1/uploads', { sha256, content_type: type, size_bytes: data.byteLength, filename: name });
      if (up.upload_url) {
        await putPresigned(up.upload_url, new Blob([data], { type }), type);
        setNote(`${name}: uploaded (deduplicated=${up.deduplicated})`);
      } else {
        setNote(`${name}: no upload needed (deduplicated=${up.deduplicated}, upload_status=${up.upload_status})`);
      }
      setAssets((a) => (a.some((x) => x.asset_id === up.asset_id) ? a : [{ asset_id: up.asset_id, filename: name, content_type: type }, ...a]));
      setSel(up.asset_id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(f: File | undefined) {
    if (f) await upload(f.name, f.type, await f.arrayBuffer());
  }
  async function onFixture(name: string, type: string) {
    const r = await fetch(`/fixtures/${name}`);
    await upload(name, type, await r.arrayBuffer());
  }

  return (
    <section>
      <h2>Upload</h2>
      <input type="file" accept="image/png,image/jpeg,image/webp,video/mp4" disabled={busy} onChange={(e) => onFile(e.target.files?.[0])} />
      <div className="row">
        Fixtures:
        {FIXTURES.map(([n, t]) => (
          <button key={n} disabled={busy} onClick={() => onFixture(n, t).catch(setError)}>
            {n}
          </button>
        ))}
      </div>
      {note && <p>{note}</p>}
      <ErrorBanner error={error} />
      <h2>Known assets (this owner)</h2>
      <table>
        <tbody>
          {assets.map((a) => (
            <tr key={a.asset_id} className={a.asset_id === sel ? 'sel' : ''} onClick={() => setSel(a.asset_id)}>
              <td>{a.filename}</td>
              <td>{a.asset_id}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sel && <AssetDetail key={sel} id={sel} />}
    </section>
  );
}

function AssetDetail({ id }: { id: string }) {
  const [err, setErr] = useState<unknown>();
  const { value: a, error } = usePoll(() => get(`/v1/assets/${id}`), (v) => TERMINAL.includes(v.processing_status), true);
  return (
    <div>
      <h3>
        {id} <StatusBadge s={a?.processing_status} /> <StatusBadge s={a?.upload_status} />
      </h3>
      <button onClick={() => post(`/v1/uploads/${id}/complete`).catch(setErr)}>complete (optional)</button>
      <ErrorBanner error={err ?? error} />
      {a?.reject_reason && <p className="error">reject_reason: {a.reject_reason}</p>}
      <div className="grid">
        {a?.renditions?.map((r: any) => (
          <figure key={r.kind}>
            {r.url && r.content_type?.startsWith('image/') && <img src={r.url} alt={r.kind} />}
            {r.url && r.content_type?.startsWith('video/') && <video src={r.url} controls />}
            <figcaption>
              {r.kind} <StatusBadge s={r.status} /> {r.width ? `${r.width}x${r.height}` : ''}
              {r.error && <span className="error"> {errText(r.error)}</span>}
            </figcaption>
          </figure>
        ))}
      </div>
      {a && <JsonView v={a} />}
    </div>
  );
}

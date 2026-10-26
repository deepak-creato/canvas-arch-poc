import { useState } from 'react';
import { get, post, putPresigned } from '../api';
import { usePoll } from '../usePoll';
import { renderPng } from '../renderCanvas';
import { ErrorBanner, JsonView, StatusBadge, useStored } from '../components/ui';

export function Publish({ draftId }: { draftId?: string }) {
  const [pubId, setPubId] = useStored<Record<string, string>>('canvas-poc.pubs', {});
  const [revision, setRevision] = useState('');
  const [key, setKey] = useState<string>(() => crypto.randomUUID());
  const [failMode, setFailMode] = useState('');
  const [error, setError] = useState<unknown>();
  const [note, setNote] = useState('');
  const pid = draftId ? pubId[draftId] : undefined;

  const { value: pub } = usePoll(() => get(`/v1/publications/${pid}`), (v) => ['LIVE'].includes(v.status), !!pid);
  const { value: st } = usePoll(() => get(`/v1/drafts/${draftId}/status`), () => false, !!draftId, 2000);

  if (!draftId) return <p>Select a draft first (Drafts tab).</p>;
  const run = async (f: () => Promise<void>) => {
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError(e);
    }
  };

  const publish = () =>
    run(async () => {
      const rev = revision ? Number(revision) : st?.head_revision;
      const r = await post(`/v1/drafts/${draftId}/publications`, { revision: rev, ...(failMode ? { test_fail_mode: failMode } : {}) }, { headers: { 'Idempotency-Key': key } });
      setNote(`HTTP ${r._status}${r.idempotent_replay ? ' (idempotent replay)' : ''}`);
      setPubId({ ...pubId, [draftId]: r.publication_id });
    });

  // Upload a canvas render: either rendered from the draft document or a bundled fixture.
  const uploadCanvas = (source: 'render' | 'png' | 'mp4') =>
    run(async () => {
      let blob: Blob;
      let type: string;
      if (source === 'render') {
        const d = await get(`/v1/drafts/${draftId}`);
        blob = await renderPng(d.revision.document, new Map());
        type = 'image/png';
      } else {
        type = source === 'png' ? 'image/png' : 'video/mp4';
        blob = await (await fetch(`/fixtures/canvas-render.${source}`)).blob();
      }
      const u = await post(`/v1/publications/${pid}/canvas-upload`, { content_type: type, size_bytes: blob.size });
      await putPresigned(u.upload_url, blob, type);
      await post(`/v1/publications/${pid}/canvas-uploaded`, { content_type: type });
      setNote(`canvas uploaded (${type}, ${blob.size} bytes)`);
    });

  return (
    <section>
      <p>Draft {draftId} <StatusBadge s={st?.draft_status} /> can_publish={String(st?.can_publish)} assets: <StatusBadge s={st?.assets_status} /></p>
      <div className="row">
        revision <input value={revision} onChange={(e) => setRevision(e.target.value)} placeholder={String(st?.head_revision ?? 'head')} size={5} />
        Idempotency-Key <input value={key} onChange={(e) => setKey(e.target.value)} size={38} />
        <button onClick={() => setKey(crypto.randomUUID())}>new key</button>
        test_fail_mode
        <select value={failMode} onChange={(e) => setFailMode(e.target.value)}>
          <option value="">none</option>
          <option value="permanent">permanent</option>
          <option value="transient:1">transient:1</option>
          <option value="transient:2">transient:2</option>
        </select>
        <button onClick={publish}>Publish</button>
      </div>
      <ErrorBanner error={error} />
      {note && <p>{note}</p>}
      {pid && pub && (
        <div>
          <h3>{pid} <StatusBadge s={pub.status} /> attempt {pub.attempt}</h3>
          {pub.failure_reason && <p className="error">{pub.failure_reason}</p>}
          {pub.status === 'AWAITING_CANVAS' && (
            <div className="row">
              <button onClick={() => uploadCanvas('render')}>Render + upload PNG</button>
              <button onClick={() => uploadCanvas('png')}>Upload fixture PNG</button>
              <button onClick={() => uploadCanvas('mp4')}>Upload fixture MP4</button>
            </div>
          )}
          {pub.status === 'FAILED' && (
            <div className="row">
              <button onClick={() => run(async () => void (await post(`/v1/publications/${pid}/retry`)))}>Retry</button>
              <button onClick={() => uploadCanvas('png')}>Upload fixture PNG</button>
              <button onClick={() => run(async () => void (await post(`/v1/publications/${pid}/canvas-uploaded`, { content_type: 'image/png' })))}>canvas-uploaded</button>
            </div>
          )}
          {pub.status === 'LIVE' && (
            <div>
              {pub.render?.url && pub.render.content_type?.startsWith('image/') && <img className="render" src={pub.render.url} alt="render" />}
              {pub.render?.url && pub.render.content_type?.startsWith('video/') && <video className="render" src={pub.render.url} controls />}
              <p><a href={pub.manifest_url} target="_blank">manifest</a></p>
            </div>
          )}
          <h4>Transitions</h4>
          <table>
            <tbody>
              {pub.transitions?.map((t: any, i: number) => (
                <tr key={i}><td>{t.at}</td><td>{t.from} → {t.to}</td><td>{t.step}</td></tr>
              ))}
            </tbody>
          </table>
          <JsonView v={pub} />
        </div>
      )}
      {st && <JsonView v={st} />}
    </section>
  );
}

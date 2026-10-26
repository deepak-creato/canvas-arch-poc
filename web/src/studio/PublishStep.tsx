import { useEffect, useRef, useState } from 'react';
import { ApiError, get, post, putPresigned } from '../api';
import { usePoll } from '../usePoll';
import { renderPng, type CanvasDoc } from '../renderCanvas';
import { ErrorBanner } from '../components/ui';
import { Stage } from './Stage';
import { assetIdsOf } from './layout';
import { fetchMedia, useMedia, type Media } from './media';

const STEPS = [
  ['REQUESTED', 'Queued'],
  ['WAITING_FOR_ASSETS', 'Preparing media'],
  ['TRANSCODING', 'Processing video'],
  ['AWAITING_CANVAS', 'Rendering your design'],
  ['FINALIZING', 'Finalizing'],
  ['LIVE', 'Published'],
] as const;

function loadImage(url: string): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(undefined);
    img.src = url;
  });
}

export function PublishStep({ draftId, onDone }: { draftId: string; onDone: () => void }) {
  const [draft, setDraft] = useState<any>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [renderErr, setRenderErr] = useState('');
  const key = useRef(crypto.randomUUID());
  const uploaded = useRef(new Set<string>());

  useEffect(() => {
    get(`/v1/drafts/${draftId}`).then(setDraft, setError);
  }, [draftId]);
  const doc: CanvasDoc | undefined = draft?.revision.document;
  const media = useMedia(assetIdsOf(doc));

  const { value: st } = usePoll(() => get(`/v1/drafts/${draftId}/status`), () => false, true, 1500);
  const pid: string | undefined = st?.publication?.publication_id;
  const { value: pub } = usePoll(() => get(`/v1/publications/${pid}`), (v) => v.status === 'LIVE', !!pid, 1000);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
    } catch (e) {
      // A second click or reload can race a publication that already exists; the status poll picks it up.
      if (!(e instanceof ApiError && e.code === 'PUBLICATION_EXISTS')) setError(e);
    } finally {
      setBusy(false);
    }
  };

  const publish = () => run(async () => void (await post(`/v1/drafts/${draftId}/publications`, { revision: draft.head_revision }, { headers: { 'Idempotency-Key': key.current } })));

  // Draw the design client-side and upload the PNG through a presigned URL (no server-side composition).
  async function uploadRender() {
    setRenderErr('');
    const fresh: Record<string, Media> = {};
    for (const id of assetIdsOf(doc)) fresh[id] = await fetchMedia(id);
    const imgs = new Map<string, CanvasImageSource>();
    await Promise.all(
      Object.values(fresh).map(async (m) => {
        const img = m.display ? await loadImage(m.display) : undefined;
        if (img) imgs.set(m.asset_id, img);
      }),
    );
    let blob: Blob;
    try {
      blob = await renderPng(doc!, imgs);
    } catch {
      throw new Error('Could not render the design (image access blocked). Check the derived bucket CORS and retry.');
    }
    const u = await post(`/v1/publications/${pid}/canvas-upload`, { content_type: 'image/png', size_bytes: blob.size });
    await putPresigned(u.upload_url, blob, 'image/png');
    await post(`/v1/publications/${pid}/canvas-uploaded`, { content_type: 'image/png' });
  }

  // Render automatically once the workflow asks for it; once per publication attempt.
  useEffect(() => {
    if (!pub || pub.status !== 'AWAITING_CANVAS' || !doc) return;
    const k = `${pub.publication_id}:${pub.attempt}`;
    if (uploaded.current.has(k)) return;
    uploaded.current.add(k);
    uploadRender().catch((e) => {
      uploaded.current.delete(k);
      setRenderErr(e instanceof Error ? e.message : String(e));
    });
  }, [pub?.status, pub?.attempt, doc]);

  if (!draft || !doc) return <div>{error ? <ErrorBanner error={error} /> : 'Loading…'}</div>;

  const idx = STEPS.findIndex(([s]) => s === pub?.status);
  const failed = pub?.status === 'FAILED';

  return (
    <div>
      <h2>Publish</h2>
      <div className="center">
        {pub?.status === 'LIVE' && pub.render?.url ? <img className="final" src={pub.render.url} alt="Published design" /> : <Stage doc={doc} media={media} maxW={420} maxH={380} />}
      </div>
      <ErrorBanner error={error} />
      {!pid && (
        <div className="actions">
          <span className="dim">Revision v{draft.head_revision} will be frozen once published.</span>
          <button className="primary" disabled={busy || !st?.can_publish} onClick={publish}>Publish now</button>
        </div>
      )}
      {pub && (
        <div>
          <ol className="progress">
            {STEPS.map(([s, label], i) => (
              <li key={s} className={failed ? (i < idx ? 'done' : '') : i < idx || pub.status === 'LIVE' ? 'done' : i === idx ? 'now' : ''}>{label}</li>
            ))}
          </ol>
          {failed && (
            <div className="error">
              Publishing failed{pub.failure_reason ? `: ${pub.failure_reason}` : ''}.{' '}
              <button disabled={busy} onClick={() => run(async () => void (await post(`/v1/publications/${pid}/retry`)))}>Retry</button>
            </div>
          )}
          {renderErr && (
            <div className="error">
              {renderErr}{' '}
              <button onClick={() => uploaded.current.clear()}>Try again</button>
            </div>
          )}
          {pub.status === 'LIVE' && (
            <div className="actions">
              <span>🎉 Your design is live.</span>
              {pub.manifest_url && <a href={pub.manifest_url} target="_blank" rel="noreferrer">Manifest</a>}
              {pub.render?.url && <a href={pub.render.url} target="_blank" rel="noreferrer">Open image</a>}
              <button className="primary" onClick={onDone}>Back to my designs</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

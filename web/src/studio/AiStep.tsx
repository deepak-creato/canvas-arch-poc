import { useState } from 'react';
import { get, post, put } from '../api';
import { usePoll } from '../usePoll';
import { ErrorBanner } from '../components/ui';
import { Stage } from './Stage';
import { PRESETS, emptyDoc, gridLayout } from './layout';
import { useMedia } from './media';

interface Props {
  selected: string[];
  draftId?: string;
  setDraftId: (id: string) => void;
  onNext: () => void;
}

export function AiStep({ selected, draftId, setDraftId, onNext }: Props) {
  const media = useMedia(selected);
  const [preset, setPreset] = useState(0);
  const [seed, setSeed] = useState(1);
  const [gen, setGen] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const size = PRESETS[preset];

  const { value: polled } = usePoll(
    () => get(`/v1/ai-layouts/${gen.generation_id}`),
    (v) => ['READY', 'FAILED'].includes(v.status),
    !!gen && !['READY', 'FAILED'].includes(gen.status),
  );
  const cur = polled ?? gen;
  const working = !!cur && !['READY', 'FAILED'].includes(cur.status);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  async function ensureDraft() {
    if (draftId) return draftId;
    const d = await post('/v1/drafts', { document: emptyDoc(size.width, size.height) });
    setDraftId(d.draft_id);
    return d.draft_id as string;
  }

  const generate = () =>
    run(async () => {
      const id = await ensureDraft();
      setGen(await post(`/v1/drafts/${id}/ai-layouts`, { asset_ids: selected, canvas: size, seed }));
    });

  const accept = () =>
    run(async () => {
      const head = (await get(`/v1/drafts/${draftId}`)).head_revision;
      await post(`/v1/drafts/${draftId}/ai-layouts/${cur.generation_id}/accept`, { base_revision: head });
      onNext();
    });

  const manual = () =>
    run(async () => {
      const id = await ensureDraft();
      const head = (await get(`/v1/drafts/${id}`)).head_revision;
      await put(`/v1/drafts/${id}`, { base_revision: head, document: gridLayout(selected, media, size.width, size.height) });
      onNext();
    });

  return (
    <div>
      <h2>Let AI arrange your design</h2>
      <p className="dim">{selected.length} item(s) selected. Pick a canvas size and generate a layout, or arrange everything yourself.</p>
      <div className="row">
        <select value={preset} onChange={(e) => setPreset(Number(e.target.value))} disabled={working}>
          {PRESETS.map((p, i) => (
            <option key={p.label} value={i}>{p.label}</option>
          ))}
        </select>
        <button className="primary" disabled={busy || working} onClick={generate}>{cur ? 'Generate again' : '✨ Generate layout'}</button>
        <button disabled={busy || working} onClick={() => setSeed(Math.floor(Math.random() * 1e6))}>Shuffle (seed {seed})</button>
        <button disabled={busy || working} onClick={manual}>Skip AI, arrange manually</button>
      </div>
      <ErrorBanner error={error} />
      {working && <p>Generating layout…</p>}
      {cur?.status === 'FAILED' && <div className="error">AI layout failed{cur.error ? `: ${JSON.stringify(cur.error)}` : ''}. Try again or arrange manually.</div>}
      {cur?.status === 'READY' && cur.result && (
        <div className="center">
          <Stage doc={cur.result} media={media} />
          <div className="actions">
            <button className="primary" disabled={busy} onClick={accept}>Use this layout →</button>
          </div>
        </div>
      )}
    </div>
  );
}

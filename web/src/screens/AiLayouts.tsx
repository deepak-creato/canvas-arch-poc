import { useState } from 'react';
import { get, post } from '../api';
import { usePoll } from '../usePoll';
import { ErrorBanner, JsonView, StatusBadge, type KnownAsset } from '../components/ui';
import { Preview } from '../components/Preview';

export function AiLayouts({ draftId, assets, onAccepted }: { draftId?: string; assets: KnownAsset[]; onAccepted: () => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const [seed, setSeed] = useState('1');
  const [w, setW] = useState(1080);
  const [h, setH] = useState(1080);
  const [fail, setFail] = useState(false);
  const [gen, setGen] = useState<any>();
  const [info, setInfo] = useState('');
  const [error, setError] = useState<unknown>();

  const { value: g } = usePoll(
    () => get(`/v1/ai-layouts/${gen.generation_id ?? gen.id}`),
    (v) => ['READY', 'FAILED'].includes(v.status),
    !!gen && !['READY', 'FAILED'].includes(gen.status),
  );
  const cur = g ?? gen;
  const genId = gen && (gen.generation_id ?? gen.id);
  const layout = cur?.result ?? cur?.layout;

  if (!draftId) return <p>Select a draft first (Drafts tab).</p>;

  const create = async () => {
    setError(undefined);
    try {
      const r = await post(`/v1/drafts/${draftId}/ai-layouts`, { asset_ids: sel, canvas: { width: w, height: h }, seed: Number(seed), ...(fail ? { test_fail: true } : {}) });
      setInfo(`HTTP ${r._status}${r.cached ? ' cached: true' : ''}`);
      setGen(r);
    } catch (e) {
      setError(e);
    }
  };
  const accept = async () => {
    setError(undefined);
    try {
      const d = await get(`/v1/drafts/${draftId}`);
      await post(`/v1/drafts/${draftId}/ai-layouts/${genId}/accept`, { base_revision: d.head_revision });
      setInfo('accepted: new AI_GENERATION revision');
      onAccepted();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section>
      <p>Draft {draftId}</p>
      <div className="row">
        {assets.map((a) => (
          <label key={a.asset_id}>
            <input type="checkbox" checked={sel.includes(a.asset_id)} onChange={(e) => setSel(e.target.checked ? [...sel, a.asset_id] : sel.filter((x) => x !== a.asset_id))} />
            {a.filename} {a.asset_id.slice(0, 8)}
          </label>
        ))}
      </div>
      <div className="row">
        seed <input value={seed} onChange={(e) => setSeed(e.target.value)} size={5} />
        w <input type="number" value={w} onChange={(e) => setW(+e.target.value)} />
        h <input type="number" value={h} onChange={(e) => setH(+e.target.value)} />
        <label><input type="checkbox" checked={fail} onChange={(e) => setFail(e.target.checked)} /> test_fail</label>
        <button disabled={!sel.length} onClick={create}>Generate</button>
      </div>
      <ErrorBanner error={error} />
      {info && <p>{info}</p>}
      {cur && (
        <div>
          <h3>{genId} <StatusBadge s={cur.status} /></h3>
          {layout && <Preview doc={layout} />}
          {cur.status === 'READY' && <button onClick={accept}>Accept into draft</button>}
          <JsonView v={cur} />
        </div>
      )}
    </section>
  );
}

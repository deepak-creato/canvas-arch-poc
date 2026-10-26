import { useEffect, useState } from 'react';
import { get, post, getOwner } from '../api';
import { ErrorBanner, JsonView } from '../components/ui';

const SERVICES = [
  ['canvas-api', '/api', '/healthz'],
  ['gc-worker', '/gc', '/healthz'],
  ['mock-transcoder', '/transcoder', '/healthz'],
] as const;

export function Ops() {
  const [health, setHealth] = useState<Record<string, boolean>>({});
  const [out, setOut] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [step, setStep] = useState('');
  const [assetId, setAssetId] = useState('');

  useEffect(() => {
    SERVICES.forEach(([n, base, p]) =>
      get(p, { base, owner: false }).then(() => setHealth((h) => ({ ...h, [n]: true })), () => setHealth((h) => ({ ...h, [n]: false }))),
    );
  }, []);
  const run = (f: () => Promise<unknown>) => {
    setError(undefined);
    f().then(setOut, setError);
  };
  const o = getOwner();

  return (
    <section>
      <div className="row">
        {SERVICES.map(([n]) => (
          <span key={n}><i className={`dot ${health[n] ? 'up' : 'down'}`} /> {n}</span>
        ))}
      </div>
      <h3>gc-worker</h3>
      <div className="row">
        step <input value={step} onChange={(e) => setStep(e.target.value)} placeholder="a,b (blank = all)" />
        <button onClick={() => run(() => post(`/run${step ? `?step=${step}` : ''}`, undefined, { base: '/gc', owner: false }))}>Run GC</button>
        <button onClick={() => run(() => get(`/ops/jobs?owner_id=${o}`, { base: '/gc', owner: false }))}>Jobs</button>
        <button onClick={() => run(() => get(`/ops/dlq?owner_id=${o}`, { base: '/gc', owner: false }))}>DLQ</button>
        <button onClick={() => run(() => post('/ops/redrive', undefined, { base: '/gc', owner: false }))}>Redrive</button>
      </div>
      <h3>mock-transcoder</h3>
      <div className="row">
        asset_id <input value={assetId} onChange={(e) => setAssetId(e.target.value)} size={38} />
        <button onClick={() => run(() => get(`/jobs?asset_id=${assetId}`, { base: '/transcoder', owner: false }))}>Job</button>
      </div>
      <ErrorBanner error={error} />
      {out !== undefined && <JsonView v={out} />}
    </section>
  );
}

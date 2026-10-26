import { useEffect, useState } from 'react';
import { del, get, getOwner, setOwner } from '../api';
import { ErrorBanner, StatusBadge, useAssets } from '../components/ui';
import { AiStep } from './AiStep';
import { Editor } from './Editor';
import { PublishStep } from './PublishStep';
import { SelectStep } from './SelectStep';
import { assetIdsOf } from './layout';
import './studio.css';

const STEPS = ['Photos', 'AI layout', 'Editor', 'Publish'] as const;

export default function Studio() {
  const [owner, setOwnerState] = useState(getOwner());
  const [assets, setAssets] = useAssets(owner);
  const [view, setView] = useState<'home' | 'wizard'>('home');
  const [step, setStep] = useState(0);
  const [draftId, setDraftId] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<any[]>([]);
  const [error, setError] = useState<unknown>();

  const loadDrafts = () =>
    get('/v1/drafts').then(
      (r) => setDrafts(r.drafts.filter((d: any) => !['DISCARDED', 'PURGED'].includes(d.status))),
      setError,
    );
  useEffect(() => {
    if (view === 'home') void loadDrafts();
  }, [view, owner]);

  const start = () => {
    setDraftId(undefined);
    setSelected([]);
    setStep(0);
    setView('wizard');
  };
  const open = async (d: any) => {
    try {
      const full = await get(`/v1/drafts/${d.draft_id}`);
      setDraftId(d.draft_id);
      setSelected(assetIdsOf(full.revision.document));
      setStep(d.status === 'ACTIVE' ? 2 : 3);
      setView('wizard');
    } catch (e) {
      setError(e);
    }
  };
  const changeOwner = (o: string) => {
    setOwner(o);
    setOwnerState(o);
    setView('home');
  };

  return (
    <div className="studio">
      <header>
        <b onClick={() => setView('home')} className="brand">Canvas Studio</b>
        {view === 'wizard' && (
          <ol className="stepper">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? 'now' : i < step ? 'done' : ''}>
                <button disabled={i >= step || step === 3 || (i > 0 && !draftId && i > 1)} onClick={() => setStep(i)}>{i + 1}. {s}</button>
              </li>
            ))}
          </ol>
        )}
        <span className="spacer" />
        <label className="dim">
          Signed in as <input value={owner} size={10} onChange={(e) => changeOwner(e.target.value)} />
        </label>
        <a className="dim" href="#/dev">Developer console</a>
      </header>
      <main>
        {view === 'home' && (
          <div>
            <div className="toolbar">
              <h2>My designs</h2>
              <button className="primary" onClick={start}>+ New design</button>
            </div>
            <ErrorBanner error={error} />
            <div className="cards">
              {drafts.map((d) => (
                <div key={d.draft_id} className="card">
                  <div className="title">Design {d.draft_id.slice(0, 8)}</div>
                  <StatusBadge s={d.status} />
                  <div className="dim">v{d.head_revision} · {new Date(d.updated_at).toLocaleString()}</div>
                  <div className="actions">
                    <button onClick={() => open(d)}>{d.status === 'ACTIVE' ? 'Edit' : 'View'}</button>
                    {d.status === 'ACTIVE' && (
                      <button onClick={() => del(`/v1/drafts/${d.draft_id}`).then(loadDrafts, setError)}>Delete</button>
                    )}
                  </div>
                </div>
              ))}
              {drafts.length === 0 && <p className="dim">No designs yet. Start a new one.</p>}
            </div>
          </div>
        )}
        {view === 'wizard' && step === 0 && <SelectStep assets={assets} setAssets={setAssets} selected={selected} setSelected={setSelected} onNext={() => setStep(1)} />}
        {view === 'wizard' && step === 1 && <AiStep selected={selected} draftId={draftId} setDraftId={setDraftId} onNext={() => setStep(2)} />}
        {view === 'wizard' && step === 2 && draftId && <Editor draftId={draftId} library={assets} onPublish={() => setStep(3)} />}
        {view === 'wizard' && step === 3 && draftId && <PublishStep draftId={draftId} onDone={() => setView('home')} />}
      </main>
    </div>
  );
}

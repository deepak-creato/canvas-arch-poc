import { useState } from 'react';
import { getOwner, setOwner } from './api';
import { RequestLog, useAssets, useStored } from './components/ui';
import { Assets } from './screens/Assets';
import { Drafts } from './screens/Drafts';
import { AiLayouts } from './screens/AiLayouts';
import { Publish } from './screens/Publish';
import { Ops } from './screens/Ops';

const TABS = ['Assets', 'Drafts', 'AI layouts', 'Publish', 'Ops'] as const;

export default function App() {
  const [owner, setOwnerState] = useState(getOwner());
  const [tab, setTab] = useState<(typeof TABS)[number]>('Assets');
  const [draftId, setDraftId] = useStored<string | undefined>('canvas-poc.draft', undefined);
  const [assets, setAssets] = useAssets(owner);
  const [bump, setBump] = useState(0);

  const changeOwner = (o: string) => {
    setOwner(o);
    setOwnerState(o);
    setDraftId(undefined);
  };

  return (
    <div className="app">
      <header>
        <b>Canvas POC</b>
        <label>
          owner{' '}
          <input value={owner} onChange={(e) => changeOwner(e.target.value)} size={12} />
        </label>
        <button onClick={() => changeOwner('owner-a')}>A</button>
        <button onClick={() => changeOwner('owner-b')}>B</button>
        <nav>
          {TABS.map((t) => (
            <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
        <span className="dim">draft: {draftId ?? 'none'}</span>
      </header>
      <main>
        {tab === 'Assets' && <Assets assets={assets} setAssets={setAssets} />}
        {tab === 'Drafts' && <Drafts draftId={draftId} setDraftId={setDraftId} assets={assets} bump={bump} />}
        {tab === 'AI layouts' && <AiLayouts draftId={draftId} assets={assets} onAccepted={() => { setBump(bump + 1); setTab('Drafts'); }} />}
        {tab === 'Publish' && <Publish draftId={draftId} />}
        {tab === 'Ops' && <Ops />}
      </main>
      <RequestLog />
    </div>
  );
}

import { useEffect, useState } from 'react';
import { get, post, put, del } from '../api';
import { ErrorBanner, JsonView, StatusBadge, type KnownAsset } from '../components/ui';
import { Preview } from '../components/Preview';
import type { CanvasDoc } from '../renderCanvas';

const EMPTY: CanvasDoc = { version: 1, canvas: { width: 1080, height: 1080 }, elements: [] };

export function Drafts({ draftId, setDraftId, assets, bump }: { draftId?: string; setDraftId: (id?: string) => void; assets: KnownAsset[]; bump: number }) {
  const [list, setList] = useState<any[]>([]);
  const [draft, setDraft] = useState<any>();
  const [revs, setRevs] = useState<any[]>([]);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState<unknown>();
  const [pick, setPick] = useState('');

  const run = async (f: () => Promise<void>) => {
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError(e);
    }
  };
  const load = (d: any) => {
    setDraft(d);
    setText(JSON.stringify(d.revision.document, null, 2));
  };
  const refreshList = () => run(async () => setList((await get('/v1/drafts')).drafts));
  const refresh = (id = draftId) =>
    run(async () => {
      if (!id) return;
      load(await get(`/v1/drafts/${id}`));
      setRevs((await get(`/v1/drafts/${id}/revisions`)).revisions);
    });

  useEffect(() => void refreshList(), []);
  useEffect(() => void refresh(), [draftId, bump]);

  let doc: CanvasDoc = EMPTY;
  let parseErr = '';
  try {
    doc = JSON.parse(text || '{}');
  } catch (e) {
    parseErr = String(e);
  }

  const addAsset = () => {
    const a = assets.find((x) => x.asset_id === pick);
    if (!a) return;
    const d: CanvasDoc = { ...EMPTY, ...doc, elements: [...(doc.elements ?? [])] };
    const n = d.elements!.length;
    d.elements!.push({ id: `el-${n + 1}`, type: a.content_type.startsWith('video/') ? 'video' : 'image', asset_id: a.asset_id, x: 40 + n * 20, y: 40 + n * 20, width: 400, height: 300, z: n, fit: 'contain' });
    setText(JSON.stringify(d, null, 2));
  };

  const save = () =>
    run(async () => {
      const r = await put(`/v1/drafts/${draftId}`, { base_revision: draft.head_revision, document: JSON.parse(text) });
      setMsg(r.unchanged ? 'unchanged: no new revision' : `saved revision ${r.head_revision}`);
      load(r);
      setRevs((await get(`/v1/drafts/${draftId}/revisions`)).revisions);
    });

  return (
    <section>
      <div className="row">
        <button onClick={() => run(async () => { const d = await post('/v1/drafts', { document: EMPTY }); setDraftId(d.draft_id); await refreshList(); })}>New draft</button>
        <button onClick={refreshList}>Refresh list</button>
      </div>
      <table>
        <tbody>
          {list.map((d) => (
            <tr key={d.draft_id} className={d.draft_id === draftId ? 'sel' : ''} onClick={() => setDraftId(d.draft_id)}>
              <td>{d.draft_id}</td>
              <td><StatusBadge s={d.status} /></td>
              <td>head {d.head_revision}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorBanner error={error} />
      {draft && (
        <div className="cols">
          <div>
            <h3>
              {draft.draft_id} <StatusBadge s={draft.status} /> head {draft.head_revision}
            </h3>
            <div className="row">
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">asset…</option>
                {assets.map((a) => (
                  <option key={a.asset_id} value={a.asset_id}>{a.filename} {a.asset_id.slice(0, 8)}</option>
                ))}
              </select>
              <button onClick={addAsset}>Add element</button>
            </div>
            <textarea rows={18} value={text} onChange={(e) => setText(e.target.value)} />
            {parseErr && <div className="error">{parseErr}</div>}
            <div className="row">
              <button disabled={!!parseErr} onClick={save}>Save (base_revision {draft.head_revision})</button>
              <button onClick={() => run(async () => { await del(`/v1/drafts/${draftId}`); await refresh(); await refreshList(); })}>Discard</button>
              <button onClick={() => run(async () => { await post(`/v1/drafts/${draftId}/restore`); await refresh(); await refreshList(); })}>Restore draft</button>
            </div>
            {msg && <p>{msg}</p>}
            {(error as any)?.code === 'REVISION_CONFLICT' && <button onClick={() => refresh()}>Reload head</button>}
          </div>
          <div>
            <Preview doc={doc} />
            <h3>Revisions</h3>
            <table>
              <tbody>
                {revs.map((r) => (
                  <tr key={r.revision_no}>
                    <td>#{r.revision_no}</td>
                    <td>{r.source}</td>
                    <td>{r.pinned ? 'pinned' : ''}</td>
                    <td>{r.restored_from_revision ? `from #${r.restored_from_revision}` : ''}</td>
                    <td>
                      <button onClick={() => run(async () => { load(await post(`/v1/drafts/${draftId}/revisions/${r.revision_no}/restore`)); await refresh(); })}>restore</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {draft && <JsonView v={{ ...draft, revision: { ...draft.revision, document: '(see editor)' } }} />}
    </section>
  );
}

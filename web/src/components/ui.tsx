import { useEffect, useState } from 'react';
import { ApiError, errText, onLog, type LogEntry } from '../api';

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const extra = error instanceof ApiError ? { ...error.body } : {};
  delete (extra as any).code;
  delete (extra as any).message;
  return (
    <div className="error">
      {errText(error)}
      {Object.keys(extra).length > 0 && <code> {JSON.stringify(extra)}</code>}
    </div>
  );
}

export const StatusBadge = ({ s }: { s?: string | null }) => <span className={`badge b-${s ?? 'none'}`}>{s ?? '-'}</span>;

export const JsonView = ({ v }: { v: unknown }) => <pre className="json">{JSON.stringify(v, null, 2)}</pre>;

export function RequestLog() {
  const [rows, setRows] = useState<LogEntry[]>([]);
  useEffect(() => onLog((e) => setRows((r) => [e, ...r].slice(0, 200))), []);
  return (
    <details className="log" open>
      <summary>Request log ({rows.length})</summary>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={typeof r.status === 'number' && r.status < 400 ? 'ok' : 'bad'}>
              <td>{r.at}</td>
              <td>{r.method}</td>
              <td>{r.path}</td>
              <td>{r.status}</td>
              <td>{r.code ?? ''}</td>
              <td>{r.ms}ms</td>
              <td>{r.correlationId?.slice(0, 8) ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

// localStorage-backed state; falls back to memory when storage is unavailable.
export function useStored<T>(key: string, init: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s ? (JSON.parse(s) as T) : init;
    } catch {
      return init;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }, [key, v]);
  return [v, setV] as const;
}

export interface KnownAsset {
  asset_id: string;
  filename: string;
  content_type: string;
}
export const useAssets = (owner: string) => useStored<KnownAsset[]>(`canvas-poc.assets.${owner}`, []);

// One request wrapper for canvas-api (via the /api dev proxy). Every call is recorded for the request log.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface LogEntry {
  id: number;
  at: string;
  method: string;
  path: string;
  status: number | 'ERR';
  ms: number;
  correlationId?: string;
  code?: string;
}

type Listener = (e: LogEntry) => void;
const listeners = new Set<Listener>();
let seq = 0;
export const onLog = (l: Listener) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const emit = (e: Omit<LogEntry, 'id' | 'at'>) => listeners.forEach((l) => l({ ...e, id: ++seq, at: new Date().toLocaleTimeString() }));

const OWNER_KEY = 'canvas-poc.owner';
export const getOwner = () => {
  try {
    return localStorage.getItem(OWNER_KEY) || 'owner-a';
  } catch {
    return 'owner-a';
  }
};
export const setOwner = (o: string) => {
  try {
    localStorage.setItem(OWNER_KEY, o);
  } catch {
    /* storage unavailable */
  }
};

export interface ReqOpts {
  body?: unknown;
  headers?: Record<string, string>;
  base?: string;
  owner?: boolean;
}

export async function request<T = any>(method: string, path: string, opts: ReqOpts = {}): Promise<T & { _status: number }> {
  const base = opts.base ?? '/api';
  const correlationId = crypto.randomUUID();
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.owner !== false && base === '/api') {
    headers['X-Owner-Id'] = getOwner();
    headers['X-Correlation-Id'] = correlationId;
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  } catch (err) {
    emit({ method, path, status: 'ERR', ms: Math.round(performance.now() - t0), correlationId });
    throw new ApiError(0, 'NETWORK', String(err), {});
  }
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text };
  }
  emit({ method, path, status: res.status, ms: Math.round(performance.now() - t0), correlationId, code: res.ok ? undefined : json.code });
  if (!res.ok) throw new ApiError(res.status, json.code ?? `HTTP_${res.status}`, json.message ?? res.statusText, json);
  return { ...json, _status: res.status };
}

// Direct PUT to a presigned S3 URL (localhost:4566). Content-Length is set by the browser, never by us.
export async function putPresigned(url: string, body: Blob, contentType: string): Promise<void> {
  const t0 = performance.now();
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body });
  emit({ method: 'PUT', path: new URL(url).pathname, status: res.status, ms: Math.round(performance.now() - t0) });
  if (!res.ok) throw new ApiError(res.status, 'S3_PUT_FAILED', await res.text(), {});
}

export const get = <T = any>(p: string, o?: ReqOpts) => request<T>('GET', p, o);
export const post = <T = any>(p: string, body?: unknown, o?: ReqOpts) => request<T>('POST', p, { ...o, body: body ?? {} });
export const put = <T = any>(p: string, body: unknown, o?: ReqOpts) => request<T>('PUT', p, { ...o, body });
export const del = <T = any>(p: string, o?: ReqOpts) => request<T>('DELETE', p, o);

export const errText = (e: unknown) => (e instanceof ApiError ? `${e.status} ${e.code}: ${e.message}` : String(e));

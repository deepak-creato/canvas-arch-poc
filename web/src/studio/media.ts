import { useEffect, useRef, useState } from 'react';
import { get } from '../api';

export interface Media {
  asset_id: string;
  kind: 'IMAGE' | 'VIDEO';
  filename: string;
  status: string;
  reject_reason?: string | null;
  display?: string; // preview (images) or poster (videos)
  thumb?: string;
  width?: number;
  height?: number;
}

export const TERMINAL = ['READY', 'FAILED', 'REJECTED', 'EXPIRED'];

export function toMedia(a: any): Media {
  const rs: any[] = a.renditions ?? [];
  const find = (k: string) => rs.find((r) => String(r.kind).toLowerCase() === k && r.status === 'READY' && r.url);
  const main = a.kind === 'VIDEO' ? find('poster') : (find('preview') ?? find('thumbnail'));
  const thumb = find('thumbnail') ?? main;
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);
  return {
    asset_id: a.asset_id,
    kind: a.kind,
    filename: a.filename ?? String(a.asset_id).slice(0, 8),
    status: a.processing_status,
    reject_reason: a.reject_reason,
    display: main?.url,
    thumb: thumb?.url,
    width: num(a.media?.width) ?? num(main?.width),
    height: num(a.media?.height) ?? num(main?.height),
  };
}

export const fetchMedia = async (id: string) => toMedia(await get(`/v1/assets/${id}`));

// Presigned GET URLs live an hour; drop the cache before that so images keep loading in a long session.
const REFRESH_MS = 25 * 60 * 1000;

export function useMedia(ids: string[]) {
  const [media, setMedia] = useState<Record<string, Media>>({});
  const cache = useRef<Record<string, Media>>({});
  const key = [...new Set(ids)].sort().join(',');

  useEffect(() => {
    const list = key ? key.split(',') : [];
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let pending = false;
      await Promise.all(
        list.map(async (id) => {
          const cur = cache.current[id];
          if (cur && TERMINAL.includes(cur.status)) return;
          try {
            const m = await fetchMedia(id);
            cache.current[id] = m;
            if (!TERMINAL.includes(m.status)) pending = true;
          } catch {
            pending = true;
          }
        }),
      );
      if (stop) return;
      setMedia({ ...cache.current });
      if (pending) timer = setTimeout(tick, 1500);
    };
    void tick();
    const iv = setInterval(() => {
      list.forEach((id) => delete cache.current[id]);
      void tick();
    }, REFRESH_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
      clearInterval(iv);
    };
  }, [key]);

  return media;
}

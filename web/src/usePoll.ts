import { useEffect, useRef, useState } from 'react';

// Poll fn every intervalMs while `active`; stop when done(result) is true.
export function usePoll<T>(fn: () => Promise<T>, done: (v: T) => boolean, active: boolean, intervalMs = 1000) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<unknown>();
  const fnRef = useRef(fn);
  const doneRef = useRef(done);
  fnRef.current = fn;
  doneRef.current = done;
  useEffect(() => {
    if (!active) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const v = await fnRef.current();
        if (stop) return;
        setValue(v);
        setError(undefined);
        if (doneRef.current(v)) return;
      } catch (e) {
        if (stop) return;
        setError(e);
      }
      timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [active, intervalMs]);
  return { value, error };
}

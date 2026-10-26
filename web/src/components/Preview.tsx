import { useEffect, useRef } from 'react';
import { drawDoc, type CanvasDoc } from '../renderCanvas';

export function Preview({ doc }: { doc: CanvasDoc }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const { width, height } = doc.canvas ?? { width: 1080, height: 1080 };
    c.width = width;
    c.height = height;
    drawDoc(c.getContext('2d')!, doc, new Map());
  }, [doc]);
  return <canvas ref={ref} className="preview" />;
}

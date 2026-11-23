import { useEffect, useRef, useState } from 'react';

/** Finger or mouse signature. Returns base64 PNG (no data: prefix) or null when empty. */
export function SignaturePad({ onChange }: { onChange: (pngBase64: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111';
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  return (
    <div className="pad">
      <canvas
        ref={ref}
        aria-label="Draw your signature"
        onPointerDown={(e) => {
          const ctx = e.currentTarget.getContext('2d');
          if (!ctx) return;
          drawing.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          const [x, y] = point(e);
          ctx.beginPath();
          ctx.moveTo(x, y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext('2d');
          if (!ctx) return;
          const [x, y] = point(e);
          ctx.lineTo(x, y);
          ctx.stroke();
          if (empty) setEmpty(false);
        }}
        onPointerUp={(e) => {
          drawing.current = false;
          if (!empty) onChange(e.currentTarget.toDataURL('image/png').split(',')[1] ?? null);
        }}
      />
      <button
        type="button"
        className="link"
        onClick={() => {
          const c = ref.current;
          c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
          setEmpty(true);
          onChange(null);
        }}
      >
        Clear
      </button>
    </div>
  );
}

import React, { useRef, useCallback, useEffect } from 'react';

const STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    background:rgba(19,27,45,0.92);color:var(--fg-1);
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:1px solid var(--border-2);border-radius:10px;
    box-shadow:var(--shadow-3);
    font:11.5px/1.4 var(--font-body);overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none;
    border-bottom:1px solid var(--border-1)}
  .twk-hd b{font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:var(--fg-2)}
  .twk-x{appearance:none;border:0;background:transparent;color:var(--fg-3);
    width:22px;height:22px;border-radius:4px;cursor:pointer;font-size:13px;line-height:1;min-height:0}
  .twk-x:hover{background:rgba(255,255,255,0.06);color:var(--fg-1)}
  .twk-body{padding:4px 12px 12px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:rgba(162,170,188,0.2) transparent}
  .twk-sect{font-size:9.5px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;
    color:var(--fg-3);padding:8px 0 0;border-top:1px solid var(--border-1);margin-top:2px}
  .twk-sect:first-child{padding-top:0;border-top:0;margin-top:0}
`;

export function TweaksPanel({
  title = 'Tweaks',
  open,
  onClose,
  children,
}: {
  title?: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef({ x: 16, y: 16 });

  const clamp = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    const PAD = 16;
    const w = el.offsetWidth, h = el.offsetHeight;
    offsetRef.current = {
      x: Math.min(Math.max(PAD, offsetRef.current.x), Math.max(PAD, window.innerWidth - w - PAD)),
      y: Math.min(Math.max(PAD, offsetRef.current.y), Math.max(PAD, window.innerHeight - h - PAD)),
    };
    el.style.right = offsetRef.current.x + 'px';
    el.style.bottom = offsetRef.current.y + 'px';
  }, []);

  useEffect(() => {
    if (!open) return;
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [open, clamp]);

  const onDragStart = (e: React.MouseEvent) => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const move = (ev: MouseEvent) => {
      offsetRef.current = {
        x: startRight - (ev.clientX - sx),
        y: startBottom - (ev.clientY - sy),
      };
      clamp();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (!open) return null;

  return (
    <>
      <style>{STYLE}</style>
      <div
        ref={panelRef}
        className="twk-panel"
        style={{ right: offsetRef.current.x, bottom: offsetRef.current.y }}
      >
        <div className="twk-hd" onMouseDown={onDragStart}>
          <b>{title}</b>
          <button className="twk-x" onMouseDown={e => e.stopPropagation()} onClick={onClose}>✕</button>
        </div>
        <div className="twk-body">{children}</div>
      </div>
    </>
  );
}

export function TweakSection({ label }: { label: string }) {
  return <div className="twk-sect">{label}</div>;
}

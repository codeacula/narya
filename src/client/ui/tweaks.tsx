import React, { useState, useRef, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'streamer-tools.tweaks';

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
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;color:var(--fg-3)}
  .twk-lbl>span:first-child{font-weight:500;color:var(--fg-2)}
  .twk-sect{font-size:9.5px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;
    color:var(--fg-3);padding:8px 0 0;border-top:1px solid var(--border-1);margin-top:2px}
  .twk-sect:first-child{padding-top:0;border-top:0;margin-top:0}
  .twk-seg{position:relative;display:flex;padding:2px;border-radius:6px;
    background:rgba(255,255,255,0.04);user-select:none;border:1px solid var(--border-1)}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:4px;
    background:rgba(255,255,255,0.1);border:1px solid var(--border-2);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  .twk-seg.dragging .twk-seg-thumb{transition:none}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:var(--fg-2);font:inherit;font-weight:500;min-height:18px;
    border-radius:4px;cursor:pointer;padding:4px 6px;line-height:1.2;
    overflow-wrap:anywhere;transition:color .12s}
  .twk-seg button[aria-checked="true"]{color:var(--accent-fg)}
  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:rgba(255,255,255,0.1);border:1px solid var(--border-2);
    transition:background .15s,border-color .15s;cursor:pointer;padding:0;min-height:0}
  .twk-toggle[data-on="1"]{background:var(--accent-soft);border-color:var(--border-3)}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
    background:var(--silver-400);transition:transform .15s,background .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px);background:var(--accent)}
  .twk-chips{display:flex;gap:6px}
  .twk-chip{position:relative;appearance:none;flex:1;min-width:0;height:40px;
    padding:0;border:1px solid var(--border-2);border-radius:6px;overflow:hidden;cursor:pointer;
    transition:border-color .12s,box-shadow .12s}
  .twk-chip:hover{border-color:var(--border-3)}
  .twk-chip[data-on="1"]{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
  .twk-chip svg{position:absolute;top:6px;left:6px;width:12px;height:12px}
`;

export function useTweaks<T extends Record<string, unknown>>(
  defaults: T,
): [T, <K extends keyof T>(key: K, val: T[K]) => void] {
  const [values, setValues] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? { ...defaults, ...JSON.parse(stored) } : defaults;
    } catch {
      return defaults;
    }
  });

  const setTweak = useCallback(<K extends keyof T>(key: K, val: T[K]) => {
    setValues(prev => {
      const next = { ...prev, [key]: val };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return [values, setTweak];
}

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

export function TweakToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="twk-row twk-row-h">
      <div className="twk-lbl"><span>{label}</span></div>
      <button
        type="button"
        className="twk-toggle"
        data-on={value ? '1' : '0'}
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
      >
        <i />
      </button>
    </div>
  );
}

export function TweakRadio({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  const n = options.length;
  const idx = Math.max(0, options.indexOf(value));

  const segAt = (clientX: number): string => {
    const r = trackRef.current!.getBoundingClientRect();
    const inner = r.width - 4;
    const i = Math.floor(((clientX - r.left - 2) / inner) * n);
    return options[Math.max(0, Math.min(n - 1, i))];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    setDragging(true);
    const v0 = segAt(e.clientX);
    if (v0 !== valueRef.current) onChange(v0);
    const move = (ev: PointerEvent) => {
      if (!trackRef.current) return;
      const v = segAt(ev.clientX);
      if (v !== valueRef.current) onChange(v);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="twk-row">
      <div className="twk-lbl"><span>{label}</span></div>
      <div
        ref={trackRef}
        role="radiogroup"
        onPointerDown={onPointerDown}
        className={dragging ? 'twk-seg dragging' : 'twk-seg'}
      >
        <div
          className="twk-seg-thumb"
          style={{
            left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
            width: `calc((100% - 4px) / ${n})`,
          }}
        />
        {options.map(o => (
          <button key={o} type="button" role="radio" aria-checked={o === value}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function isLight(hex: string): boolean {
  const h = hex.replace('#', '');
  const x = h.length === 3 ? h.replace(/./g, c => c + c) : h.padEnd(6, '0');
  const n = parseInt(x.slice(0, 6), 16);
  if (Number.isNaN(n)) return true;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return r * 299 + g * 587 + b * 114 > 148000;
}

const CheckMark = ({ light }: { light: boolean }) => (
  <svg viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M3 7.2 5.8 10 11 4.2"
      fill="none"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      stroke={light ? 'rgba(0,0,0,.78)' : '#fff'}
    />
  </svg>
);

export function TweakColor({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="twk-row">
      <div className="twk-lbl"><span>{label}</span></div>
      <div className="twk-chips" role="radiogroup">
        {options.map(o => {
          const on = o.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={o}
              type="button"
              className="twk-chip"
              role="radio"
              aria-checked={on}
              data-on={on ? '1' : '0'}
              style={{ background: o }}
              onClick={() => onChange(o)}
            >
              {on && <CheckMark light={isLight(o)} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Resizable workspace: pixel-based panel sizes, drag/keyboard/touch splitters, saved layout preferences.
// Layout preferences are stored separately from the network/simulation autosave.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export type PanelId = 'canvas' | 'sim' | 'timeline' | 'details';

export interface LayoutPrefs {
  /** Width of the right sidebar in px (the topology column takes the rest). */
  sidebar: number;
  /** Height of the topology canvas panel in px. */
  canvasH: number;
  /** Height of the event timeline panel in px. */
  timelineH: number;
  timelineCollapsed: boolean;
  detailsCollapsed: boolean;
}

export const DEFAULT_LAYOUT: LayoutPrefs = { sidebar: 440, canvasH: 480, timelineH: 260, timelineCollapsed: false, detailsCollapsed: false };

export const MIN = { sidebar: 300, left: 420, canvasH: 220, simH: 120, timelineH: 110, detailsH: 140 };

const LAYOUT_KEY = 'routing-visual-lab:layout';

function loadLayout(): LayoutPrefs {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const v = JSON.parse(raw) as Partial<LayoutPrefs>;
    const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : d);
    return {
      sidebar: num(v.sidebar, DEFAULT_LAYOUT.sidebar),
      canvasH: num(v.canvasH, DEFAULT_LAYOUT.canvasH),
      timelineH: num(v.timelineH, DEFAULT_LAYOUT.timelineH),
      timelineCollapsed: v.timelineCollapsed === true,
      detailsCollapsed: v.detailsCollapsed === true,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function useLayoutPrefs() {
  const [layout, setLayoutState] = useState<LayoutPrefs>(loadLayout);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
      } catch {
        /* storage unavailable: layout still works for this visit */
      }
    }, 150);
    return () => clearTimeout(t);
  }, [layout]);
  const patch = useCallback((p: Partial<LayoutPrefs>) => setLayoutState((l) => ({ ...l, ...p })), []);
  const reset = useCallback(() => setLayoutState(DEFAULT_LAYOUT), []);
  return { layout, patch, reset };
}

export function useElementSize<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size] as const;
}

export function useMediaQuery(q: string) {
  const get = () => typeof matchMedia !== 'undefined' && matchMedia(q).matches;
  const [m, setM] = useState(get);
  useEffect(() => {
    const mq = matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(Math.max(lo, hi), v));

interface SplitterProps {
  /** 'vertical' = a vertical bar that moves left/right; 'horizontal' = a bar that moves up/down. */
  orientation: 'vertical' | 'horizontal';
  value: number;
  min: number;
  max: number;
  /** True when moving the bar towards +x/+y makes the value smaller (e.g. the right sidebar width). */
  invert?: boolean;
  label: string;
  /** Live preview while dragging (cheap, no React re-render). */
  onLive: (v: number) => void;
  /** Final value when the drag or key press ends. */
  onCommit: (v: number) => void;
  onReset: () => void;
}

/** Draggable divider. Mouse, touch and pen use pointer events; arrow keys resize; double-click resets. */
export function Splitter(p: SplitterProps) {
  const drag = useRef<{ start: number; startValue: number; last: number } | null>(null);
  const raf = useRef(0);
  const [active, setActive] = useState(false);
  const vertical = p.orientation === 'vertical';
  const sign = p.invert ? -1 : 1;

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: vertical ? e.clientX : e.clientY, startValue: p.value, last: p.value };
    setActive(true);
    document.body.classList.add(vertical ? 'resizing-x' : 'resizing-y');
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const pos = vertical ? e.clientX : e.clientY;
    d.last = clamp(d.startValue + (pos - d.start) * sign, p.min, p.max);
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => p.onLive(d.last));
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(raf.current);
    setActive(false);
    document.body.classList.remove('resizing-x', 'resizing-y');
    p.onCommit(d.last);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 80 : 24;
    const dec = vertical ? 'ArrowLeft' : 'ArrowUp';
    const inc = vertical ? 'ArrowRight' : 'ArrowDown';
    let v: number | null = null;
    if (e.key === dec) v = p.value - step * sign;
    else if (e.key === inc) v = p.value + step * sign;
    else if (e.key === 'Home') v = p.min;
    else if (e.key === 'End') v = p.max;
    else if (e.key === 'Enter') return p.onReset();
    if (v === null) return;
    e.preventDefault();
    e.stopPropagation();
    p.onCommit(clamp(v, p.min, p.max));
  };

  return (
    <div
      className={`splitter ${vertical ? 'splitter-v' : 'splitter-h'} ${active ? 'active' : ''}`}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={`${p.label}. Drag, or use the arrow keys, to resize. Double-click or Enter to reset.`}
      aria-valuenow={Math.round(p.value)}
      aria-valuemin={Math.round(p.min)}
      aria-valuemax={Math.round(p.max)}
      tabIndex={0}
      title={`${p.label} — drag to resize, double-click to reset`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={p.onReset}
      onKeyDown={onKey}
    >
      <span className="grip" aria-hidden />
    </div>
  );
}

const Icon = ({ d }: { d: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const ICON = {
  maximize: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4',
  restore: 'M6 2v4H2M10 2v4h4M14 10h-4v4M2 10h4v4',
  collapse: 'M4 6l4 4 4-4',
  expand: 'M6 4l4 4-4 4',
};

/** Small header-bar buttons shared by every main panel. */
export function PanelButtons({ id, maxed, onMax, collapsed, onCollapse, extra }: {
  id: PanelId;
  maxed: PanelId | null;
  onMax: (id: PanelId | null) => void;
  collapsed?: boolean;
  onCollapse?: () => void;
  extra?: ReactNode;
}) {
  const isMax = maxed === id;
  return (
    <span className="panel-btns">
      {extra}
      {onCollapse && !isMax && (
        <button className="btn small icon" onClick={onCollapse} aria-expanded={!collapsed} title={collapsed ? 'Expand panel' : 'Collapse panel'} aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}>
          <Icon d={collapsed ? ICON.expand : ICON.collapse} />
        </button>
      )}
      <button className="btn small icon" onClick={() => onMax(isMax ? null : id)} title={isMax ? 'Restore layout' : 'Maximize panel'} aria-label={isMax ? 'Restore layout' : 'Maximize panel'} aria-pressed={isMax}>
        <Icon d={isMax ? ICON.restore : ICON.maximize} />
      </button>
    </span>
  );
}

export function PanelBar({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="panel-bar">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

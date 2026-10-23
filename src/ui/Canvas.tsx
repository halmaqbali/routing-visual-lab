import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Device, Link, Mode, SimOptions, Topology } from '../model/types';
import { isLoopback } from '../model/topology';
import type { Anim } from '../engine/types';
import type { Note } from '../lab/lab';

export type Sel = { kind: 'device' | 'link' | 'note'; id: string } | null;
export type Tool = 'select' | 'router' | 'pc' | 'switch' | 'link' | 'note' | 'delete';
export interface DirLink { linkId: string; from: string; to: string }
export interface View { k: number; x: number; y: number }

export const VIEW_W = 840;
export const VIEW_H = 470;
export const GRID = 20;
export const DEFAULT_VIEW: View = { k: 1, x: 0, y: 0 };

interface Props {
  topo: Topology;
  pos: Record<string, { x: number; y: number }>;
  notes: Note[];
  mode: Mode | 'compare';
  options: SimOptions;
  selected: Sel;
  tool: Tool;
  pendingLinkFrom: string | null;
  anim: Anim | undefined;
  animKey: number;
  duration: number;
  reducedMotion: boolean;
  routePath: DirLink[];
  sptPath: DirLink[];
  focus: string[];
  showAddresses: boolean;
  showGrid: boolean;
  view: View;
  onView: (v: View) => void;
  onSelect: (s: Sel) => void;
  onBackground: (x: number, y: number) => void;
  onDevice: (id: string) => void;
  onMove: (id: string, x: number, y: number, done: boolean) => void;
  onNoteChange: (n: Note, done: boolean) => void;
  onNoteOpen: (id: string) => void;
  onPacketClick: () => void;
}

/** Simple, safe note formatting: **bold**, "- " bullets, line breaks. */
export function formatNote(text: string): ReactNode {
  const inline = (s: string, key: number) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong> : <span key={`${key}-${i}`}>{part}</span>));
  const out: ReactNode[] = [];
  let bullets: ReactNode[] = [];
  const flush = () => {
    if (bullets.length) out.push(<ul key={`ul-${out.length}`}>{bullets}</ul>);
    bullets = [];
  };
  text.split('\n').forEach((line, i) => {
    if (/^\s*[-•]\s+/.test(line)) bullets.push(<li key={i}>{inline(line.replace(/^\s*[-•]\s+/, ''), i)}</li>);
    else {
      flush();
      out.push(line.trim() ? <p key={i}>{inline(line, i)}</p> : <br key={i} />);
    }
  });
  flush();
  return out;
}

function devShape(d: Device, sel: boolean): ReactNode {
  const stroke = sel ? 'var(--sel)' : 'var(--fg)';
  const w = sel ? 4 : 2.2;
  if (d.kind === 'router')
    return (
      <g>
        <circle className="dev-shape" r={26} fill="var(--node)" stroke={stroke} strokeWidth={w} />
        <g stroke="var(--fg)" strokeWidth={2.2} strokeLinecap="round" fill="none">
          <path d="M-13 -5 H-3 M-13 -5 l4 -4 M-13 -5 l4 4" />
          <path d="M13 5 H3 M13 5 l-4 -4 M13 5 l-4 4" />
          <path d="M-5 13 V3 M-5 13 l-4 -4 M-5 13 l4 -4" />
          <path d="M5 -13 V-3 M5 -13 l-4 4 M5 -13 l4 4" />
        </g>
      </g>
    );
  if (d.kind === 'switch')
    return (
      <g>
        <rect className="dev-shape" x={-30} y={-17} width={60} height={34} rx={5} fill="var(--node)" stroke={stroke} strokeWidth={w} />
        <g stroke="var(--fg)" strokeWidth={2.2} strokeLinecap="round" fill="none">
          <path d="M-16 -5 H14 M14 -5 l-4 -4 M14 -5 l-4 4" />
          <path d="M16 6 H-14 M-14 6 l4 -4 M-14 6 l4 4" />
        </g>
      </g>
    );
  return (
    <g>
      <rect className="dev-shape" x={-22} y={-18} width={44} height={30} rx={3} fill="var(--node)" stroke={stroke} strokeWidth={w} />
      <rect x={-15} y={-12} width={30} height={18} fill="var(--node-inner)" />
      <path d="M-8 18 H8 M0 12 V18" stroke="var(--fg)" strokeWidth={2.5} />
    </g>
  );
}

function tokenShape(style: Anim['style'], label: string | undefined, ttl: number | undefined): ReactNode {
  if (style === 'data') {
    const isArp = label === 'ARP';
    const text = `${label ?? ''}${ttl !== undefined ? ` · TTL ${ttl}` : ''}`;
    const w = text.length * 7.6 + 14;
    return (
      <g>
        <rect x={-19} y={-12} width={38} height={24} rx={3} fill={isArp ? 'var(--node)' : 'var(--fg)'} stroke={isArp ? 'var(--fg)' : 'var(--bg)'} strokeWidth={2} strokeDasharray={isArp ? '4 3' : undefined} />
        <path d="M-19 -12 L0 2 L19 -12" fill="none" stroke={isArp ? 'var(--fg)' : 'var(--bg)'} strokeWidth={1.6} />
        <g transform="translate(0,-31)">
          <rect x={-w / 2} y={-11} width={w} height={22} rx={11} fill="var(--node)" stroke="var(--fg)" strokeWidth={1.6} />
          <text y={5} textAnchor="middle" fontSize={13} fontWeight={800} style={{ fill: 'var(--fg)' }}>{text}</text>
        </g>
      </g>
    );
  }
  if (style === 'dv')
    return (
      <g>
        <rect x={-15} y={-15} width={30} height={30} rx={4} fill="var(--node)" stroke="var(--fg)" strokeWidth={2.5} />
        <text y={4} textAnchor="middle" fontSize={11} fontWeight={800} style={{ fill: 'var(--fg)' }}>{label ?? 'DV'}</text>
      </g>
    );
  if (style === 'lsa')
    return (
      <g>
        <rect x={-13} y={-13} width={26} height={26} transform="rotate(45)" fill="var(--mid)" stroke="var(--fg)" strokeWidth={2} />
        <text y={4} textAnchor="middle" fontSize={9} fontWeight={800} style={{ fill: 'var(--bg)' }}>LSA</text>
        <text y={-24} textAnchor="middle" fontSize={11} fontWeight={700} stroke="var(--bg)" strokeWidth={3} paintOrder="stroke" style={{ fill: 'var(--fg)' }}>{label}</text>
      </g>
    );
  return (
    <g>
      <circle r={11} fill="var(--node)" stroke="var(--fg)" strokeWidth={2.5} />
      <text y={4} textAnchor="middle" fontSize={10} fontWeight={800} style={{ fill: 'var(--fg)' }}>H</text>
    </g>
  );
}

export function fitView(topo: Topology, pos: Props['pos'], notes: Note[]): View {
  const pts: [number, number, number, number][] = topo.devices.map((d) => {
    const x = pos[d.id]?.x ?? d.x;
    const y = pos[d.id]?.y ?? d.y;
    return [x - 50, y - 45, x + 50, y + 70];
  });
  for (const n of notes) pts.push([n.x, n.y, n.x + n.w, n.y + n.h]);
  if (!pts.length) return DEFAULT_VIEW;
  const minX = Math.min(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const maxX = Math.max(...pts.map((p) => p[2]));
  const maxY = Math.max(...pts.map((p) => p[3]));
  const k = Math.max(0.3, Math.min(2.5, (VIEW_W - 40) / (maxX - minX || 1), (VIEW_H - 40) / (maxY - minY || 1)));
  return { k, x: VIEW_W / 2 - k * (minX + maxX) / 2, y: VIEW_H / 2 - k * (minY + maxY) / 2 };
}

export function Canvas(p: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const drag = useRef<
    | { kind: 'dev'; id: string; dx: number; dy: number; moved: boolean; sx: number; sy: number }
    | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean; wx: number; wy: number }
    | { kind: 'note'; id: string; dx: number; dy: number; moved: boolean; sx: number; sy: number }
    | { kind: 'resize'; id: string; sx: number; sy: number; w: number; h: number }
    | null
  >(null);
  const [progress, setProgress] = useState(1);
  const viewRef = useRef(p.view);
  viewRef.current = p.view;

  useEffect(() => {
    if (!p.anim || p.reducedMotion || p.anim.from === p.anim.to) {
      setProgress(1);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / p.duration);
      setProgress(k);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    setProgress(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [p.animKey, p.anim, p.duration, p.reducedMotion]);

  // Ctrl/⌘ + wheel (or trackpad pinch) zooms around the pointer.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const s = pt.matrixTransform(svg.getScreenCTM()!.inverse());
      const v = viewRef.current;
      const k = Math.max(0.3, Math.min(3, v.k * Math.exp(-e.deltaY * 0.0025)));
      p.onView({ k, x: s.x - ((s.x - v.x) * k) / v.k, y: s.y - ((s.y - v.y) * k) / v.k });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [p.onView]); // eslint-disable-line react-hooks/exhaustive-deps

  const xy = (id: string) => {
    const d = p.topo.devices.find((x) => x.id === id);
    const o = p.pos[id];
    return { x: o?.x ?? d?.x ?? 0, y: o?.y ?? d?.y ?? 0 };
  };

  const point = (e: { clientX: number; clientY: number }, el: SVGGraphicsElement | null) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform((el ?? svg).getScreenCTM()!.inverse());
  };
  const toWorld = (e: { clientX: number; clientY: number }) => point(e, worldRef.current);
  // Keep receiving moves while dragging; ignore failures (e.g. the pointer was already released).
  const capture = (id: number) => {
    try {
      svgRef.current?.setPointerCapture?.(id);
    } catch {
      /* drag still works while the pointer stays over the canvas */
    }
  };
  const toScreen = (e: { clientX: number; clientY: number }) => point(e, null);

  const onDevDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const pt = toWorld(e);
    const c = xy(id);
    drag.current = { kind: 'dev', id, dx: pt.x - c.x, dy: pt.y - c.y, moved: false, sx: pt.x, sy: pt.y };
    capture(e.pointerId);
  };
  const onNoteDown = (e: React.PointerEvent, n: Note) => {
    e.stopPropagation();
    p.onSelect({ kind: 'note', id: n.id });
    if (n.locked || p.tool !== 'select') return;
    const pt = toWorld(e);
    drag.current = { kind: 'note', id: n.id, dx: pt.x - n.x, dy: pt.y - n.y, moved: false, sx: pt.x, sy: pt.y };
    capture(e.pointerId);
  };
  const onResizeDown = (e: React.PointerEvent, n: Note) => {
    e.stopPropagation();
    if (n.locked) return;
    const pt = toWorld(e);
    drag.current = { kind: 'resize', id: n.id, sx: pt.x, sy: pt.y, w: n.w, h: n.h };
    capture(e.pointerId);
  };
  const onBgDown = (e: React.PointerEvent) => {
    const s = toScreen(e);
    const w = toWorld(e);
    drag.current = { kind: 'pan', sx: s.x, sy: s.y, vx: p.view.x, vy: p.view.y, moved: false, wx: w.x, wy: w.y };
    capture(e.pointerId);
  };
  const onMoveEv = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') {
      const s = toScreen(e);
      if (!d.moved && Math.hypot(s.x - d.sx, s.y - d.sy) < 5) return;
      if (p.tool !== 'select') return;
      d.moved = true;
      p.onView({ ...p.view, x: d.vx + s.x - d.sx, y: d.vy + s.y - d.sy });
      return;
    }
    const pt = toWorld(e);
    if (d.kind === 'resize') {
      const n = p.notes.find((x) => x.id === d.id);
      if (n) p.onNoteChange({ ...n, w: Math.max(120, d.w + pt.x - d.sx), h: Math.max(60, d.h + pt.y - d.sy) }, false);
      return;
    }
    if (!d.moved && Math.hypot(pt.x - d.sx, pt.y - d.sy) < 4) return;
    if (p.tool !== 'select') return;
    d.moved = true;
    if (d.kind === 'dev') p.onMove(d.id, pt.x - d.dx, pt.y - d.dy, false);
    else {
      const n = p.notes.find((x) => x.id === d.id);
      if (n) p.onNoteChange({ ...n, x: pt.x - d.dx, y: pt.y - d.dy }, false);
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'dev') {
      if (!d.moved) p.onDevice(d.id);
      else {
        const pt = toWorld(e);
        p.onMove(d.id, pt.x - d.dx, pt.y - d.dy, true);
      }
    } else if (d.kind === 'pan') {
      if (!d.moved) p.onBackground(d.wx, d.wy);
    } else if (d.kind === 'note' && d.moved) {
      const n = p.notes.find((x) => x.id === d.id);
      if (n) p.onNoteChange(n, true);
    } else if (d.kind === 'resize') {
      const n = p.notes.find((x) => x.id === d.id);
      if (n) p.onNoteChange(n, true);
    }
  };

  const costLabel = (l: Link) => {
    if (p.mode === 'static') return null;
    const kinds = [l.a.dev, l.b.dev].map((id) => p.topo.devices.find((d) => d.id === id)?.kind);
    if (kinds.includes('pc')) return null;
    if (p.mode === 'dv' && p.options.dv.profile === 'rip') return kinds.includes('switch') ? null : '1 hop';
    return `cost ${l.cost}`;
  };

  // Position along a path of devices (through switches), 0..1
  const along = (ids: string[], t: number) => {
    const pts = ids.map(xy);
    const segs = pts.slice(1).map((q, i) => Math.hypot(q.x - pts[i].x, q.y - pts[i].y));
    const total = segs.reduce((a, b) => a + b, 0) || 1;
    let dist = t * total;
    for (let i = 0; i < segs.length; i++) {
      if (dist <= segs[i] || i === segs.length - 1) {
        const f = segs[i] ? Math.min(1, dist / segs[i]) : 1;
        return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f };
      }
      dist -= segs[i];
    }
    return pts[pts.length - 1];
  };

  const anim = p.anim;
  let tokens: ReactNode = null;
  if (anim) {
    const end = anim.drop && anim.from !== anim.to ? 0.5 : 1;
    const k = Math.min(progress, 1) * end;
    const routes = [anim.path && anim.path.length > 1 ? anim.path : [anim.from, anim.to], ...(anim.copies ?? []).map((c) => [c.from, c.to])];
    const dropped = anim.drop && progress >= 1;
    tokens = routes.map((r, i) => {
      const pos = anim.from === anim.to ? { ...xy(anim.from), y: xy(anim.from).y - 34 } : along(r, k);
      return (
        <g key={i} transform={`translate(${pos.x},${pos.y})`} className="packet-token" role="button" tabIndex={-1}
          aria-label="Inspect this packet" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); p.onPacketClick(); }}>
          <title>Click to inspect this packet</title>
          {anim.from !== anim.to && tokenShape(anim.style, anim.label, i === 0 ? anim.ttl : undefined)}
          {dropped && i === 0 && (
            <g>
              <polygon points="-10,-24 10,-24 24,-10 24,10 10,24 -10,24 -24,10 -24,-10" fill="var(--fail)" stroke="var(--bg)" strokeWidth={2} />
              <path d="M-9 -9 L9 9 M9 -9 L-9 9" stroke="#fff" strokeWidth={4} strokeLinecap="round" />
              <text y={-32} textAnchor="middle" fontSize={13} fontWeight={800} stroke="var(--bg)" strokeWidth={4} paintOrder="stroke" style={{ fill: 'var(--fail)' }}>
                DROP{anim.style === 'data' && anim.ttl !== undefined ? ` · TTL ${anim.ttl}` : ''}
              </text>
            </g>
          )}
        </g>
      );
    });
  }

  const arrowLine = (dl: DirLink, kind: 'route' | 'spt') => {
    const a = xy(dl.from);
    const b = xy(dl.to);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const pad = 32;
    return (
      <line key={`${kind}-${dl.linkId}-${dl.from}`} x1={a.x + ux * pad} y1={a.y + uy * pad} x2={b.x - ux * (pad + 4)} y2={b.y - uy * (pad + 4)}
        stroke="var(--fg)" strokeWidth={kind === 'route' ? 8 : 6} strokeOpacity={kind === 'route' ? 0.35 : 0.22}
        strokeDasharray={kind === 'spt' ? '2 7' : undefined} strokeLinecap="round" markerEnd={`url(#arrow-${kind})`} />
    );
  };

  const v = p.view;
  return (
    <svg
      ref={svgRef}
      className={`net tool-${p.tool}`}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      role="application"
      aria-label="Network topology. Use Tab to focus devices and Enter to select. Drag empty space to pan; Ctrl + scroll to zoom."
      onPointerMove={onMoveEv}
      onPointerUp={onUp}
      onPointerDown={(e) => {
        const t = e.target as Element;
        if (t === svgRef.current || t.getAttribute('data-bg')) onBgDown(e);
      }}
    >
      <defs>
        <marker id="arrow-route" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--fg)" fillOpacity="0.7" />
        </marker>
        <marker id="arrow-spt" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.6" markerHeight="3.6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--fg)" fillOpacity="0.5" />
        </marker>
        <marker id="arrow-note" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--muted)" />
        </marker>
        <pattern id="grid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
          <circle cx={1} cy={1} r={1.1} fill="var(--grid-dot)" />
        </pattern>
      </defs>
      <rect data-bg="1" x={0} y={0} width={VIEW_W} height={VIEW_H} fill="transparent" />
      <g ref={worldRef} transform={`translate(${v.x},${v.y}) scale(${v.k})`}>
        {p.showGrid && <rect data-bg="1" x={-4000} y={-4000} width={8000} height={8000} fill="url(#grid)" />}

        {p.notes.map((n) => {
          if (!n.arrowTo || !p.topo.devices.some((d) => d.id === n.arrowTo)) return null;
          const t = xy(n.arrowTo);
          const cx = Math.max(n.x, Math.min(n.x + n.w, t.x));
          const cy = Math.max(n.y, Math.min(n.y + n.h, t.y));
          const len = Math.hypot(t.x - cx, t.y - cy) || 1;
          return <line key={`na-${n.id}`} x1={cx} y1={cy} x2={t.x - ((t.x - cx) / len) * 36} y2={t.y - ((t.y - cy) / len) * 36} stroke="var(--muted)" strokeWidth={2} strokeDasharray="6 4" markerEnd="url(#arrow-note)" />;
        })}

        {p.sptPath.map((d) => arrowLine(d, 'spt'))}
        {p.routePath.map((d) => arrowLine(d, 'route'))}

        {p.topo.links.map((l) => {
          const a = xy(l.a.dev);
          const b = xy(l.b.dev);
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const sel = p.selected?.kind === 'link' && p.selected.id === l.id;
          const cl = costLabel(l);
          const ia = p.topo.devices.find((d) => d.id === l.a.dev)?.ifaces.find((i) => i.id === l.a.iface);
          const ib = p.topo.devices.find((d) => d.id === l.b.dev)?.ifaces.find((i) => i.id === l.b.iface);
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const nx = -(b.y - a.y) / len;
          const ny = (b.x - a.x) / len;
          const addr = (ifc: typeof ia, from: { x: number; y: number }, to: { x: number; y: number }, side: number) =>
            ifc && (
              <text x={from.x + (to.x - from.x) * 0.3 + nx * side} y={from.y + (to.y - from.y) * 0.3 + ny * side + 4} textAnchor="middle" fontSize={10.5} className="addr">
                {ifc.name}{ifc.ip ? ` ${ifc.ip}/${ifc.prefix}` : ''}
              </text>
            );
          return (
            <g key={l.id} className={`link ${sel ? 'selected' : ''}`}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={l.up ? 'var(--link)' : 'var(--fail)'} strokeWidth={sel ? 5 : 2.6} strokeDasharray={l.up ? undefined : '9 7'} />
              <line className="linkhit" x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={18}
                onPointerDown={(e) => { e.stopPropagation(); p.onSelect({ kind: 'link', id: l.id }); }}>
                <title>{`Ethernet link ${l.up ? 'enabled' : 'DISABLED'}${cl ? `, ${cl}` : ''}. Click to inspect.`}</title>
              </line>
              {p.showAddresses && addr(ia, a, b, -16)}
              {p.showAddresses && addr(ib, b, a, -16)}
              {!l.up && (
                <g transform={`translate(${mx},${my})`} pointerEvents="none">
                  <circle r={13} fill="var(--node)" stroke="var(--fail)" strokeWidth={2.5} />
                  <path d="M-6 -6 L6 6 M6 -6 L-6 6" stroke="var(--fail)" strokeWidth={3} strokeLinecap="round" />
                  <text y={28} textAnchor="middle" fontSize={11} fontWeight={800} style={{ fill: 'var(--fail)' }}>DOWN</text>
                </g>
              )}
              {l.up && cl && (
                <g transform={`translate(${mx},${my})`} pointerEvents="none">
                  <rect x={-26} y={-10} width={52} height={20} rx={10} fill="var(--node)" stroke={sel ? 'var(--sel)' : 'var(--border)'} />
                  <text y={4} textAnchor="middle" fontSize={11} fontWeight={600}>{cl}</text>
                </g>
              )}
            </g>
          );
        })}

        {p.notes.map((n) => {
          const sel = p.selected?.kind === 'note' && p.selected.id === n.id;
          return (
            <g key={n.id} className={`note-g ${sel ? 'selected' : ''}`}>
              <foreignObject x={n.x} y={n.y} width={n.w} height={n.h}>
                <div className={`canvas-note shade-${n.shade} ${sel ? 'selected' : ''} ${n.locked ? 'locked' : ''}`}
                  onPointerDown={(e) => onNoteDown(e, n)} onDoubleClick={(e) => { e.stopPropagation(); p.onNoteOpen(n.id); }}>
                  {(n.title || n.locked) && <div className="note-title">{n.title}{n.locked && <span className="note-lock" title="Locked">🔒</span>}</div>}
                  <div className="note-body">{formatNote(n.text)}</div>
                </div>
              </foreignObject>
              {sel && !n.locked && (
                <rect x={n.x + n.w - 12} y={n.y + n.h - 12} width={14} height={14} rx={3} className="note-resize" fill="var(--fg)"
                  onPointerDown={(e) => onResizeDown(e, n)}>
                  <title>Drag to resize</title>
                </rect>
              )}
            </g>
          );
        })}

        {p.topo.devices.map((d) => {
          const { x, y } = xy(d.id);
          const sel = p.selected?.kind === 'device' && p.selected.id === d.id;
          const focus = p.focus.includes(d.id);
          const pending = p.pendingLinkFrom === d.id;
          const loops = d.ifaces.filter((i) => isLoopback(i) && i.ip);
          const label = d.kind === 'switch' ? 'Switch' : d.kind === 'router' ? 'Router' : 'PC';
          return (
            <g key={d.id} className={`dev ${sel ? 'selected' : ''}`} transform={`translate(${x},${y})`} tabIndex={0} role="button"
              aria-label={`${label} ${d.name}${sel ? ', selected' : ''}`}
              onPointerDown={(e) => onDevDown(e, d.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onDevice(d.id); } }}>
              {(focus || pending) && <circle r={38} fill="none" stroke="var(--fg)" strokeWidth={2.5} strokeDasharray="6 5" className={p.reducedMotion ? '' : 'pulse'} />}
              {sel && <circle r={36} fill="var(--sel-halo)" stroke="none" />}
              {devShape(d, sel)}
              <text y={d.kind === 'router' ? 44 : d.kind === 'switch' ? 34 : 38} textAnchor="middle" fontSize={15} fontWeight={700} stroke="var(--bg)" strokeWidth={4} paintOrder="stroke">{d.name}</text>
              {p.showAddresses && loops.map((lo, i) => (
                <text key={lo.id} y={60 + i * 13} textAnchor="middle" fontSize={10.5} className="addr">{lo.name.replace('LoopBack', 'Lo')} {lo.ip}/{lo.prefix}</text>
              ))}
            </g>
          );
        })}
        {tokens}
      </g>
    </svg>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { Link, Mode, SimOptions, Topology } from '../model/types';
import type { Anim } from '../engine/types';

export type Sel = { kind: 'device' | 'link'; id: string } | null;
export type Tool = 'select' | 'router' | 'pc' | 'link' | 'delete';
export interface DirLink { linkId: string; from: string; to: string }

export const VIEW_W = 840;
export const VIEW_H = 470;

interface Props {
  topo: Topology;
  pos: Record<string, { x: number; y: number }>;
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
  onSelect: (s: Sel) => void;
  onBackground: (x: number, y: number) => void;
  onDevice: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function Canvas(p: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean; sx: number; sy: number } | null>(null);
  const [progress, setProgress] = useState(1);

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

  const xy = (id: string) => {
    const d = p.topo.devices.find((x) => x.id === id);
    const o = p.pos[id];
    return { x: o?.x ?? d?.x ?? 0, y: o?.y ?? d?.y ?? 0 };
  };

  const toSvg = (e: React.PointerEvent) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const r = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: r.x, y: r.y };
  };

  const onDevDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const pt = toSvg(e);
    const c = xy(id);
    drag.current = { id, dx: pt.x - c.x, dy: pt.y - c.y, moved: false, sx: pt.x, sy: pt.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMoveEv = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || p.tool !== 'select') return;
    const pt = toSvg(e);
    if (!d.moved && Math.hypot(pt.x - d.sx, pt.y - d.sy) < 4) return;
    d.moved = true;
    p.onMove(d.id, clamp(pt.x - d.dx, 30, VIEW_W - 30), clamp(pt.y - d.dy, 30, VIEW_H - 40));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) p.onDevice(d.id);
  };

  const costLabel = (l: Link) => {
    if (p.mode === 'static') return null;
    const kinds = [l.a.dev, l.b.dev].map((id) => p.topo.devices.find((d) => d.id === id)?.kind);
    if (kinds.includes('pc')) return null; // host links are connected networks, not router-to-router paths
    if (p.mode === 'dv' && p.options.dv.profile === 'rip') return '1 hop';
    return `cost ${l.cost}`;
  };

  const anim = p.anim;
  let token: JSX.Element | null = null;
  if (anim) {
    const a = xy(anim.from);
    const b = xy(anim.to);
    const end = anim.drop && anim.from !== anim.to ? 0.5 : 1;
    const k = Math.min(progress, 1) * end;
    const x = a.x + (b.x - a.x) * k;
    const y = a.y + (b.y - a.y) * k - (anim.from === anim.to ? 34 : 0);
    const color = anim.style === 'data' ? 'var(--data)' : anim.style === 'dv' ? 'var(--dv)' : anim.style === 'lsa' ? 'var(--lsa)' : 'var(--hello)';
    let shape: JSX.Element;
    if (anim.style === 'data')
      shape = (
        <g>
          <rect x={-19} y={-12} width={38} height={24} rx={3} fill={color} stroke="#fff" strokeWidth={1.5} />
          <path d="M-19 -12 L0 2 L19 -12" fill="none" stroke="#fff" strokeWidth={1.5} />
          {(() => {
            const text = `${anim.label}${anim.ttl !== undefined ? ` · TTL ${anim.ttl}` : ''}`;
            const w = text.length * 7.6 + 14;
            return (
              <g transform="translate(0,-31)">
                <rect x={-w / 2} y={-11} width={w} height={22} rx={11} fill="var(--panel)" stroke={color} strokeWidth={2} />
                <text y={5} textAnchor="middle" fontSize={13} fontWeight={800} style={{ fill: color }}>{text}</text>
              </g>
            );
          })()}
        </g>
      );
    else if (anim.style === 'dv')
      shape = (
        <g>
          <rect x={-15} y={-15} width={30} height={30} rx={6} fill={color} stroke="#fff" strokeWidth={1.5} />
          <text y={4} textAnchor="middle" fontSize={11} fontWeight={800} style={{ fill: '#fff' }}>{anim.label ?? 'DV'}</text>
        </g>
      );
    else if (anim.style === 'lsa')
      shape = (
        <g>
          <rect x={-13} y={-13} width={26} height={26} transform="rotate(45)" fill={color} stroke="#fff" strokeWidth={1.5} />
          <text y={4} textAnchor="middle" fontSize={9} fontWeight={800} style={{ fill: '#fff' }}>LSA</text>
          <text y={-24} textAnchor="middle" fontSize={11} fontWeight={700} style={{ fill: color }}>{anim.label}</text>
        </g>
      );
    else
      shape = (
        <g>
          <circle r={11} fill={color} stroke="#fff" strokeWidth={1.5} />
          <text y={4} textAnchor="middle" fontSize={10} fontWeight={800} style={{ fill: '#fff' }}>H</text>
        </g>
      );
    const dropped = anim.drop && progress >= 1;
    token = (
      <g transform={`translate(${x},${y})`} aria-hidden>
        {anim.from !== anim.to && shape}
        {dropped && (
          <g>
            <polygon points="-10,-24 10,-24 24,-10 24,10 10,24 -10,24 -24,10 -24,-10" fill="var(--fail)" stroke="#fff" strokeWidth={2} />
            <path d="M-9 -9 L9 9 M9 -9 L-9 9" stroke="#fff" strokeWidth={4} strokeLinecap="round" />
            <text y={-32} textAnchor="middle" fontSize={13} fontWeight={800} stroke="var(--panel)" strokeWidth={4} paintOrder="stroke" style={{ fill: 'var(--fail)' }}>
              DROP{anim.style === 'data' && anim.ttl !== undefined ? ` · TTL ${anim.ttl}` : ''}
            </text>
          </g>
        )}
      </g>
    );
  }

  const arrowLine = (dl: DirLink, kind: 'route' | 'spt') => {
    const a = xy(dl.from);
    const b = xy(dl.to);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const pad = 32;
    return (
      <line
        key={`${kind}-${dl.linkId}-${dl.from}`}
        x1={a.x + ux * pad} y1={a.y + uy * pad} x2={b.x - ux * (pad + 4)} y2={b.y - uy * (pad + 4)}
        stroke="var(--route)" strokeWidth={kind === 'route' ? 9 : 7} strokeOpacity={kind === 'route' ? 0.55 : 0.35}
        strokeDasharray={kind === 'spt' ? '2 7' : undefined} strokeLinecap="round"
        markerEnd={`url(#arrow-${kind})`}
      />
    );
  };

  return (
    <svg
      ref={svgRef}
      className="net"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      role="application"
      aria-label="Network topology. Use Tab to focus devices and Enter to select."
      onPointerMove={onMoveEv}
      onPointerUp={onUp}
      onPointerDown={(e) => {
        if (e.target === svgRef.current || (e.target as Element).getAttribute('data-bg')) {
          // The drawing keeps its aspect ratio inside a resized panel; clicks in the margin are kept inside the drawing area.
          const pt = toSvg(e);
          p.onBackground(clamp(pt.x, 30, VIEW_W - 30), clamp(pt.y, 30, VIEW_H - 40));
        }
      }}
    >
      <defs>
        <marker id="arrow-route" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--route)" />
        </marker>
        <marker id="arrow-spt" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.6" markerHeight="3.6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--route)" fillOpacity="0.7" />
        </marker>
      </defs>
      <rect data-bg="1" x={0} y={0} width={VIEW_W} height={VIEW_H} fill="transparent" />

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
            <text x={from.x + (to.x - from.x) * 0.3 + nx * side} y={from.y + (to.y - from.y) * 0.3 + ny * side + 4} textAnchor="middle" fontSize={10.5} style={{ fill: 'var(--muted)' }}>
              {ifc.name} {ifc.ip ? `${ifc.ip}/${ifc.prefix}` : '(no IP)'}
            </text>
          );
        return (
          <g key={l.id}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={l.up ? 'var(--link)' : 'var(--fail)'} strokeWidth={sel ? 5 : 3} strokeDasharray={l.up ? undefined : '9 7'} />
            <line
              className="linkhit" x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={18}
              onPointerDown={(e) => { e.stopPropagation(); p.onSelect({ kind: 'link', id: l.id }); }}
            >
              <title>{`Link ${l.up ? 'enabled' : 'DISABLED'}${cl ? `, ${cl}` : ''}. Click to inspect.`}</title>
            </line>
            {p.showAddresses && addr(ia, a, b, -17)}
            {p.showAddresses && addr(ib, b, a, -17)}
            {!l.up && (
              <g transform={`translate(${mx},${my})`} pointerEvents="none">
                <circle r={13} fill="var(--panel)" stroke="var(--fail)" strokeWidth={2.5} />
                <path d="M-6 -6 L6 6 M6 -6 L-6 6" stroke="var(--fail)" strokeWidth={3} strokeLinecap="round" />
                <text y={28} textAnchor="middle" fontSize={11} fontWeight={800} style={{ fill: 'var(--fail)' }}>DOWN</text>
              </g>
            )}
            {l.up && cl && (
              <g transform={`translate(${mx},${my})`} pointerEvents="none">
                <rect x={-26} y={-10} width={52} height={20} rx={10} fill="var(--panel)" stroke={sel ? 'var(--accent)' : 'var(--border)'} />
                <text y={4} textAnchor="middle" fontSize={11} fontWeight={600}>{cl}</text>
              </g>
            )}
          </g>
        );
      })}

      {p.topo.devices.map((d) => {
        const { x, y } = xy(d.id);
        const sel = p.selected?.kind === 'device' && p.selected.id === d.id;
        const focus = p.focus.includes(d.id);
        const pending = p.pendingLinkFrom === d.id;
        return (
          <g
            key={d.id}
            className="dev"
            transform={`translate(${x},${y})`}
            tabIndex={0}
            role="button"
            aria-label={`${d.kind === 'router' ? 'Router' : 'PC'} ${d.name}${sel ? ', selected' : ''}`}
            onPointerDown={(e) => onDevDown(e, d.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                p.onDevice(d.id);
              }
            }}
          >
            {(focus || pending) && <circle r={38} fill="none" stroke="var(--focus)" strokeWidth={3} strokeDasharray="6 5" className={p.reducedMotion ? '' : 'pulse'} />}
            {d.kind === 'router' ? (
              <g>
                <circle className="dev-shape" r={26} fill="var(--panel)" stroke={sel ? 'var(--accent)' : 'var(--router)'} strokeWidth={sel ? 5 : 3} />
                <g stroke="var(--router)" strokeWidth={2.5} strokeLinecap="round" fill="none">
                  <path d="M-13 -5 H-3 M-13 -5 l4 -4 M-13 -5 l4 4" />
                  <path d="M13 5 H3 M13 5 l-4 -4 M13 5 l-4 4" />
                  <path d="M-5 13 V3 M-5 13 l-4 -4 M-5 13 l4 -4" />
                  <path d="M5 -13 V-3 M5 -13 l-4 4 M5 -13 l4 4" />
                </g>
              </g>
            ) : (
              <g>
                <rect className="dev-shape" x={-22} y={-18} width={44} height={30} rx={3} fill="var(--panel)" stroke={sel ? 'var(--accent)' : 'var(--pc)'} strokeWidth={sel ? 5 : 3} />
                <rect x={-15} y={-12} width={30} height={18} fill="var(--panel-2)" />
                <path d="M-8 18 H8 M0 12 V18" stroke="var(--pc)" strokeWidth={3} />
              </g>
            )}
            <text y={d.kind === 'router' ? 44 : 38} textAnchor="middle" fontSize={15} fontWeight={700}>{d.name}</text>
          </g>
        );
      })}
      {token}
    </svg>
  );
}

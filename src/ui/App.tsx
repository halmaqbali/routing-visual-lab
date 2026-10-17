import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_OPTIONS, type Level, type Link, type Mode, type SimOptions, type Topology } from '../model/types';
import { fiveRouter, threeRouter, triangle } from '../model/samples';
import { addDevice, addLink, deviceName, getDevice, pcs, removeDevice, removeLink } from '../model/topology';
import { validateTopology } from '../model/validate';
import { applyLinkChange, applyStaticConfigChange, buildPingFrames, createTimeline, insertFrames, pingStatsFrame } from '../engine/simulation';
import { lookup, routeKey } from '../engine/rib';
import type { Frame, SimState } from '../engine/types';
import { SCENARIOS, type Scenario } from '../scenarios';
import { Canvas, type DirLink, type Sel, type Tool } from './Canvas';
import { Inspector } from './Inspector';
import { Explain } from './Explain';
import { Controls, Timeline } from './Timeline';
import { Assumptions, ComparePanel, Legend, ScenarioPanel, SettingsPanel } from './Panels';
import { clamp, DEFAULT_LAYOUT, MIN, PANEL_NAMES, PanelBar, PanelButtons, Splitter, useElementSize, useLayoutPrefs, useMediaQuery, type MoveDir, type PanelId } from './Layout';

type ViewMode = Mode | 'compare';
/** A ping in progress: pings are sent one at a time, as the timeline reaches each one. */
interface PingRun { src: string; dst: string; total: number; sent: number; received: number; endIndex: number; waitAt: number | null }
interface Teacher { on: boolean; gate: boolean; oneAtATime: boolean; hideValues: boolean }
interface Saved { format: 'routing-visual-lab'; version: 1; topo: Topology; mode: ViewMode; options: SimOptions; level: Level; scenario?: string | null }

const AUTOSAVE_KEY = 'routing-visual-lab:autosave';

function loadAutosave(): Saved | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Saved;
    return isSaved(s) ? s : null;
  } catch {
    return null;
  }
}

function isSaved(s: unknown): s is Saved {
  const x = s as Saved;
  return !!x && x.format === 'routing-visual-lab' && Array.isArray(x.topo?.devices) && Array.isArray(x.topo?.links) && ['static', 'dv', 'ls', 'compare'].includes(x.mode);
}

function mergeOptions(o?: Partial<SimOptions>): SimOptions {
  return { ...DEFAULT_OPTIONS, ...o, dv: { ...DEFAULT_OPTIONS.dv, ...(o?.dv ?? {}) } };
}

const simModeOf = (m: ViewMode): Mode => (m === 'compare' ? 'static' : m);

/** Follow next hops from a router towards a network, for highlighting a selected route. */
function tracePath(state: SimState, start: string, key: string): DirLink[] {
  const [net] = key.split('/');
  const out: DirLink[] = [];
  const seen = new Set<string>();
  let cur = start;
  for (let i = 0; i < 20; i++) {
    const table = state.tables[cur];
    if (!table || seen.has(cur)) break;
    seen.add(cur);
    const r = table.find((x) => routeKey(x) === key && !x.unreachable) ?? lookup(table, net).match;
    if (!r || r.unreachable || !r.iface) break;
    const link = state.topo.links.find((l) => (l.a.dev === cur && l.a.iface === r.iface) || (l.b.dev === cur && l.b.iface === r.iface));
    if (!link || !link.up) break;
    const peer = link.a.dev === cur ? link.b.dev : link.a.dev;
    const peerDev = getDevice(state.topo, peer);
    if (r.source === 'connected') {
      if (peerDev?.kind === 'pc') out.push({ linkId: link.id, from: cur, to: peer });
      break;
    }
    out.push({ linkId: link.id, from: cur, to: peer });
    cur = peer;
  }
  return out;
}

export default function App() {
  const saved = useMemo(loadAutosave, []);
  const [topo, setTopo] = useState<Topology>(saved?.topo ?? threeRouter());
  const [mode, setMode] = useState<ViewMode>(saved?.mode ?? 'static');
  const [options, setOptions] = useState<SimOptions>(mergeOptions(saved?.options));
  const [level, setLevel] = useState<Level>(saved?.level ?? 'beginner');
  const [frames, setFrames] = useState<Frame[]>(() => createTimeline(saved?.topo ?? threeRouter(), simModeOf(saved?.mode ?? 'static'), mergeOptions(saved?.options)));
  const [cursor, setCursor] = useState(() => ((saved?.mode ?? 'static') === 'dv' || saved?.mode === 'ls' ? 0 : 1));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [sel, setSel] = useState<Sel>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'warn' | 'err'; text: string } | null>(null);
  const [scenarioId, setScenarioId] = useState<string | null>(saved?.scenario ?? null);
  const [predicted, setPredicted] = useState<string | null>(null);
  const [ungated, setUngated] = useState(false);
  const [teacher, setTeacher] = useState<Teacher>({ on: false, gate: true, oneAtATime: false, hideValues: false });
  const [large, setLarge] = useState(false);
  const [follow, setFollow] = useState(true);
  const [showAddr, setShowAddr] = useState(true);
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [pingSrc, setPingSrc] = useState('pc1');
  const [pingDst, setPingDst] = useState('pc2');
  const [pingCount, setPingCount] = useState(3); // 0 = continuous until Stop
  const [run, setRun] = useState<PingRun | null>(null);
  const [lastStats, setLastStats] = useState<{ sent: number; received: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Layout (separate from simulation state: resizing never touches frames, topology or selection)
  const wide = useMediaQuery('(min-width: 900px)');
  const { layout, patch: patchLayout, reset: resetLayout } = useLayoutPrefs();
  const [maxed, setMaxed] = useState<PanelId | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [moving, setMoving] = useState<{ id: PanelId; x: number; y: number; over: number | null } | null>(null);
  const swapPanelsRef = useRef<(a: number, b: number) => void>(() => {});
  const wsEl = useRef<HTMLElement | null>(null);
  const [wsRef, wsSize] = useElementSize<HTMLElement>();
  const [leftRef, leftSize] = useElementSize<HTMLDivElement>();
  const [rightRef, rightSize] = useElementSize<HTMLDivElement>();
  const setWorkspace = useCallback((el: HTMLElement | null) => { wsRef(el); wsEl.current = el; }, [wsRef]);

  const frame = frames[Math.min(cursor, frames.length - 1)];
  const state = frame.state;
  const curTopo = mode === 'compare' ? topo : state.topo;
  const scenario: Scenario | undefined = SCENARIOS.find((s) => s.id === scenarioId);
  const issues = useMemo(() => validateTopology(curTopo), [curTopo]);
  const interval = 1400 / speed;
  const oneAtATime = teacher.on && teacher.oneAtATime;

  useEffect(() => {
    document.documentElement.classList.toggle('large', large);
  }, [large]);

  // Autosave (browser-local). Failures (private mode, blocked storage) are ignored.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const withPos = applyPositions(topo, pos);
        const s: Saved = { format: 'routing-visual-lab', version: 1, topo: withPos, mode, options, level, scenario: scenarioId };
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(s));
      } catch {
        /* storage unavailable */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [topo, pos, mode, options, level, scenarioId]);

  // Playback
  useEffect(() => {
    if (!playing) return;
    if (cursor >= frames.length - 1 && !run) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => advanceRef.current(), interval);
    return () => clearTimeout(id);
  }, [playing, cursor, frames.length, interval, run]);

  // Follow the current event: select the router where the packet / calculation is.
  useEffect(() => {
    if (!follow) return;
    const ev = frame.ev;
    const target = ev.ping?.at ?? ev.spf?.router ?? ev.dv?.to;
    if (target && getDevice(state.topo, target)) setSel({ kind: 'device', id: target });
  }, [cursor, frames, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (text: string, kind: 'info' | 'warn' | 'err' = 'info') => setNotice({ kind, text });

  const rebuild = useCallback((t: Topology, m: ViewMode, o: SimOptions, note?: string) => {
    const f = createTimeline(t, simModeOf(m), o);
    setFrames(f);
    // Static routing has no protocol to watch: open on the installed routes. Dynamic modes start at time 0.
    setCursor(simModeOf(m) === 'static' ? f.length - 1 : 0);
    setPlaying(false);
    setRun(null);
    if (note) flash(note, 'warn');
  }, []);

  function applyPositions(t: Topology, p: Record<string, { x: number; y: number }>): Topology {
    const c = structuredClone(t);
    for (const d of c.devices) if (p[d.id]) Object.assign(d, p[d.id]);
    return c;
  }

  // ------------------------------------------------------------ edits

  const structural = (t: Topology, desc: string) => {
    setTopo(t);
    rebuild(t, mode, options, `${desc}. The configuration changed, so the simulation restarted from time 0 with a new event sequence.`);
  };

  const onLink = (linkId: string, patch: Partial<Pick<Link, 'up' | 'cost'>>) => {
    const base = mode === 'compare' ? topo : state.topo;
    const t = structuredClone(base);
    const l = t.links.find((x) => x.id === linkId);
    if (!l) return;
    Object.assign(l, patch);
    const name = `${deviceName(t, l.a.dev)}–${deviceName(t, l.b.dev)}`;
    const desc = patch.up === false ? `Link ${name} disabled` : patch.up === true ? `Link ${name} enabled` : `Link ${name} cost set to ${patch.cost}`;
    setTopo(t);
    if (mode === 'compare') return;
    // At the very start of a dynamic protocol, apply the change after convergence so its effect is visible.
    let at = cursor;
    if (at === 0 && mode !== 'static') at = frames.length - 1;
    const nf = applyLinkChange(frames, at, t, [linkId], desc);
    setRun(null);
    setFrames(nf);
    setCursor(at + 1);
    setPlaying(false);
    flash(`${desc} at event ${at + 1}. Later events were discarded; a new event sequence continues from the current routing state.`);
  };

  const onStatic = (t: Topology, desc: string) => {
    setTopo(t);
    if (mode !== 'static') return rebuild(t, mode, options);
    const nf = applyStaticConfigChange(frames, cursor, t, desc);
    setRun(null);
    setFrames(nf);
    setCursor(cursor + 1);
    setPlaying(false);
  };

  const onDelete = (s: Sel) => {
    if (!s) return;
    const t = s.kind === 'device' ? removeDevice(curTopo, s.id) : removeLink(curTopo, s.id);
    setSel(null);
    structural(t, s.kind === 'device' ? `Deleted ${deviceName(curTopo, s.id)}` : 'Deleted a link');
  };

  const onBackground = (x: number, y: number) => {
    if (tool === 'router' || tool === 'pc') {
      const r = addDevice(applyPositions(curTopo, pos), tool, Math.round(x), Math.round(y));
      setSel({ kind: 'device', id: r.id });
      structural(r.topo, `Added ${deviceName(r.topo, r.id)}`);
      return;
    }
    setPendingLink(null);
    setSel(null);
    setSelectedKey(null);
  };

  const onDevice = (id: string) => {
    if (tool === 'link') {
      if (!pendingLink) {
        setPendingLink(id);
        flash(`Link: now click the second device to connect to ${deviceName(curTopo, id)}.`);
        return;
      }
      const r = addLink(applyPositions(curTopo, pos), pendingLink, id);
      setPendingLink(null);
      if (r.error) return flash(r.error, 'err');
      structural(r.topo, `Linked ${deviceName(r.topo, pendingLink)} and ${deviceName(r.topo, id)} (addresses assigned automatically)`);
      return;
    }
    if (tool === 'delete') return onDelete({ kind: 'device', id });
    setSel({ kind: 'device', id });
    setSelectedKey(null);
  };

  const onSelectLink = (s: Sel) => {
    if (tool === 'delete' && s) return onDelete(s);
    setSel(s);
  };

  // ------------------------------------------------------------ scenarios / files

  const loadScenario = (sc: Scenario) => {
    const t = sc.topology();
    const o = mergeOptions({ dv: { ...DEFAULT_OPTIONS.dv, ...(sc.dv ?? {}) } });
    setTopo(t);
    setMode(sc.mode);
    setOptions(o);
    setLevel(sc.level);
    setPos({});
    setScenarioId(sc.id);
    setPredicted(null);
    setUngated(false);
    setSel(sc.select ? { kind: 'device', id: sc.select } : null);
    setSelectedKey(null);
    if (sc.ping) {
      setPingSrc(sc.ping[0]);
      setPingDst(sc.ping[1]);
    }
    rebuild(t, sc.mode, o);
    flash(`Loaded scenario ${sc.num}: ${sc.title}.`);
  };

  const quickAction = (i: number) => {
    const q = scenario?.quickActions?.[i];
    if (!q) return;
    const l = state.topo.links.find((x) => (x.a.dev === q.link[0] && x.b.dev === q.link[1]) || (x.a.dev === q.link[1] && x.b.dev === q.link[0]));
    if (!l) return flash('That link no longer exists in this topology.', 'err');
    onLink(l.id, q.up !== undefined ? { up: q.up } : { cost: q.cost });
  };

  const newTopology = (kind: string) => {
    const t = kind === 'three' ? threeRouter() : kind === 'five' ? fiveRouter() : kind === 'triangle' ? triangle() : { devices: [], links: [] };
    setScenarioId(null);
    setPos({});
    setSel(null);
    setTopo(t);
    rebuild(t, mode, options);
    flash(kind === 'empty' ? 'Empty network. Use "+ Router", "+ PC" and "Link" to build one.' : 'New topology loaded.');
  };

  const save = () => {
    const s: Saved = { format: 'routing-visual-lab', version: 1, topo: applyPositions(curTopo, pos), mode, options, level, scenario: scenarioId };
    const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'routing-lab-topology.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const load = async (file: File) => {
    try {
      const s = JSON.parse(await file.text());
      if (!isSaved(s)) throw new Error('This file is not a Routing Visual Lab topology.');
      const o = mergeOptions(s.options);
      setTopo(s.topo);
      setMode(s.mode);
      setOptions(o);
      setLevel(s.level ?? 'beginner');
      setPos({});
      setScenarioId(null);
      setSel(null);
      rebuild(s.topo, s.mode, o);
      flash(`Loaded ${file.name}.`);
    } catch (e) {
      flash(`Could not load file: ${(e as Error).message}`, 'err');
    }
  };

  const pingLabel = (n: number, total: number) => (total === Infinity ? `Ping ${n}` : total === 1 ? 'Ping' : `Ping ${n} of ${total}`);

  /** Insert the next ping of the run right after frame `at`, using the routing tables at that moment. */
  const sendNextPing = (r: PingRun, at: number, base: Frame[] = frames) => {
    const { frames: pf, result } = buildPingFrames(base[at].state, r.src, r.dst, pingLabel(r.sent + 1, r.total));
    const next: PingRun = { ...r, sent: r.sent + 1, received: r.received + (result.success ? 1 : 0), endIndex: at + pf.length, waitAt: null };
    setFrames(insertFrames(base, at, pf));
    setRun(next);
    setLastStats({ sent: next.sent, received: next.received });
    setCursor(at + 1);
  };

  const runPing = () => {
    if (!pingSrc || !pingDst || pingSrc === pingDst) return flash('Choose two different PCs.', 'err');
    const r: PingRun = { src: pingSrc, dst: pingDst, total: pingCount === 0 ? Infinity : pingCount, sent: 0, received: 0, endIndex: cursor, waitAt: null };
    sendNextPing(r, cursor);
    setPlaying(!oneAtATime);
  };

  /** End the run (Stop, or after the last ping) with a statistics event after the last ping. */
  const finishPing = (r: PingRun, target?: number) => {
    const stats = pingStatsFrame(frames[r.endIndex].state, r.src, r.dst, r.sent, r.received);
    setFrames(insertFrames(frames, r.endIndex, [stats]));
    setRun(null);
    // Without a target, show the statistics. Otherwise keep the requested event (shifted past the inserted one).
    setCursor(target === undefined ? r.endIndex + 1 : target > r.endIndex ? target + 1 : target);
  };

  /**
   * Next event. While a ping run is active, the next ping is sent when the previous one has finished.
   * If routing events are still pending, one routing event happens between pings, so later pings
   * can see routing tables change (for example during convergence or count to infinity).
   */
  const advance = () => {
    if (run) {
      if (cursor === run.endIndex && run.waitAt === null) {
        if (run.sent >= run.total) return finishPing(run);
        const nxt = frames[cursor + 1];
        if (nxt && nxt.ev.category !== 'data') {
          setRun({ ...run, waitAt: cursor + 1 });
          setCursor(cursor + 1);
          return;
        }
        return sendNextPing(run, cursor);
      }
      if (run.waitAt !== null && cursor === run.waitAt) return sendNextPing(run, cursor);
    }
    if (cursor < frames.length - 1) setCursor(cursor + 1);
    else setPlaying(false);
  };
  const advanceRef = useRef(advance);
  advanceRef.current = advance;
  const runRef = useRef(run);
  runRef.current = run;

  // ------------------------------------------------------------ presentation (full-screen topology)

  const startPresenting = () => {
    setPresenting(true);
    document.documentElement.requestFullscreen?.().catch(() => { /* full screen not allowed: the in-page view still works */ });
  };
  const stopPresenting = () => {
    setPresenting(false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  };
  useEffect(() => {
    const on = () => { if (!document.fullscreenElement) setPresenting(false); };
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  // Dragging a panel by its move handle: follow the pointer, highlight the position under it, swap on release.
  const movingId = moving?.id;
  useEffect(() => {
    if (!movingId) return;
    const slotAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest('[data-slot]') as HTMLElement | null;
      return el ? Number(el.dataset.slot) : null;
    };
    const move = (e: PointerEvent) => setMoving((m) => m && { ...m, x: e.clientX, y: e.clientY, over: slotAt(e.clientX, e.clientY) });
    const up = (e: PointerEvent) => {
      const over = slotAt(e.clientX, e.clientY);
      const from = layout.order.indexOf(movingId);
      setMoving(null);
      if (over !== null && over !== from) swapPanelsRef.current(from, over);
    };
    const cancel = (e: KeyboardEvent | PointerEvent) => { if (!('key' in e) || e.key === 'Escape') setMoving(null); };
    document.body.classList.add('moving-panel');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', cancel);
    return () => {
      document.body.classList.remove('moving-panel');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', cancel);
    };
  }, [movingId, layout.order]);

  // ------------------------------------------------------------ keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === 'Escape') { setMaxed(null); setPresenting(false); }
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || (e.target as HTMLElement).getAttribute('role') === 'separator' || mode === 'compare') return;
      if (e.key === 'ArrowRight') { setPlaying(false); advanceRef.current(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { setPlaying(false); setCursor((c) => Math.max(c - 1, 0)); e.preventDefault(); }
      else if (e.key === ' ' && tag !== 'BUTTON') { if (!oneAtATime) setPlaying((p) => !p); e.preventDefault(); }
      else if (e.key === 'Home') { setPlaying(false); setCursor(0); }
      else if (e.key === 'End' && !oneAtATime && !runRef.current) { setPlaying(false); setCursor(frames.length - 1); }
      else if (e.key === 'Escape') { setTool('select'); setPendingLink(null); setShowAssumptions(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [frames.length, mode, oneAtATime]);

  // ------------------------------------------------------------ derived view data

  const selRouter = sel?.kind === 'device' && getDevice(state.topo, sel.id)?.kind === 'router' ? sel.id : null;
  const routePath = useMemo(() => (selRouter && selectedKey && mode !== 'compare' ? tracePath(state, selRouter, selectedKey) : []), [state, selRouter, selectedKey, mode]);
  const sptPath = useMemo(() => {
    if (mode !== 'ls' || !selRouter) return [];
    const spf = state.ls?.routers[selRouter]?.spf;
    if (!spf) return [];
    const limit = state.spfView?.router === selRouter ? state.spfView.step : spf.steps.length;
    const confirmed = new Set(spf.steps.slice(0, limit).map((s) => s.selected));
    return Object.entries(spf.pred).filter(([n, p]) => p && confirmed.has(n)).map(([n, p]) => ({ linkId: p!.linkId, from: p!.node, to: n }));
  }, [state, selRouter, mode]);
  const pcList = pcs(curTopo);
  const gated = teacher.on && teacher.gate && !!scenario && predicted === null && !ungated;
  const ctx = { frames, cursor, state, topo: curTopo, selected: selRouter };
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  // ------------------------------------------------------------ panel sections (the same elements are placed by every layout)

  // Positions: [left top, left bottom, right top, right bottom]. The top panel of each column has a height
  // (canvasH = left column, timelineH = right column); the bottom panel takes the rest.
  const order = layout.order;
  const visible = (id: PanelId) => !(id === 'timeline' && mode === 'compare');
  const collapsedOf = (id: PanelId) => (id === 'timeline' ? layout.timelineCollapsed : id === 'details' ? layout.detailsCollapsed && mode !== 'compare' : false);
  const minTop = (id: PanelId) => (id === 'canvas' ? MIN.canvasH : MIN.timelineH);
  const sidebarMax = Math.max(MIN.sidebar, wsSize.w - MIN.left - 12);
  const sidebarW = clamp(layout.sidebar, MIN.sidebar, wsSize.w ? sidebarMax : layout.sidebar);
  const canvasMax = Math.max(minTop(order[0]), leftSize.h - MIN.simH - 12);
  const canvasH = clamp(layout.canvasH, minTop(order[0]), leftSize.h ? canvasMax : layout.canvasH);
  const timelineMax = Math.max(minTop(order[2]), rightSize.h - MIN.detailsH - 12);
  const timelineH = clamp(layout.timelineH, minTop(order[2]), rightSize.h ? timelineMax : layout.timelineH);
  const setVar = (name: string, v: number) => wsEl.current?.style.setProperty(name, `${v}px`);

  // ------------------------------------------------------------ moving panels (swap positions)

  const swapPanels = (a: number, b: number) => {
    const o = [...order];
    [o[a], o[b]] = [o[b], o[a]];
    patchLayout({ order: o });
    flash(`Moved the ${PANEL_NAMES[o[b]]} panel; it swapped places with ${PANEL_NAMES[o[a]]}.`);
  };
  const startMove = (id: PanelId, e: React.PointerEvent) => {
    e.preventDefault();
    setMoving({ id, x: e.clientX, y: e.clientY, over: null });
  };
  const moveKey = (id: PanelId, dir: MoveDir) => {
    const i = order.indexOf(id);
    let j = -1;
    if (wide) {
      if (dir === 'up' && i % 2 === 1) j = i - 1;
      if (dir === 'down' && i % 2 === 0) j = i + 1;
      if (dir === 'left' && i >= 2) j = i - 2;
      if (dir === 'right' && i < 2) j = i + 2;
    } else {
      if (dir === 'up' && i > 0) j = i - 1;
      if (dir === 'down' && i < 3) j = i + 1;
    }
    if (j < 0) return;
    swapPanels(i, j);
    requestAnimationFrame(() => (document.querySelector(`.move-grip[aria-label^="Move ${PANEL_NAMES[id]}"]`) as HTMLElement | null)?.focus());
  };
  const mv = { onMoveStart: startMove, onMoveKey: moveKey };
  swapPanelsRef.current = swapPanels;

  const controls = (
    <Controls
      cursor={cursor} total={frames.length} playing={playing} speed={speed} playDisabled={oneAtATime}
      canAdvance={!!run || cursor < frames.length - 1} endDisabled={!!run}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onPrev={() => { setPlaying(false); setCursor(Math.max(0, cursor - 1)); }}
      onNext={() => { setPlaying(false); advance(); }}
      onEnd={() => { setPlaying(false); setCursor(frames.length - 1); }}
      onReset={() => rebuild(topo, mode, options, 'Simulation reset to time 0 using the current configuration.')}
      onSpeed={setSpeed}
    />
  );

  const canvasSection = (
    <section className="card canvas-wrap panel" aria-label="Network canvas">
      <div className="toolbar" role="toolbar" aria-label="Editing tools">
        {([['select', '↖ Select / drag'], ['router', '+ Router'], ['pc', '+ PC'], ['link', '⟷ Link'], ['delete', '🗑 Delete']] as const).map(([t, l]) => (
          <button key={t} className="btn small" aria-pressed={tool === t} onClick={() => { setTool(t); setPendingLink(null); }}>{l}</button>
        ))}
        <label className="small"><input type="checkbox" checked={showAddr} onChange={(e) => setShowAddr(e.target.checked)} /> Addresses</label>
        <label className="small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow events</label>
        <span className="hint">{tool === 'router' || tool === 'pc' ? 'Click empty space to place it.' : tool === 'link' ? (pendingLink ? 'Click the second device.' : 'Click the first device.') : tool === 'delete' ? 'Click a device or link to delete it.' : 'Click to inspect · drag to move'}</span>
        {!presenting && (
          <PanelButtons id="canvas" maxed={maxed} onMax={setMaxed} {...mv}
            extra={<button className="btn small" onClick={startPresenting} title="Full-screen topology for classroom presentation">⛶ Present</button>} />
        )}
      </div>
      <div className="canvas-area">
        <Canvas
          topo={curTopo} pos={pos} mode={mode} options={options} selected={sel} tool={tool} pendingLinkFrom={pendingLink}
          anim={mode === 'compare' ? undefined : frame.ev.anim} animKey={cursor} duration={Math.min(1200, interval * 0.75)} reducedMotion={reducedMotion}
          routePath={routePath} sptPath={sptPath} focus={mode === 'compare' ? [] : frame.ev.routers ?? []} showAddresses={showAddr}
          onSelect={onSelectLink} onBackground={onBackground} onDevice={onDevice} onMove={(id, x, y) => setPos((p) => ({ ...p, [id]: { x, y } }))}
        />
      </div>
    </section>
  );

  const simSection = (
    <section className="panel plain" aria-label={mode === 'compare' ? 'Comparison' : 'Simulation controls and explanation'}>
      <PanelBar title={mode === 'compare' ? 'Comparison' : 'Controls & explanation'}>
        <PanelButtons id="sim" maxed={maxed} onMax={setMaxed} {...mv} />
      </PanelBar>
      <div className="panel-body">
        {mode === 'compare' ? (
          <ComparePanel topo={applyPositions(topo, pos)} options={options} />
        ) : (
          <>
            <section className="card stack" aria-label="Simulation and ping controls">
              {controls}
              <div className="row">
                <strong>Ping:</strong>
                <label>from <select value={pingSrc} onChange={(e) => setPingSrc(e.target.value)} aria-label="Source PC">{pcList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                <label>to <select value={pingDst} onChange={(e) => setPingDst(e.target.value)} aria-label="Destination PC">{pcList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                <label>count <select value={pingCount} onChange={(e) => setPingCount(Number(e.target.value))} aria-label="Number of pings" disabled={!!run}>
                  <option value={1}>1</option>
                  <option value={3}>3</option>
                  <option value={0}>∞ (until Stop)</option>
                </select></label>
                {run ? (
                  <button className="btn danger" onClick={() => { setPlaying(false); finishPing(run, cursor); }}>■ Stop ping</button>
                ) : (
                  <button className="btn primary" onClick={runPing} disabled={pcList.length < 2}>✉ Run ping</button>
                )}
                {lastStats && (
                  <span className="pill" aria-live="polite">
                    {run ? (run.total === Infinity ? `Sent ${lastStats.sent}` : `Sent ${lastStats.sent} of ${run.total}`) : `Last run: sent ${lastStats.sent}`} · received {lastStats.received} · lost {lastStats.sent - lastStats.received}
                  </span>
                )}
              </div>
              <div className="small muted">
                Each ping is one echo request + one echo reply, using the routing tables at that moment. Pings are sent one after another; if routing events are still pending, one happens between pings.
              </div>
            </section>
            <Explain frame={frame} index={cursor} total={frames.length} level={level} gated={gated} hideValues={teacher.on && teacher.hideValues} onUngate={() => setUngated(true)} />
          </>
        )}
        <Legend />
      </div>
    </section>
  );

  const timelineSection = (
    <Timeline
      frames={frames} cursor={cursor} onJump={(i) => { setPlaying(false); if (run) finishPing(run, i); else setCursor(i); }} hideFuture={oneAtATime}
      fill={wide || maxed === 'timeline'} collapsed={layout.timelineCollapsed && maxed !== 'timeline'}
      actions={<PanelButtons id="timeline" maxed={maxed} onMax={setMaxed} {...mv} collapsed={layout.timelineCollapsed} onCollapse={() => patchLayout({ timelineCollapsed: !layout.timelineCollapsed })} />}
    />
  );

  const detailsCollapsed = layout.detailsCollapsed && maxed !== 'details' && mode !== 'compare';
  const detailsSection = (
    <section className="panel plain" aria-label="Learning activity and inspector">
      <PanelBar title={mode === 'compare' ? 'About the comparison' : scenario ? 'Learning activity & inspector' : 'Settings & inspector'}>
        <PanelButtons id="details" maxed={maxed} onMax={setMaxed} {...mv} collapsed={detailsCollapsed} onCollapse={mode === 'compare' ? undefined : () => patchLayout({ detailsCollapsed: !layout.detailsCollapsed })} />
      </PanelBar>
      {!detailsCollapsed && (
        <div className="panel-body">
          {scenario && (scenario.mode === 'compare') === (mode === 'compare') && (
            <ScenarioPanel sc={scenario} ctx={ctx} predicted={predicted} onPredict={setPredicted} onReset={() => loadScenario(scenario)} onQuick={quickAction} teacher={teacher.on && teacher.gate} />
          )}
          {mode !== 'compare' && <SettingsPanel mode={mode} options={options} level={level} topo={state.topo} onOptions={(o) => { setOptions(o); rebuild(topo, mode, o, 'Protocol settings changed: the simulation restarted from time 0.'); }} />}
          {mode !== 'compare' && (
            <Inspector
              state={state} frames={frames} cursor={cursor} level={level} options={options} sel={sel} hideValues={teacher.on && teacher.hideValues}
              changes={frame.ev.changes ?? []} pingHop={frame.ev.ping} selectedKey={selectedKey} onSelectKey={setSelectedKey}
              onStructural={structural} onLink={onLink} onStatic={onStatic} onDelete={onDelete}
            />
          )}
          {mode === 'compare' && (
            <section className="card">
              <h2>How to read the comparison</h2>
              <p className="small">Each column is a real simulation of the same topology. Static routing uses whatever static routes are configured (switch to Static mode to edit them). Pick a link to fail and compare how each approach responds, and whether a person has to fix anything.</p>
            </section>
          )}
        </div>
      )}
    </section>
  );

  const sectionFor = (id: PanelId) => (id === 'canvas' ? canvasSection : id === 'sim' ? simSection : id === 'timeline' && mode !== 'compare' ? timelineSection : detailsSection);

  const slotClass = (i: number, id: PanelId) =>
    `slot ${moving && moving.over === i && moving.id !== id ? 'drop-target' : ''} ${moving?.id === id ? 'drag-source' : ''}`;

  const renderColumn = (side: 'left' | 'right') => {
    const [ti, bi] = side === 'left' ? [0, 1] : [2, 3];
    const t = order[ti];
    const b = order[bi];
    const tv = visible(t);
    const bv = visible(b);
    const tc = collapsedOf(t);
    const bc = collapsedOf(b);
    const h = side === 'left' ? canvasH : timelineH;
    const max = side === 'left' ? canvasMax : timelineMax;
    const cssVar = side === 'left' ? '--canvas-h' : '--timeline-h';
    const key = side === 'left' ? 'canvasH' : 'timelineH';
    return (
      <div className="wcol" ref={side === 'left' ? leftRef : rightRef}>
        {tv && (
          <div data-slot={ti} className={`${slotClass(ti, t)} ${tc ? 'slot-auto' : !bv || bc ? 'slot-fill' : side === 'left' ? 'slot-sized-l' : 'slot-sized-r'}`}>{sectionFor(t)}</div>
        )}
        {tv && bv && !tc && !bc && (
          <Splitter
            orientation="horizontal" label={`Divider between ${PANEL_NAMES[t]} and ${PANEL_NAMES[b]}`} value={h} min={minTop(t)} max={max}
            onLive={(v) => setVar(cssVar, v)} onCommit={(v) => patchLayout({ [key]: v })} onReset={() => patchLayout({ [key]: DEFAULT_LAYOUT[key] })}
          />
        )}
        {bv && <div data-slot={bi} className={`${slotClass(bi, b)} ${bc ? 'slot-auto' : 'slot-fill'}`}>{sectionFor(b)}</div>}
      </div>
    );
  };

  const switchMode = (m: ViewMode) => {
    setMode(m);
    rebuild(topo, m, options);
  };

  return (
    <div className={`app ${wide && !presenting ? 'app-wide' : ''} ${presenting ? 'app-present' : ''}`}>
      {!presenting && <header className="topbar">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2"><circle cx="5" cy="12" r="3" /><circle cx="19" cy="5" r="3" /><circle cx="19" cy="19" r="3" /><path d="M8 11 16 6M8 13l8 5" /></svg>
          Routing Visual Lab
        </div>
        <div className="seg" role="group" aria-label="Routing mode">
          {([['static', 'Static'], ['dv', 'Distance Vector'], ['ls', 'Link State'], ['compare', 'Compare']] as const).map(([m, l]) => (
            <button key={m} aria-pressed={mode === m} onClick={() => switchMode(m)}>{l}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Level">
          <button aria-pressed={level === 'beginner'} onClick={() => setLevel('beginner')}>Beginner</button>
          <button aria-pressed={level === 'advanced'} onClick={() => setLevel('advanced')}>Advanced</button>
        </div>
        <label>
          <span className="sr-only">Scenario</span>
          <select value={scenarioId ?? ''} onChange={(e) => { const sc = SCENARIOS.find((s) => s.id === e.target.value); if (sc) loadScenario(sc); else setScenarioId(null); }} aria-label="Guided scenario">
            <option value="">Free play (no scenario)</option>
            {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.num}. {s.title}</option>)}
          </select>
        </label>
        <div className="spacer" />
        <div className="group">
          <button className="btn" aria-pressed={teacher.on} onClick={() => setTeacher({ ...teacher, on: !teacher.on })}>🎓 Teacher</button>
          <button className="btn" aria-pressed={large} onClick={() => setLarge(!large)} title="Enlarge labels and tables for projection">⛶ Projector</button>
          <button className="btn" aria-pressed={reducedMotion} onClick={() => setReducedMotion(!reducedMotion)} title="Turn packet movement on or off">Reduce motion</button>
          <button className="btn" onClick={() => { resetLayout(); setMaxed(null); }} title="Restore the default panel sizes">▦ Reset layout</button>
          <button className="btn" onClick={() => setShowAssumptions(true)}>ⓘ Model assumptions</button>
          <select aria-label="New topology" value="" onChange={(e) => e.target.value && newTopology(e.target.value)}>
            <option value="">New…</option>
            <option value="three">3 routers (simple)</option>
            <option value="five">5 routers (alternative paths)</option>
            <option value="triangle">Triangle (weighted)</option>
            <option value="empty">Empty canvas</option>
          </select>
          <button className="btn" onClick={save} title="Download this topology as JSON">⬇ Save</button>
          <button className="btn" onClick={() => fileRef.current?.click()} title="Load a topology JSON file">⬆ Load</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); e.target.value = ''; }} />
        </div>
      </header>}

      {teacher.on && !presenting && (
        <div className="card teacher-panel" role="region" aria-label="Teacher controls">
          <div className="row">
            <strong>Teacher Mode:</strong>
            <label><input type="checkbox" checked={teacher.gate} onChange={(e) => setTeacher({ ...teacher, gate: e.target.checked })} /> Hide explanations until a prediction is made</label>
            <label><input type="checkbox" checked={teacher.oneAtATime} onChange={(e) => { setTeacher({ ...teacher, oneAtATime: e.target.checked }); setPlaying(false); }} /> Reveal one event at a time</label>
            <label><input type="checkbox" checked={teacher.hideValues} onChange={(e) => setTeacher({ ...teacher, hideValues: e.target.checked })} /> Hide next hops &amp; costs (click "?" to reveal)</label>
            {scenario && <button className="btn small" onClick={() => loadScenario(scenario)}>↺ Reset scenario now</button>}
          </div>
        </div>
      )}

      {!presenting && (notice || errors.length > 0 || warnings.length > 0) && (
        <div className="banners">
          {notice && (
            <div className={`banner ${notice.kind}`} role="status">
              <span>{notice.text}</span>
              <button className="btn small x" onClick={() => setNotice(null)} aria-label="Dismiss message">✕</button>
            </div>
          )}
          {(errors.length > 0 || warnings.length > 0) && (
            <details className={`banner ${errors.length ? 'err' : 'warn'}`}>
              <summary>{errors.length ? `✖ ${errors.length} configuration error${errors.length > 1 ? 's' : ''}` : ''}{errors.length && warnings.length ? ' · ' : ''}{warnings.length ? `▲ ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : ''} — click for details</summary>
              {issues.map((i, k) => <p key={k} className={`issue ${i.severity}`}>{i.message}</p>)}
            </details>
          )}
        </div>
      )}

      {presenting ? (
        <main className="present">
          {canvasSection}
          <div className="present-bar card">
            {mode !== 'compare' && controls}
            <span className="present-title">{mode !== 'compare' ? frame.ev.title : 'Compare mode'}</span>
            <button className="btn" onClick={stopPresenting}>✕ Exit full screen (Esc)</button>
          </div>
        </main>
      ) : maxed ? (
        <main className="workspace single" ref={wsRef}>
          {sectionFor(maxed)}
        </main>
      ) : wide ? (
        <main
          className="workspace"
          ref={setWorkspace}
          style={{ '--sidebar': `${sidebarW}px`, '--canvas-h': `${canvasH}px`, '--timeline-h': `${timelineH}px` } as React.CSSProperties}
        >
          {renderColumn('left')}
          <Splitter
            orientation="vertical" invert label="Divider between the left and right columns" value={sidebarW} min={MIN.sidebar} max={sidebarMax}
            onLive={(v) => setVar('--sidebar', v)} onCommit={(v) => patchLayout({ sidebar: v })} onReset={() => patchLayout({ sidebar: DEFAULT_LAYOUT.sidebar })}
          />
          {renderColumn('right')}
        </main>
      ) : (
        <main className="stacked">
          {order.map((id, i) => visible(id) && <div key={id} data-slot={i} className={slotClass(i, id)}>{sectionFor(id)}</div>)}
        </main>
      )}
      {moving && (
        <div className="move-ghost" style={{ left: moving.x + 14, top: moving.y + 14 }} aria-hidden>
          Move {PANEL_NAMES[moving.id]}
          {moving.over !== null && order[moving.over] !== moving.id ? ` → swap with ${PANEL_NAMES[order[moving.over]]}` : ''}
        </div>
      )}
      {showAssumptions && <Assumptions onClose={() => setShowAssumptions(false)} />}
    </div>
  );
}

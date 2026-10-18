import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_OPTIONS, type Level, type Link, type Mode, type SimOptions, type Topology } from '../model/types';
import { fiveRouter, loopbackLine, switchedLan, threeRouter, triangle } from '../model/samples';
import { addDevice, addLink, deviceName, getDevice, removeDevice, removeLink } from '../model/topology';
import { validateTopology } from '../model/validate';
import { applyLinkChange, applyStaticConfigChange, buildPingFrames, clearL2, createTimeline, insertFrames, pingStatsFrame } from '../engine/simulation';
import { lookup, routeKey } from '../engine/rib';
import type { Frame, SimState } from '../engine/types';
import { SCENARIOS, type Scenario } from '../scenarios';
import { coreOf, LAB_FORMAT, LAB_VERSION, mergeOptions, newId, parseLabText, type Lab, type LabCore, type Note } from '../lab/lab';
import { LabLibrary } from '../lab/library';
import { decodeLab, labCodeFromHash } from '../lab/share';
import { applyTheme, loadTheme, saveTheme, type ThemePref } from '../lab/theme';
import { Canvas, DEFAULT_VIEW, fitView, GRID, VIEW_H, VIEW_W, type DirLink, type Sel, type Tool, type View } from './Canvas';
import { Inspector } from './Inspector';
import { Explain } from './Explain';
import { Controls, Timeline } from './Timeline';
import { Assumptions, ComparePanel, Legend, ScenarioPanel, SettingsPanel } from './Panels';
import { clamp, DEFAULT_LAYOUT, MIN, PANEL_NAMES, PanelBar, PanelButtons, Splitter, useElementSize, useLayoutPrefs, useMediaQuery, type MoveDir, type PanelId } from './Layout';
import { PacketInspector } from './PacketInspector';
import { ConnectivityCheck, downloadLab, NameDialog, OpenLabDialog, ShareDialog } from './LabDialogs';
import { addressList, NotePanel, PingTool, type PingForm } from './Tools';

type ViewMode = Mode | 'compare';
/** A ping in progress: pings are sent one at a time, as the timeline reaches each one. */
interface PingRun { form: PingForm; total: number; sent: number; received: number; endIndex: number; waitAt: number | null }
interface Teacher { on: boolean; gate: boolean; oneAtATime: boolean; hideValues: boolean }
interface LabInfo { id: string; name: string; createdAt: string; inLibrary: boolean; exercise?: Lab['exercise'] }
interface Snapshot { topo: Topology; notes: Note[] }
type DetailsTab = 'inspect' | 'packet' | 'scenario' | 'settings';

const simModeOf = (m: ViewMode): Mode => (m === 'compare' ? 'static' : m);
const startCursor = (m: ViewMode, f: Frame[]) => (simModeOf(m) === 'static' ? f.length - 1 : 0);

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
      if (peerDev?.kind !== 'router') out.push({ linkId: link.id, from: cur, to: peer });
      break;
    }
    out.push({ linkId: link.id, from: cur, to: peer });
    if (peerDev?.kind !== 'router') break;
    cur = peer;
  }
  return out;
}

function defaultPing(topo: Topology): PingForm {
  const hosts = topo.devices.filter((d) => d.kind === 'pc' && d.ifaces[0]?.ip);
  const src = hosts[0] ?? topo.devices.find((d) => d.kind === 'router');
  const dst = hosts[hosts.length - 1] && hosts.length > 1 ? hosts[hosts.length - 1].ifaces[0].ip : addressList(topo).find((a) => a.dev !== src?.id)?.ip ?? '';
  return { src: src?.id ?? '', srcIp: '', dstIp: dst };
}

export default function App() {
  const library = useMemo(() => new LabLibrary(), []);
  const initial = useMemo(() => library.loadCurrent(), [library]);
  const [topo, setTopo] = useState<Topology>(initial?.topo ?? threeRouter());
  const [notes, setNotes] = useState<Note[]>(initial?.notes ?? []);
  const [mode, setMode] = useState<ViewMode>(initial?.mode ?? 'static');
  const [options, setOptions] = useState<SimOptions>(mergeOptions(initial?.options));
  const [level, setLevel] = useState<Level>(initial?.level ?? 'beginner');
  const [labInfo, setLabInfo] = useState<LabInfo>(() => ({
    id: initial?.id ?? newId(), name: initial?.name ?? 'My lab', createdAt: initial?.createdAt ?? new Date().toISOString(),
    inLibrary: !!initial && !!library.load(initial.id), exercise: initial?.exercise,
  }));
  const [dirty, setDirty] = useState(false);
  const [frames, setFrames] = useState<Frame[]>(() => createTimeline(initial?.topo ?? threeRouter(), simModeOf(initial?.mode ?? 'static'), mergeOptions(initial?.options)));
  const [cursor, setCursor] = useState(() => {
    const f0 = frames;
    const saved = initial?.sim?.cursor;
    return typeof saved === 'number' ? clamp(saved, 0, f0.length - 1) : startCursor(initial?.mode ?? 'static', f0);
  });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [sel, setSel] = useState<Sel>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'warn' | 'err'; text: string } | null>(null);
  const [scenarioId, setScenarioId] = useState<string | null>(initial?.scenario ?? null);
  const [predicted, setPredicted] = useState<string | null>(null);
  const [ungated, setUngated] = useState(false);
  const [teacher, setTeacher] = useState<Teacher>({ on: false, gate: true, oneAtATime: false, hideValues: false });
  const [large, setLarge] = useState(false);
  const [follow, setFollow] = useState(true);
  const [showAddr, setShowAddr] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [snap, setSnap] = useState(true);
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [pingForm, setPingForm] = useState<PingForm>(() => defaultPing(initial?.topo ?? threeRouter()));
  const [pingCount, setPingCount] = useState(3); // 0 = continuous until Stop
  const [run, setRun] = useState<PingRun | null>(null);
  const [lastStats, setLastStats] = useState<{ sent: number; received: number } | null>(null);
  const [detailsTab, setDetailsTab] = useState<DetailsTab>('inspect');
  const [dialog, setDialog] = useState<null | 'open' | 'share' | 'save' | 'check' | { shared: Lab }>(null);
  const [theme, setTheme] = useState<ThemePref>(() => loadTheme(typeof localStorage !== 'undefined' ? localStorage : null));
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const [, setHistoryTick] = useState(0);
  const gestureSnap = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Layout (separate from simulation state: resizing never touches frames, topology or selection)
  const wide = useMediaQuery('(min-width: 900px)');
  const { layout, patch: patchLayout, reset: resetLayout } = useLayoutPrefs();
  const [maxed, setMaxed] = useState<PanelId | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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

  useEffect(() => {
    applyTheme(document.documentElement, theme);
    saveTheme(typeof localStorage !== 'undefined' ? localStorage : null, theme);
  }, [theme]);

  function applyPositions(t: Topology, p: Record<string, { x: number; y: number }>): Topology {
    const c = structuredClone(t);
    for (const d of c.devices) if (p[d.id]) Object.assign(d, p[d.id]);
    return c;
  }

  /** The complete lab as it is now: topology, every device's configuration, notes, settings and timeline position. */
  const currentLab = (): Lab => ({
    format: LAB_FORMAT, version: LAB_VERSION, id: labInfo.id, name: labInfo.name, createdAt: labInfo.createdAt, updatedAt: new Date().toISOString(),
    topo: applyPositions(topo, pos), notes, mode, options, level, scenario: scenarioId,
    sim: { cursor, tables: state.tables }, exercise: labInfo.exercise,
  });
  const currentLabRef = useRef(currentLab);
  currentLabRef.current = currentLab;

  // Autosave the working lab (browser-local). Failures (private mode, full storage) are ignored.
  useEffect(() => {
    const t = setTimeout(() => library.saveCurrent(currentLabRef.current()), 500);
    return () => clearTimeout(t);
  }, [topo, pos, notes, mode, options, level, scenarioId, labInfo, cursor, library]);

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

  // Follow the current event: select the device where the packet / calculation is.
  useEffect(() => {
    if (!follow) return;
    const ev = frame.ev;
    const target = ev.ping?.at ?? ev.spf?.router ?? ev.dv?.to;
    if (target && getDevice(state.topo, target)) setSel({ kind: 'device', id: target });
  }, [cursor, frames, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the ping form valid when devices change.
  useEffect(() => {
    if (!curTopo.devices.some((d) => d.id === pingForm.src && d.kind !== 'switch')) setPingForm(defaultPing(curTopo));
  }, [curTopo]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (text: string, kind: 'info' | 'warn' | 'err' = 'info') => setNotice({ kind, text });

  const rebuild = useCallback((t: Topology, m: ViewMode, o: SimOptions, note?: string) => {
    const f = createTimeline(t, simModeOf(m), o);
    setFrames(f);
    // Static routing has no protocol to watch: open on the installed routes. Dynamic modes start at time 0.
    setCursor(startCursor(m, f));
    setPlaying(false);
    setRun(null);
    if (note) flash(note, 'warn');
  }, []);

  // ------------------------------------------------------------ undo / redo (configuration and notes)

  const remember = () => {
    undoStack.current.push({ topo: applyPositions(topo, pos), notes: structuredClone(notes) });
    if (undoStack.current.length > 60) undoStack.current.shift();
    redoStack.current = [];
    setDirty(true);
    setHistoryTick((n) => n + 1);
  };
  const restore = (from: React.MutableRefObject<Snapshot[]>, to: React.MutableRefObject<Snapshot[]>, verb: string) => {
    const snap = from.current.pop();
    if (!snap) return;
    to.current.push({ topo: applyPositions(topo, pos), notes: structuredClone(notes) });
    setTopo(snap.topo);
    setNotes(snap.notes);
    setPos({});
    setSel(null);
    rebuild(snap.topo, mode, options, `${verb}. The simulation restarted from time 0 with the restored configuration.`);
    setDirty(true);
    setHistoryTick((n) => n + 1);
  };
  const undo = () => restore(undoStack, redoStack, 'Undone');
  const redo = () => restore(redoStack, undoStack, 'Redone');

  // ------------------------------------------------------------ edits

  const structural = (t: Topology, desc: string) => {
    remember();
    setTopo(t);
    rebuild(t, mode, options, `${desc}. The configuration changed, so the simulation restarted from time 0 with a new event sequence.`);
  };

  const onLink = (linkId: string, patch: Partial<Pick<Link, 'up' | 'cost'>>) => {
    const base = mode === 'compare' ? topo : state.topo;
    const t = structuredClone(base);
    const l = t.links.find((x) => x.id === linkId);
    if (!l) return;
    remember();
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
    remember();
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
    if (s.kind === 'note') {
      remember();
      setNotes(notes.filter((n) => n.id !== s.id));
      setSel(null);
      return;
    }
    const t = s.kind === 'device' ? removeDevice(applyPositions(curTopo, pos), s.id) : removeLink(applyPositions(curTopo, pos), s.id);
    setSel(null);
    structural(t, s.kind === 'device' ? `Deleted ${deviceName(curTopo, s.id)}` : 'Deleted a link');
  };

  const addNote = (x: number, y: number) => {
    remember();
    const n: Note = { id: `note-${newId().slice(0, 8)}`, x: Math.round(x), y: Math.round(y), w: 220, h: 120, title: 'Note', text: 'Double-click to edit.\n- Use **bold** and bullets', shade: 'light' };
    setNotes([...notes, n]);
    setSel({ kind: 'note', id: n.id });
    setDetailsTab('inspect');
    setTool('select');
  };

  const onBackground = (x: number, y: number) => {
    if (tool === 'router' || tool === 'pc' || tool === 'switch') {
      const sx = snap ? Math.round(x / GRID) * GRID : Math.round(x);
      const sy = snap ? Math.round(y / GRID) * GRID : Math.round(y);
      const r = addDevice(applyPositions(curTopo, pos), tool, sx, sy);
      setSel({ kind: 'device', id: r.id });
      structural(r.topo, `Added ${deviceName(r.topo, r.id)}`);
      return;
    }
    if (tool === 'note') return addNote(x, y);
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
    setDetailsTab('inspect');
  };

  const onSelect = (s: Sel) => {
    if (tool === 'delete' && s) return onDelete(s);
    setSel(s);
    if (s) setDetailsTab('inspect');
  };

  const onMove = (id: string, x: number, y: number, done: boolean) => {
    if (!gestureSnap.current) {
      remember();
      gestureSnap.current = true;
    }
    const px = snap && done ? Math.round(x / GRID) * GRID : x;
    const py = snap && done ? Math.round(y / GRID) * GRID : y;
    setPos((p) => ({ ...p, [id]: { x: px, y: py } }));
    if (done) gestureSnap.current = false;
  };

  const onNoteChange = (n: Note, done: boolean) => {
    if (!gestureSnap.current) {
      remember();
      gestureSnap.current = true;
    }
    const snapped = done && snap ? { ...n, x: Math.round(n.x / GRID) * GRID, y: Math.round(n.y / GRID) * GRID } : n;
    setNotes((all) => all.map((x) => (x.id === n.id ? snapped : x)));
    if (done) gestureSnap.current = false;
  };

  const editNote = (n: Note) => {
    remember();
    setNotes((all) => all.map((x) => (x.id === n.id ? n : x)));
  };

  // ------------------------------------------------------------ labs: new / open / save / import / share

  /** Load a complete lab into the workspace. */
  const loadLab = (lab: Lab, info: Partial<LabInfo> = {}, msg?: string) => {
    setTopo(lab.topo);
    setNotes(lab.notes);
    setMode(lab.mode);
    setOptions(mergeOptions(lab.options));
    setLevel(lab.level);
    setPos({});
    setSel(null);
    setScenarioId(lab.scenario ?? null);
    setPredicted(null);
    setLabInfo({ id: lab.id, name: lab.name, createdAt: lab.createdAt, inLibrary: !!library.load(lab.id), exercise: lab.exercise, ...info });
    setDirty(false);
    undoStack.current = [];
    redoStack.current = [];
    const f = createTimeline(lab.topo, simModeOf(lab.mode), mergeOptions(lab.options));
    setFrames(f);
    const c = typeof lab.sim?.cursor === 'number' ? clamp(lab.sim.cursor, 0, f.length - 1) : startCursor(lab.mode, f);
    setCursor(c);
    setPlaying(false);
    setRun(null);
    setPingForm(defaultPing(lab.topo));
    setView(fitView(lab.topo, {}, lab.notes));
    const same = !lab.sim?.tables || JSON.stringify(f[c].state.tables) === JSON.stringify(lab.sim.tables);
    flash(`${msg ?? `Opened "${lab.name}".`}${same ? '' : ' Routing tables were recalculated from the saved configuration (the saved snapshot was taken mid-change).'}`);
  };

  /** Before replacing the work in progress, keep a copy in the library if it has unsaved changes. */
  const keepCurrentWork = (): string => {
    if (!dirty || topo.devices.length === 0) return '';
    try {
      const lab = currentLab();
      const copy = labInfo.inLibrary ? lab : { ...lab, name: `${lab.name} (autosaved ${new Date().toLocaleString()})` };
      library.save(copy);
      return ` Your previous work was kept in Open Lab as "${copy.name}".`;
    } catch {
      return '';
    }
  };

  const newLab = (kind: string) => {
    const t = kind === 'three' ? threeRouter() : kind === 'five' ? fiveRouter() : kind === 'triangle' ? triangle() : kind === 'switch' ? switchedLan() : kind === 'loopback' ? loopbackLine() : { devices: [], links: [] };
    const kept = keepCurrentWork();
    const now = new Date().toISOString();
    loadLab(
      { format: LAB_FORMAT, version: LAB_VERSION, id: newId(), name: 'New lab', createdAt: now, updatedAt: now, topo: t, notes: [], mode: mode === 'compare' ? 'static' : mode, options, level },
      { inLibrary: false },
      `New lab created.${kind === 'empty' ? ' Use the device tools on the left to build a network.' : ''}${kept}`,
    );
    setScenarioId(null);
  };

  const saveToLibrary = (name?: string) => {
    try {
      const lab = { ...currentLab(), name: name ?? labInfo.name };
      library.save(lab);
      setLabInfo({ ...labInfo, name: lab.name, inLibrary: true });
      setDirty(false);
      flash(`Saved "${lab.name}" in this browser. Use Export Lab or Share Lab to move it to another computer.`);
    } catch (e) {
      flash(`Could not save: ${(e as Error).message}`, 'err');
    }
  };
  const saveLab = () => (labInfo.inLibrary ? saveToLibrary() : setDialog('save'));

  const importFile = async (file: File) => {
    const r = parseLabText(await file.text(), file.name.replace(/\.(rvlab\.)?json$/i, ''));
    if (!r.ok) return flash(`Could not open ${file.name}: ${r.errors.slice(0, 3).join(' ')}`, 'err');
    const kept = keepCurrentWork();
    setDialog(null);
    loadLab({ ...r.lab, id: newId() }, { inLibrary: false }, `Imported "${r.lab.name}" from ${file.name}${r.migratedFrom ? ` (converted from the version ${r.migratedFrom} format)` : ''}. Use Save Lab to keep it in this browser.${kept}`);
  };

  const resetExercise = () => {
    const ex = labInfo.exercise;
    if (!ex) return;
    remember();
    const core: LabCore = coreOf(ex.original);
    setTopo(core.topo);
    setNotes(core.notes);
    setMode(core.mode);
    setOptions(mergeOptions(core.options));
    setLevel(core.level);
    setPos({});
    setSel(null);
    rebuild(core.topo, core.mode, mergeOptions(core.options), 'Lab reset to the original exercise configuration.');
  };

  // Open a lab shared by link (#lab=...): on start-up, or when a link is pasted into an open tab.
  useEffect(() => {
    const check = () => {
      const code = labCodeFromHash(location.hash);
      if (!code) return;
      decodeLab(code).then((r) => {
        history.replaceState(null, '', location.pathname + location.search);
        if (!r.ok) return flash(`Could not open the shared lab: ${r.errors.join(' ')}`, 'err');
        setDialog({ shared: r.lab });
      });
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------ scenarios

  const loadScenario = (sc: Scenario) => {
    const t = sc.topology();
    const o = mergeOptions({ dv: { ...DEFAULT_OPTIONS.dv, ...(sc.dv ?? {}) } });
    remember();
    setTopo(t);
    setNotes([]);
    setMode(sc.mode);
    setOptions(o);
    setLevel(sc.level);
    setPos({});
    setScenarioId(sc.id);
    setPredicted(null);
    setUngated(false);
    setSel(sc.select ? { kind: 'device', id: sc.select } : null);
    setSelectedKey(null);
    setView(DEFAULT_VIEW);
    setDetailsTab('scenario');
    if (sc.ping) setPingForm({ src: sc.ping[0], srcIp: '', dstIp: t.devices.find((d) => d.id === sc.ping![1])?.ifaces[0]?.ip ?? '' });
    else setPingForm(defaultPing(t));
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

  // ------------------------------------------------------------ ping runs

  const pingLabel = (n: number, total: number) => (total === Infinity ? `Ping ${n}` : total === 1 ? 'Ping' : `Ping ${n} of ${total}`);
  const dstText = (f: PingForm) => {
    const d = curTopo.devices.find((x) => x.ifaces.some((i) => i.ip === f.dstIp));
    return d ? `${d.name} (${f.dstIp})` : f.dstIp;
  };

  /** Insert the next ping of the run right after frame `at`, using the routing tables (and learned ARP/MAC entries) at that moment. */
  const sendNextPing = (r: PingRun, at: number, base: Frame[] = frames) => {
    const { frames: pf, result } = buildPingFrames(base[at].state, { src: r.form.src, srcIp: r.form.srcIp || undefined, dstIp: r.form.dstIp, seq: r.sent + 1 }, pingLabel(r.sent + 1, r.total));
    const next: PingRun = { ...r, sent: r.sent + 1, received: r.received + (result.success ? 1 : 0), endIndex: at + pf.length, waitAt: null };
    setFrames(insertFrames(base, at, pf));
    setRun(next);
    setLastStats({ sent: next.sent, received: next.received });
    setCursor(at + 1);
  };

  const runPing = () => {
    if (!pingForm.src || !pingForm.dstIp) return flash('Choose a source device and a destination address.', 'err');
    const r: PingRun = { form: pingForm, total: pingCount === 0 ? Infinity : pingCount, sent: 0, received: 0, endIndex: cursor, waitAt: null };
    sendNextPing(r, cursor);
    setPlaying(!oneAtATime);
  };

  /** End the run (Stop, or after the last ping) with a statistics event after the last ping. */
  const finishPing = (r: PingRun, target?: number) => {
    const stats = pingStatsFrame(frames[r.endIndex].state, deviceName(curTopo, r.form.src), dstText(r.form), r.sent, r.received);
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

  const undoRef = useRef(undo);
  undoRef.current = undo;
  const redoRef = useRef(redo);
  redoRef.current = redo;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || (e.target as HTMLElement).isContentEditable;
      if (e.key === 'Escape') { setMaxed(null); setPresenting(false); }
      if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redoRef.current(); else undoRef.current(); return; }
      if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redoRef.current(); return; }
      if (typing || (e.target as HTMLElement).getAttribute('role') === 'separator' || mode === 'compare') return;
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
  const gated = teacher.on && teacher.gate && !!scenario && predicted === null && !ungated;
  const ctx = { frames, cursor, state, topo: curTopo, selected: selRouter };
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const selNote = sel?.kind === 'note' ? notes.find((n) => n.id === sel.id) : undefined;

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

  const zoomBy = (f: number) => {
    const k = clamp(view.k * f, 0.3, 3);
    const cx = VIEW_W / 2;
    const cy = VIEW_H / 2;
    setView({ k, x: cx - ((cx - view.x) * k) / view.k, y: cy - ((cy - view.y) * k) / view.k });
  };

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

  const TOOLS: [Tool, string, string, string][] = [
    ['select', '↖', 'Select', 'Select, move and pan'],
    ['router', 'R', 'Router', 'Router'],
    ['pc', 'PC', 'PC', 'PC'],
    ['switch', 'SW', 'Switch', 'Unmanaged Layer 2 switch'],
    ['link', '⟷', 'Link', 'Connection tool: Ethernet link'],
    ['note', '✎', 'Note', 'Note: click the canvas to add one'],
    ['delete', '🗑', 'Delete', 'Delete devices, links or notes'],
  ];

  const canvasSection = (
    <section className="card canvas-wrap panel" aria-label="Network canvas">
      <div className="toolbar" role="toolbar" aria-label="Canvas options">
        <label className="small"><input type="checkbox" checked={showAddr} onChange={(e) => setShowAddr(e.target.checked)} /> Addresses</label>
        <label className="small"><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Grid</label>
        <label className="small"><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Snap</label>
        <label className="small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow events</label>
        <span className="zoom-group" role="group" aria-label="Zoom">
          <button className="btn small icon" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out" title="Zoom out">−</button>
          <span className="small zoom-pct">{Math.round(view.k * 100)}%</span>
          <button className="btn small icon" onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in">+</button>
          <button className="btn small" onClick={() => setView(fitView(curTopo, pos, notes))} title="Fit the whole network on screen">Fit</button>
        </span>
        <span className="hint">{tool === 'router' || tool === 'pc' || tool === 'switch' ? 'Click empty space to place it.' : tool === 'note' ? 'Click where the note should go.' : tool === 'link' ? (pendingLink ? 'Click the second device.' : 'Click the first device.') : tool === 'delete' ? 'Click a device, link or note to delete it.' : 'Drag devices · drag empty space to pan · Ctrl+scroll to zoom'}</span>
        {!presenting && (
          <PanelButtons id="canvas" maxed={maxed} onMax={setMaxed} {...mv}
            extra={<button className="btn small" onClick={startPresenting} title="Full-screen topology for classroom presentation">⛶ Present</button>} />
        )}
      </div>
      <div className="canvas-body">
        <div className="tool-palette" role="toolbar" aria-label="Network devices and tools" aria-orientation="vertical">
          {TOOLS.map(([t, icon, short, label]) => (
            <button key={t} className="tool-btn" aria-pressed={tool === t} onClick={() => { setTool(t); setPendingLink(null); }} title={label} aria-label={label}>
              <span className="tool-icon" aria-hidden>{icon}</span>
              <span className="tool-label">{short}</span>
            </button>
          ))}
        </div>
        <div className="canvas-area">
          <Canvas
            topo={curTopo} pos={pos} notes={notes} mode={mode} options={options} selected={sel} tool={tool} pendingLinkFrom={pendingLink}
            anim={mode === 'compare' ? undefined : frame.ev.anim} animKey={cursor} duration={Math.min(1200, interval * 0.75)} reducedMotion={reducedMotion}
            routePath={routePath} sptPath={sptPath} focus={mode === 'compare' ? [] : frame.ev.routers ?? []} showAddresses={showAddr} showGrid={showGrid}
            view={view} onView={setView}
            onSelect={onSelect} onBackground={onBackground} onDevice={onDevice} onMove={onMove}
            onNoteChange={onNoteChange}
            onNoteOpen={(id) => { setSel({ kind: 'note', id }); setDetailsTab('inspect'); if (layout.detailsCollapsed) patchLayout({ detailsCollapsed: false }); setTimeout(() => (document.getElementById('note-text') as HTMLTextAreaElement | null)?.focus(), 50); }}
            onPacketClick={() => { setPlaying(false); setDetailsTab('packet'); if (layout.detailsCollapsed) patchLayout({ detailsCollapsed: false }); }}
          />
        </div>
      </div>
    </section>
  );

  const simSection = (
    <section className="panel plain" aria-label={mode === 'compare' ? 'Comparison' : 'Simulation controls and explanation'}>
      <PanelBar title={mode === 'compare' ? 'Comparison' : 'Simulation controls'}>
        <PanelButtons id="sim" maxed={maxed} onMax={setMaxed} {...mv} />
      </PanelBar>
      <div className="panel-body">
        {mode === 'compare' ? (
          <ComparePanel topo={applyPositions(topo, pos)} options={options} />
        ) : (
          <>
            <section className="card stack" aria-label="Simulation and ping controls">
              {controls}
              <PingTool topo={curTopo} form={pingForm} setForm={setPingForm} count={pingCount} setCount={setPingCount} running={run}
                onRun={runPing} onStop={() => { if (run) { setPlaying(false); finishPing(run, cursor); } }} stats={lastStats} />
              <div className="row">
                <button className="btn small" onClick={() => { setFrames(clearL2(frames, cursor)); setCursor(cursor + 1); setRun(null); }} title="Empty every ARP cache and switch MAC table">Clear ARP &amp; MAC tables</button>
                <span className="small muted">Learned so far: {Object.values(state.l2.arp).reduce((n, t) => n + Object.keys(t).length, 0)} ARP entries, {Object.values(state.l2.mac).reduce((n, t) => n + t.length, 0)} MAC table entries.</span>
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

  const showScenarioTab = !!scenario && (scenario.mode === 'compare') === (mode === 'compare');
  const tabs: [DetailsTab, string][] = mode === 'compare'
    ? [['inspect', 'About'], ...(showScenarioTab ? ([['scenario', 'Scenario']] as [DetailsTab, string][]) : [])]
    : [['inspect', selNote ? 'Note' : 'Inspector'], ['packet', 'Packet'], ...(showScenarioTab ? ([['scenario', 'Scenario']] as [DetailsTab, string][]) : []), ['settings', 'Settings']];
  const activeTab = tabs.some(([t]) => t === detailsTab) ? detailsTab : 'inspect';
  const detailsCollapsed = layout.detailsCollapsed && maxed !== 'details' && mode !== 'compare';
  const detailsSection = (
    <section className="panel plain" aria-label="Inspector">
      <PanelBar title="Inspector">
        <PanelButtons id="details" maxed={maxed} onMax={setMaxed} {...mv} collapsed={detailsCollapsed} onCollapse={mode === 'compare' ? undefined : () => patchLayout({ detailsCollapsed: !layout.detailsCollapsed })} />
      </PanelBar>
      {!detailsCollapsed && (
        <>
          <div className="tabs details-tabs" role="tablist" aria-label="Inspector sections">
            {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={activeTab === k} onClick={() => setDetailsTab(k)}>{l}{k === 'packet' && frame.ev.packet ? ' •' : ''}</button>)}
          </div>
          <div className="panel-body">
            {activeTab === 'scenario' && scenario && (
              <ScenarioPanel sc={scenario} ctx={ctx} predicted={predicted} onPredict={setPredicted} onReset={() => loadScenario(scenario)} onQuick={quickAction} teacher={teacher.on && teacher.gate} />
            )}
            {activeTab === 'settings' && mode !== 'compare' && (
              <SettingsPanel mode={mode} options={options} level={level} topo={state.topo} onOptions={(o) => { setOptions(o); setDirty(true); rebuild(topo, mode, o, 'Protocol settings changed: the simulation restarted from time 0.'); }} />
            )}
            {activeTab === 'packet' && mode !== 'compare' && <PacketInspector frames={frames} cursor={cursor} onJump={(i) => { setPlaying(false); if (run) finishPing(run, i); else setCursor(i); }} />}
            {activeTab === 'inspect' && selNote && (
              <NotePanel note={selNote} topo={curTopo} onChange={editNote}
                onDuplicate={() => { remember(); const c = { ...selNote, id: `note-${newId().slice(0, 8)}`, x: selNote.x + 24, y: selNote.y + 24, locked: undefined }; setNotes([...notes, c]); setSel({ kind: 'note', id: c.id }); }}
                onDelete={() => onDelete({ kind: 'note', id: selNote.id })} />
            )}
            {activeTab === 'inspect' && !selNote && mode !== 'compare' && (
              <Inspector
                state={state} frames={frames} cursor={cursor} level={level} options={options} sel={sel} hideValues={teacher.on && teacher.hideValues}
                changes={frame.ev.changes ?? []} pingHop={frame.ev.ping} selectedKey={selectedKey} onSelectKey={setSelectedKey}
                onStructural={structural} onLink={onLink} onStatic={onStatic} onDelete={onDelete}
              />
            )}
            {activeTab === 'inspect' && !selNote && mode === 'compare' && (
              <section className="card">
                <h2>How to read the comparison</h2>
                <p className="small">Each column is a real simulation of the same topology. Static routing uses whatever static routes are configured (switch to Static mode to edit them). Pick a link to fail and compare how each approach responds, and whether a person has to fix anything.</p>
              </section>
            )}
          </div>
        </>
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
    setDirty(true);
    rebuild(topo, m, options);
  };

  const themeLabel = theme === 'system' ? 'Auto' : theme === 'light' ? 'Light' : 'Dark';
  const exercise = labInfo.exercise;

  return (
    <div className={`app ${wide && !presenting ? 'app-wide' : ''} ${presenting ? 'app-present' : ''}`}>
      {!presenting && <header className="topbar">
        <div className="brand">
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2"><circle cx="5" cy="12" r="3" /><circle cx="19" cy="5" r="3" /><circle cx="19" cy="19" r="3" /><path d="M8 11 16 6M8 13l8 5" /></svg>
          <span>Routing Visual Lab</span>
        </div>
        <div className="lab-name" title={labInfo.inLibrary ? 'Saved in this browser' : 'Not saved in the library yet'}>
          <span className="small muted">Lab</span> <strong>{labInfo.name}</strong>{dirty && <span className="dirty" aria-label="unsaved changes"> •</span>}
          {exercise?.studentMode && <span className="pill">student exercise</span>}
        </div>
        <div className="group lab-actions" role="toolbar" aria-label="Lab">
          <select aria-label="New lab" value="" onChange={(e) => e.target.value && newLab(e.target.value)} title="Start a new lab">
            <option value="">＋ New Lab…</option>
            <option value="three">3 routers (simple)</option>
            <option value="five">5 routers (alternative paths)</option>
            <option value="triangle">Triangle (weighted)</option>
            <option value="switch">Switched LAN (2 routers, switch, 3 PCs)</option>
            <option value="loopback">R1–R2–R3 with loopbacks</option>
            <option value="empty">Empty canvas</option>
          </select>
          <button className="btn" onClick={() => setDialog('open')} title="Open a saved lab or import a lab file">📂 Open Lab</button>
          <button className="btn" onClick={saveLab} title="Save this lab in this browser">💾 Save Lab</button>
          <button className="btn" onClick={() => setDialog('share')} title="Share with students: lab file, link or QR code">⇪ Share Lab</button>
          <button className="btn" onClick={() => fileRef.current?.click()} title="Import a lab file (.json)">⬆ Import</button>
          <button className="btn" onClick={() => downloadLab(currentLab())} title="Export this lab as a JSON file">⬇ Export</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }} />
          <button className="btn icon" onClick={undo} disabled={!undoStack.current.length} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
          <button className="btn icon" onClick={redo} disabled={!redoStack.current.length} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
          <button className="btn" onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')} title="Theme: automatic, light or dark" aria-label={`Theme: ${themeLabel}. Click to change.`}>◐ {themeLabel}</button>
        </div>
        <div className="break" />
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
        <button className="btn menu-toggle" aria-expanded={menuOpen} aria-controls="topbar-tools" onClick={() => setMenuOpen(!menuOpen)}>☰ Menu</button>
        <div className={`group ${menuOpen ? 'open' : ''}`} id="topbar-tools">
          <button className="btn" aria-pressed={teacher.on} onClick={() => setTeacher({ ...teacher, on: !teacher.on })}>🎓 Teacher</button>
          <button className="btn" aria-pressed={large} onClick={() => setLarge(!large)} title="Enlarge labels and tables for projection">⛶ Projector</button>
          <button className="btn" aria-pressed={reducedMotion} onClick={() => setReducedMotion(!reducedMotion)} title="Turn packet movement on or off">Reduce motion</button>
          <button className="btn" onClick={() => { resetLayout(); setMaxed(null); }} title="Restore the default panel sizes">▦ Reset layout</button>
          <button className="btn" onClick={() => setShowAssumptions(true)}>ⓘ Model assumptions</button>
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

      {exercise && !presenting && (
        <div className="card exercise-bar" role="region" aria-label="Student exercise">
          <div className="row">
            <strong>📝 Exercise{exercise.studentMode ? ' (Student Exercise Mode)' : ''}</strong>
            {exercise.instructions && <span className="grow">{exercise.instructions}</span>}
            <button className="btn small" onClick={() => setDialog('check')}>✔ Check connectivity</button>
            <button className="btn small" onClick={resetExercise} title="Restore the configuration exactly as it was shared">↺ Reset Lab</button>
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
      {dialog === 'open' && <OpenLabDialog library={library} currentId={labInfo.id} onClose={() => setDialog(null)} onImport={importFile}
        onOpen={(lab) => { const kept = lab.id === labInfo.id ? '' : keepCurrentWork(); setDialog(null); loadLab(lab, { inLibrary: true }, `Opened "${lab.name}".${kept}`); }} />}
      {dialog === 'share' && <ShareDialog lab={currentLab()} onClose={() => setDialog(null)} />}
      {dialog === 'save' && <NameDialog title="Save lab" initial={labInfo.name === 'My lab' || labInfo.name === 'New lab' ? '' : labInfo.name} action="Save" onClose={() => setDialog(null)} onSubmit={(name) => { setDialog(null); saveToLibrary(name); }} />}
      {dialog === 'check' && <ConnectivityCheck state={state} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === 'object' && (
        <div className="modal-back" role="dialog" aria-modal="true" aria-label="Open shared lab">
          <div className="modal">
            <h2>Open shared lab?</h2>
            <p>Someone shared <strong>{dialog.shared.name}</strong> with you ({dialog.shared.topo.devices.length} devices, {dialog.shared.notes.length} notes{dialog.shared.exercise?.studentMode ? ', Student Exercise Mode' : ''}).</p>
            {dialog.shared.exercise?.instructions && <p className="banner info">{dialog.shared.exercise.instructions}</p>}
            <p className="small muted">It opens as your own copy. {dirty ? 'Your current work will be kept in Open Lab.' : ''}</p>
            <div className="row">
              <button className="btn primary" autoFocus onClick={() => { const kept = keepCurrentWork(); const lab = { ...dialog.shared, id: newId() }; setDialog(null); loadLab(lab, { inLibrary: false }, `Opened the shared lab "${lab.name}". Use Save Lab to keep it in this browser.${kept}`); }}>Open shared lab</button>
              <button className="btn" onClick={() => setDialog(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

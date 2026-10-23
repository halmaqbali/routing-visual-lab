import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_OPTIONS, type Level, type Link, type Mode, type SimOptions, type Topology } from '../model/types';
import { fiveRouter, loopbackLine, ospfLan, switchedLan, threeRouter, triangle } from '../model/samples';
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
import { Timeline } from './Timeline';
import { Assumptions, ComparePanel, Legend, ScenarioPanel, SettingsPanel } from './Panels';
import { clamp, DEFAULT_LAYOUT, MIN, Splitter, useElementSize, useLayoutPrefs, useMediaQuery } from './Layout';
import { Icon, MenuButton, PingPopover, type MenuItem } from './Shell';
import { PacketInspector } from './PacketInspector';
import { ConnectivityCheck, downloadLab, NameDialog, OpenLabDialog, ShareDialog } from './LabDialogs';
import { addressList, NotePanel, type PingForm } from './Tools';

type ViewMode = Mode | 'compare';
/** A ping in progress: pings are sent one at a time, as the timeline reaches each one. */
interface PingRun { form: PingForm; total: number; sent: number; received: number; endIndex: number; waitAt: number | null; lastOk?: boolean }
interface Teacher { on: boolean; gate: boolean; oneAtATime: boolean; hideValues: boolean }
interface LabInfo { id: string; name: string; createdAt: string; inLibrary: boolean; exercise?: Lab['exercise'] }
interface Snapshot { topo: Topology; notes: Note[] }
type DetailsTab = 'inspect' | 'packet' | 'scenario' | 'settings';
type MobileTab = 'step' | 'device' | 'packet' | 'lesson' | 'steps' | 'settings';

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
  const [presenting, setPresenting] = useState(false);
  const [pingOpen, setPingOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>('step');
  const shellEl = useRef<HTMLDivElement | null>(null);
  const [shellRef, shellSize] = useElementSize<HTMLDivElement>();
  const setShell = useCallback((el: HTMLDivElement | null) => { shellRef(el); shellEl.current = el; }, [shellRef]);

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

  // Informational messages fade out on their own; warnings and errors stay until dismissed.
  useEffect(() => {
    if (notice?.kind !== 'info') return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

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
    const t = kind === 'three' ? threeRouter() : kind === 'five' ? fiveRouter() : kind === 'triangle' ? triangle() : kind === 'switch' ? switchedLan() : kind === 'loopback' ? loopbackLine() : kind === 'ospflan' ? ospfLan() : { devices: [], links: [] };
    const kept = keepCurrentWork();
    const now = new Date().toISOString();
    loadLab(
      { format: LAB_FORMAT, version: LAB_VERSION, id: newId(), name: 'New lab', createdAt: now, updatedAt: now, topo: t, notes: [], mode: mode === 'compare' ? 'static' : mode, options, level },
      { inLibrary: false },
      `New lab created.${kind === 'empty' ? ' Use the device tools on the left to build a network.' : ''}${kept}`,
    );
    setScenarioId(null);
  };

  /** Start fresh: the default 3-router lab with every setting back to its default. Saved labs are kept. */
  const startFresh = () => {
    if (!confirm('Start fresh? This loads the default 3-router lab and resets every setting (mode, simulation options, theme, view, panels, ping). Labs saved in Open Lab are kept.')) return;
    const kept = keepCurrentWork();
    const now = new Date().toISOString();
    loadLab(
      { format: LAB_FORMAT, version: LAB_VERSION, id: newId(), name: 'My lab', createdAt: now, updatedAt: now, topo: threeRouter(), notes: [], mode: 'static', options: mergeOptions(), level: 'beginner' },
      { inLibrary: false, exercise: undefined },
      `Started fresh: default lab and settings.${kept}`,
    );
    setScenarioId(null);
    setUngated(false);
    setSelectedKey(null);
    setTool('select');
    setPendingLink(null);
    setSpeed(1);
    setPingCount(3);
    setLastStats(null);
    setTeacher({ on: false, gate: true, oneAtATime: false, hideValues: false });
    setLarge(false);
    setFollow(true);
    setShowAddr(true);
    setShowGrid(true);
    setSnap(true);
    setReducedMotion(typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    setTheme('system');
    resetLayout();
    setDetailsTab('inspect');
    setMobileTab('step');
    setStepsOpen(false);
    setPingOpen(false);
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
    const next: PingRun = { ...r, sent: r.sent + 1, received: r.received + (result.success ? 1 : 0), endIndex: at + pf.length, waitAt: null, lastOk: result.success };
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

  // ------------------------------------------------------------ keyboard

  const undoRef = useRef(undo);
  undoRef.current = undo;
  const redoRef = useRef(redo);
  redoRef.current = redo;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || (e.target as HTMLElement).isContentEditable;
      if (e.key === 'Escape') { setPresenting(false); setStepsOpen(false); }
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
    // Draw router-to-router; a transit LAN in between is skipped (the arrow crosses the switch).
    return Object.entries(spf.pred)
      .filter(([n, p]) => p && confirmed.has(n) && !n.startsWith('net:'))
      .map(([n, p]) => ({ linkId: p!.linkId, from: p!.node.startsWith('net:') ? spf.pred[p!.node]?.node ?? p!.node : p!.node, to: n }))
      .filter((d) => !d.from.startsWith('net:'));
  }, [state, selRouter, mode]);
  const gated = teacher.on && teacher.gate && !!scenario && predicted === null && !ungated;
  const ctx = { frames, cursor, state, topo: curTopo, selected: selRouter };
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const selNote = sel?.kind === 'note' ? notes.find((n) => n.id === sel.id) : undefined;

  // ------------------------------------------------------------ layout (redesign: header · tool rail · stage · inspector)

  const sidebarMax = Math.max(MIN.sidebar, shellSize.w - 64 - MIN.left);
  const sidebarW = clamp(layout.sidebar, MIN.sidebar, shellSize.w ? sidebarMax : layout.sidebar);
  const setVar = (name: string, v: number) => shellEl.current?.style.setProperty(name, `${v}px`);

  const zoomBy = (f: number) => {
    const k = clamp(view.k * f, 0.3, 3);
    const cx = VIEW_W / 2;
    const cy = VIEW_H / 2;
    setView({ k, x: cx - ((cx - view.x) * k) / view.k, y: cy - ((cy - view.y) * k) / view.k });
  };

  const jump = (i: number) => { setPlaying(false); if (run) finishPing(run, i); else setCursor(i); };
  const clearL2Now = () => { setFrames(clearL2(frames, cursor)); setCursor(cursor + 1); setRun(null); flash('ARP caches and switch MAC tables were cleared. The next ping will use ARP and flooding again.'); };
  const l2Text = `Learned so far: ${Object.values(state.l2.arp).reduce((n, t) => n + Object.keys(t).length, 0)} ARP entries, ${Object.values(state.l2.mac).reduce((n, t) => n + t.length, 0)} MAC table entries.`;
  const openTab = (t: DetailsTab) => {
    setDetailsTab(t);
    setMobileTab(t === 'inspect' ? 'device' : t === 'packet' ? 'packet' : t === 'scenario' ? 'lesson' : 'settings');
    if (layout.detailsCollapsed) patchLayout({ detailsCollapsed: false });
  };

  const TOOLS: [Tool, string, string, string][] = [
    ['select', 'select', 'Select', 'Select, move and pan'],
    ['router', 'router', 'Router', 'Add a router'],
    ['pc', 'pc', 'PC', 'Add a PC'],
    ['switch', 'switch', 'Switch', 'Add an unmanaged switch'],
    ['link', 'cable', 'Cable', 'Connect two devices with a cable'],
    ['note', 'note', 'Note', 'Add a note: click the canvas'],
  ];

  const toolHint = tool === 'router' || tool === 'pc' || tool === 'switch' ? 'Click an empty spot to place it' : tool === 'note' ? 'Click where the note should go' : tool === 'link' ? (pendingLink ? 'Now click the second device' : 'Click the first device') : tool === 'delete' ? 'Click a device, cable or note to delete it' : '';

  const rail = (
    <nav className={`rail ${wide ? '' : 'rail-h'}`} aria-label="Tools">
      {TOOLS.map(([t, icon, short, label]) => (
        <button key={t} className="rail-btn" aria-pressed={tool === t} title={label} aria-label={label} onClick={() => { setTool(t); setPendingLink(null); }}>
          <Icon name={icon} size={20} /><span>{short}</span>
        </button>
      ))}
      <div className="rail-sep" />
      <button className="rail-btn small" onClick={undo} disabled={!undoStack.current.length} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
      <button className="rail-btn small" onClick={redo} disabled={!redoStack.current.length} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon name="redo" /></button>
      <div className="rail-grow" />
      <button className="rail-btn" aria-pressed={tool === 'delete'} title="Delete: click a device, cable or note" aria-label="Delete tool" onClick={() => { if (sel && tool === 'select') onDelete(sel); else { setTool('delete'); setPendingLink(null); } }}>
        <Icon name="trash" size={20} /><span>Delete</span>
      </button>
    </nav>
  );

  const ev = frame.ev;
  // Only count pings whose animation has finished, so the counter never gives away the current ping's result.
  const inFlight = !!run && run.waitAt === null && cursor <= run.endIndex;
  const done = run ? { sent: run.sent - (inFlight ? 1 : 0), received: run.received - (inFlight && run.lastOk ? 1 : 0) } : { sent: 0, received: 0 };
  const CAT_LABEL: Record<string, string> = { config: 'Configuration', control: 'Routing update', lsa: 'Link-state message', spf: 'Shortest-path calculation', data: 'Data packet', info: 'Information' };
  const stepCard = (
    <section className={`step-card ${wide ? '' : 'flat'}`} aria-label="Current step">
      <div className="step-meta">
        <span className={`cat-tag ${ev.category}`}>{ev.category === 'data' && <Icon name="ping" size={13} />}{CAT_LABEL[ev.category]}</span>
        <span className="muted">Step {cursor + 1} of {frames.length} · t = {ev.time}</span>
        {run && <span className="run-badge">{run.total === Infinity ? '∞ Continuous ping' : 'Ping'} {run.sent}{run.total !== Infinity ? ` of ${run.total}` : ''}{done.sent > 0 ? ` · ${done.sent} done · ${done.received} replied` : ''}</span>}
        <span className="grow-1" />
        {ev.packet && <button className="link-btn" onClick={() => openTab('packet')}>Inspect packet</button>}
        {wide && <button className="link-btn" onClick={() => setStepsOpen(!stepsOpen)} aria-expanded={stepsOpen}>All {frames.length} steps</button>}
      </div>
      <h2 className="step-title" aria-live="polite">{ev.title}</h2>
      {gated ? (
        <div className="gate-inline">
          <span>Make your prediction in the Lesson tab first. The explanation is hidden in Teacher Mode until then.</span>
          <button className="link-btn" onClick={() => setUngated(true)}>Show anyway</button>
        </div>
      ) : (
        <p className={`step-text ${showDetail ? '' : 'clamp'}`}>{ev.explain}</p>
      )}
      {showDetail && !gated && (
        <div className="step-detail">
          <Explain frame={frame} index={cursor} total={frames.length} level={level} gated={false} hideValues={teacher.on && teacher.hideValues} onUngate={() => setUngated(true)} compact />
        </div>
      )}
      <div className="step-controls">
        <div className="transport">
          <button className="tbtn" onClick={() => { setPlaying(false); setCursor(Math.max(0, cursor - 1)); }} disabled={cursor <= 0} aria-label="Previous step (←)" title="Previous step (←)"><Icon name="prev" size={16} /></button>
          {playing ? (
            <button className="tbtn primary" onClick={() => setPlaying(false)} aria-label="Pause (Space)"><Icon name="pause" size={14} /> Pause</button>
          ) : (
            <button className="tbtn primary" onClick={() => setPlaying(true)} disabled={oneAtATime || !(run || cursor < frames.length - 1)} aria-label="Play (Space)" title={oneAtATime ? 'Teacher Mode: one step at a time' : 'Play (Space)'}><Icon name="play" size={14} /> Play</button>
          )}
          <button className="tbtn" onClick={() => { setPlaying(false); advance(); }} disabled={!(run || cursor < frames.length - 1)} aria-label="Next step (→)" title="Next step (→)"><Icon name="next" size={16} /></button>
        </div>
        <input className="scrub" type="range" min={0} max={Math.max(0, frames.length - 1)} value={cursor} aria-label={`Step ${cursor + 1} of ${frames.length}`}
          disabled={oneAtATime || !!run} onChange={(e) => jump(Number(e.target.value))} />
        <div className="transport-extra">
          <button className="tbtn ghost" onClick={() => { setPlaying(false); setCursor(frames.length - 1); }} disabled={cursor >= frames.length - 1 || oneAtATime || !!run} aria-label="Jump to the last step" title="Jump to the last step (End)"><Icon name="end" size={16} /></button>
          <button className="tbtn ghost" onClick={() => rebuild(topo, mode, options, 'Simulation reset to time 0 using the current configuration.')} aria-label="Restart the simulation" title="Restart from time 0"><Icon name="reset" size={16} /></button>
          <label className="speed">Speed
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {[0.25, 0.5, 1, 2, 4].map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
          </label>
          {!gated && <button className="link-btn" onClick={() => setShowDetail(!showDetail)} aria-expanded={showDetail}>{showDetail ? 'Less' : 'Details'}</button>}
        </div>
      </div>
    </section>
  );

  const lessonChipText = labInfo.exercise?.instructions ?? (scenario ? scenario.prediction.question : null);
  const stage = (
    <main className={`stage ${mode === 'compare' ? 'compare' : ''}`} aria-label="Network">
      <div className="stage-canvas dots">
        <Canvas
          topo={curTopo} pos={pos} notes={notes} mode={mode} options={options} selected={sel} tool={tool} pendingLinkFrom={pendingLink}
          anim={mode === 'compare' ? undefined : ev.anim} animKey={cursor} duration={Math.min(1200, interval * 0.75)} reducedMotion={reducedMotion}
          routePath={routePath} sptPath={sptPath} focus={mode === 'compare' ? [] : ev.routers ?? []} showAddresses={showAddr} showGrid={showGrid}
          view={view} onView={setView}
          onSelect={(s) => { onSelect(s); if (s && !wide) setMobileTab('device'); }} onBackground={onBackground} onDevice={(id) => { onDevice(id); if (tool === 'select' && !wide) setMobileTab('device'); }} onMove={onMove}
          onNoteChange={onNoteChange}
          onNoteOpen={(id) => { setSel({ kind: 'note', id }); openTab('inspect'); setTimeout(() => (document.getElementById('note-text') as HTMLTextAreaElement | null)?.focus(), 50); }}
          onPacketClick={() => { setPlaying(false); openTab('packet'); }}
        />
        <div className="overlay-top">
          {lessonChipText ? (
            <div className="lesson-chip">
              <span className="eyebrow">{labInfo.exercise ? 'Exercise' : `Lesson ${scenario?.num}`}</span>
              <span className="lesson-q">{lessonChipText}</span>
              <button className="link-btn" onClick={() => openTab('scenario')}>Open task</button>
            </div>
          ) : <span />}
          <div className="chip-group">
            {(errors.length > 0 || warnings.length > 0) && (
              <MenuButton className={`chip ${errors.length ? 'err' : 'warn'}`} ariaLabel="Configuration problems"
                items={issues.slice(0, 12).map((i) => ({ label: `${i.severity === 'error' ? '✖' : '▲'} ${i.message}` }))}>
                <Icon name="warn" size={15} /> {errors.length ? `${errors.length} error${errors.length > 1 ? 's' : ''}` : `${warnings.length} warning${warnings.length > 1 ? 's' : ''}`}
              </MenuButton>
            )}
            <button className="chip" aria-pressed={showAddr} onClick={() => setShowAddr(!showAddr)}>Addresses</button>
            <button className="chip" aria-pressed={follow} onClick={() => setFollow(!follow)} title="Select the device involved in each step">Follow</button>
            {wide && (presenting
              ? <button className="chip" onClick={stopPresenting}>Exit (Esc)</button>
              : <button className="chip" onClick={startPresenting} title="Full-screen network for the classroom"><Icon name="present" size={15} /> Present</button>)}
          </div>
        </div>
        {toolHint && <div className="tool-hint" role="status">{toolHint}</div>}
        {notice && (
          <div className={`toast ${notice.kind}`} role="status">
            <span>{notice.text}</span>
            <button className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss message"><Icon name="close" size={14} /></button>
          </div>
        )}
        <div className="zoom-ctl" role="group" aria-label="Zoom">
          <button onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in"><Icon name="plus" size={16} /></button>
          <span className="zoom-pct" aria-live="polite">{Math.round(view.k * 100)}%</span>
          <button onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out" title="Zoom out"><Icon name="minus" size={16} /></button>
          <button onClick={() => setView(fitView(curTopo, pos, notes))} aria-label="Fit network to screen" title="Fit to screen"><Icon name="fit" size={16} /></button>
        </div>
        {stepsOpen && wide && mode !== 'compare' && (
          <div className="steps-drawer">
            <Timeline frames={frames} cursor={cursor} onJump={jump} hideFuture={oneAtATime} fill
              actions={<button className="icon-btn" onClick={() => setStepsOpen(false)} aria-label="Close steps"><Icon name="close" size={16} /></button>} />
          </div>
        )}
      </div>
      {wide && mode !== 'compare' && <div className="step-dock dots">{stepCard}</div>}
      {wide && mode === 'compare' && <div className="compare-dock"><ComparePanel topo={applyPositions(topo, pos)} options={options} /></div>}
    </main>
  );

  // ---------------------------------------------------------------- inspector content

  const lessonContent = (
    <div className="stack">
      <label className="stack-label"><strong>Guided lesson</strong>
        <select value={scenarioId ?? ''} onChange={(e) => { const sc = SCENARIOS.find((s) => s.id === e.target.value); if (sc) loadScenario(sc); else setScenarioId(null); }}>
          <option value="">Free play (no lesson)</option>
          {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.num}. {s.title}</option>)}
        </select>
      </label>
      {labInfo.exercise && (
        <section className="card">
          <h2>Exercise{labInfo.exercise.studentMode ? ' (student mode)' : ''}</h2>
          {labInfo.exercise.instructions && <p>{labInfo.exercise.instructions}</p>}
          <div className="row">
            <button className="btn primary" onClick={() => setDialog('check')}>Check connectivity</button>
            <button className="btn" onClick={resetExercise} title="Restore the configuration exactly as it was shared">Reset lab</button>
          </div>
        </section>
      )}
      {scenario && (scenario.mode === 'compare') === (mode === 'compare') && (
        <ScenarioPanel sc={scenario} ctx={ctx} predicted={predicted} onPredict={setPredicted} onReset={() => loadScenario(scenario)} onQuick={quickAction} teacher={teacher.on && teacher.gate} />
      )}
      {!scenario && !labInfo.exercise && <p className="muted small">Choose a guided lesson to get an objective, a prediction question and an explanation based on what the simulation actually does.</p>}
      <section className="card">
        <div className="card-head"><h2>Teacher mode</h2>
          <button className="btn small" aria-pressed={teacher.on} onClick={() => setTeacher({ ...teacher, on: !teacher.on })}>{teacher.on ? 'On' : 'Off'}</button></div>
        {teacher.on && (
          <div className="stack small">
            <label><input type="checkbox" checked={teacher.gate} onChange={(e) => setTeacher({ ...teacher, gate: e.target.checked })} /> Hide explanations until a prediction is made</label>
            <label><input type="checkbox" checked={teacher.oneAtATime} onChange={(e) => { setTeacher({ ...teacher, oneAtATime: e.target.checked }); setPlaying(false); }} /> One step at a time (no Play, future steps hidden)</label>
            <label><input type="checkbox" checked={teacher.hideValues} onChange={(e) => setTeacher({ ...teacher, hideValues: e.target.checked })} /> Hide next hops and costs (click "?" to reveal)</label>
            {scenario && <button className="btn small" onClick={() => loadScenario(scenario)}>Reset lesson</button>}
          </div>
        )}
      </section>
    </div>
  );

  const settingsContent = (
    <div className="stack">
      <section className="card">
        <h2>Explanations</h2>
        <div className="segm" role="group" aria-label="Level">
          <button aria-pressed={level === 'beginner'} onClick={() => setLevel('beginner')}>Beginner</button>
          <button aria-pressed={level === 'advanced'} onClick={() => setLevel('advanced')}>Advanced</button>
        </div>
        <p className="small muted">Advanced adds administrative distance, MAC addresses, protocol details and extra settings.</p>
      </section>
      {mode !== 'compare' && <SettingsPanel mode={mode} options={options} level={level} topo={state.topo} onOptions={(o) => { setOptions(o); setDirty(true); rebuild(topo, mode, o, 'Protocol settings changed: the simulation restarted from time 0.'); }} />}
      <section className="card stack small">
        <h2>Display</h2>
        <label><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Grid</label>
        <label><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Snap devices to the grid</label>
        <label><input type="checkbox" checked={reducedMotion} onChange={(e) => setReducedMotion(e.target.checked)} /> Reduce motion</label>
        <label><input type="checkbox" checked={large} onChange={(e) => setLarge(e.target.checked)} /> Large text for projectors</label>
      </section>
      <Legend />
      <button className="btn" onClick={() => setShowAssumptions(true)}>Model assumptions</button>
    </div>
  );

  const deviceContent = selNote ? (
    <NotePanel note={selNote} topo={curTopo} onChange={editNote}
      onDuplicate={() => { remember(); const c = { ...selNote, id: `note-${newId().slice(0, 8)}`, x: selNote.x + 24, y: selNote.y + 24, locked: undefined }; setNotes([...notes, c]); setSel({ kind: 'note', id: c.id }); }}
      onDelete={() => onDelete({ kind: 'note', id: selNote.id })} />
  ) : mode === 'compare' ? (
    <section className="card">
      <h2>How to read the comparison</h2>
      <p className="small">Each column is a real simulation of the same network. Static routing uses the static routes you configured (switch to Static to edit them). Pick a link to fail and compare how each method responds, and whether a person has to fix anything.</p>
    </section>
  ) : (
    <Inspector
      state={state} frames={frames} cursor={cursor} level={level} options={options} sel={sel} hideValues={teacher.on && teacher.hideValues}
      changes={ev.changes ?? []} pingHop={ev.ping} selectedKey={selectedKey} onSelectKey={setSelectedKey}
      onStructural={structural} onLink={onLink} onStatic={onStatic} onDelete={onDelete}
    />
  );
  const packetContent = mode === 'compare' ? <p className="muted">Packets are shown in Static, Distance vector and Link state modes.</p> : <PacketInspector frames={frames} cursor={cursor} onJump={jump} />;

  const TABS: [DetailsTab, string][] = [['inspect', selNote ? 'Note' : 'Device'], ['packet', 'Packet'], ['scenario', 'Lesson'], ['settings', 'Settings']];
  const inspector = (
    <aside className="inspector" aria-label="Inspector">
      <div className="insp-tabs" role="tablist" aria-label="Inspector">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={detailsTab === k} onClick={() => setDetailsTab(k)}>
            {l}{k === 'packet' && ev.packet && detailsTab !== 'packet' ? <span className="dot" aria-label="(packet in this step)" /> : null}
          </button>
        ))}
        <span className="grow-1" />
        <button className="icon-btn" onClick={() => patchLayout({ detailsCollapsed: true })} aria-label="Hide inspector" title="Hide inspector"><Icon name="panel" size={18} /></button>
      </div>
      <div className="insp-body">
        {detailsTab === 'inspect' && deviceContent}
        {detailsTab === 'packet' && packetContent}
        {detailsTab === 'scenario' && lessonContent}
        {detailsTab === 'settings' && settingsContent}
      </div>
    </aside>
  );

  const switchMode = (m: ViewMode) => {
    setMode(m);
    setDirty(true);
    rebuild(topo, m, options);
  };

  const themeLabel = theme === 'system' ? 'Automatic' : theme === 'light' ? 'Light' : 'Dark';
  const NEW_LABS: [string, string][] = [['three', '3 routers (simple)'], ['five', '5 routers (alternative paths)'], ['triangle', 'Triangle (weighted)'], ['switch', 'Switched LAN'], ['loopback', 'R1–R2–R3 with loopbacks'], ['ospflan', 'OSPF LAN: 3 routers on a switch (DR/BDR)'], ['empty', 'Empty canvas']];
  const labMenu: MenuItem[] = [
    { label: 'Save lab', hint: labInfo.inLibrary ? '' : 'in this browser', onSelect: saveLab },
    { label: 'Save as / rename…', onSelect: () => setDialog('save') },
    { label: 'Open lab…', onSelect: () => setDialog('open') },
    { separator: true },
    { heading: 'New lab' },
    ...NEW_LABS.map(([k, l]) => ({ label: l, onSelect: () => newLab(k) })),
    { separator: true },
    { label: 'Import lab file…', onSelect: () => fileRef.current?.click() },
    { label: 'Export lab file', onSelect: () => downloadLab(currentLab()) },
    { separator: true },
    { label: 'Start fresh…', hint: 'reset everything', onSelect: startFresh },
  ];
  const moreMenu: MenuItem[] = [
    { label: 'Open lab…', onSelect: () => setDialog('open') },
    { label: 'Import lab file…', onSelect: () => fileRef.current?.click() },
    { label: 'Export lab file', onSelect: () => downloadLab(currentLab()) },
    { separator: true },
    { label: `Theme: ${themeLabel}`, hint: 'change', onSelect: () => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system') },
    { label: 'Teacher mode', checked: teacher.on, onSelect: () => { setTeacher({ ...teacher, on: !teacher.on }); openTab('scenario'); } },
    { label: 'Large text for projectors', checked: large, onSelect: () => setLarge(!large) },
    { label: 'Reduce motion', checked: reducedMotion, onSelect: () => setReducedMotion(!reducedMotion) },
    { label: 'Reset panel size', onSelect: () => resetLayout() },
    { separator: true },
    { label: 'Start fresh…', hint: 'reset everything', onSelect: startFresh },
    { label: 'Model assumptions', onSelect: () => setShowAssumptions(true) },
  ];

  const MODES: [ViewMode, string, string][] = [['static', 'Static', 'Static'], ['dv', 'Distance vector', 'DV'], ['ls', 'Link state', 'LS'], ['compare', 'Compare', 'Compare']];
  const header = (
    <header className="hdr">
      <div className="hdr-brand">
        <Icon name="network" size={24} />
        {wide && <span>Routing Visual Lab</span>}
      </div>
      <MenuButton className="lab-btn" ariaLabel={`Lab: ${labInfo.name}. Lab menu`} items={labMenu} align="left">
        <span className="lab-btn-name">{labInfo.name}</span>
        <span className={`lab-btn-state ${dirty ? 'unsaved' : ''}`}>{dirty ? 'Unsaved' : labInfo.inLibrary ? 'Saved' : 'Not saved'}</span>
        <Icon name="chevron" size={14} />
      </MenuButton>
      {wide && (
        <div className="hdr-center">
          <div className="segm" role="group" aria-label="Routing method">
            {MODES.map(([m, l]) => <button key={m} aria-pressed={mode === m} onClick={() => switchMode(m)}>{l}</button>)}
          </div>
        </div>
      )}
      {!wide && <span className="grow-1" />}
      <div className="hdr-actions">
        {run ? (
          <div className="ping-status" role="status">
            <span className="pulse-dot" aria-hidden />
            {wide && <span><strong>Pinging</strong> {deviceName(curTopo, run.form.src)} → {dstText(run.form)}</span>}
            <span className="muted">{run.total === Infinity ? `∞ ping ${run.sent}` : `ping ${run.sent} of ${run.total}`}{done.sent > 0 ? ` · ${done.received}/${done.sent} replied` : ''}</span>
            <button className="mini-btn" onClick={() => { setPlaying(false); finishPing(run, cursor); }}>Stop</button>
          </div>
        ) : (
          <div className="ping-anchor">
            <button className="hbtn outline" data-ping-trigger aria-expanded={pingOpen} aria-haspopup="dialog" disabled={mode === 'compare'}
              onClick={() => setPingOpen(!pingOpen)} title={mode === 'compare' ? 'Ping is available in Static, Distance vector and Link state' : 'Send a ping'}>
              <Icon name="ping" size={17} />{wide && 'Ping'}
            </button>
            {pingOpen && (
              <PingPopover topo={curTopo} form={pingForm} setForm={setPingForm} count={pingCount} setCount={setPingCount} sheet={!wide}
                onRun={() => { runPing(); if (!wide) setMobileTab('step'); }} onClose={() => setPingOpen(false)} onClearL2={clearL2Now} l2Text={l2Text} />
            )}
          </div>
        )}
        {wide && lastStats && !run && <span className="last-ping small muted">Last ping: {lastStats.received}/{lastStats.sent} replies</span>}
        <button className="hbtn primary" onClick={() => setDialog('share')}><Icon name="share" size={17} />{wide && 'Share'}</button>
        <MenuButton className="hbtn icon" ariaLabel="More: open, import, export, theme, teacher mode" items={moreMenu}><Icon name="more" size={18} /></MenuButton>
      </div>
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }} />
    </header>
  );

  const MOBILE_TABS: [MobileTab, string, string][] = [['step', 'Step', 'network'], ['device', selNote ? 'Note' : 'Device', 'table'], ['packet', 'Packet', 'ping'], ['lesson', 'Lesson', 'book'], ['steps', 'Steps', 'steps'], ['settings', 'More', 'settings']];

  return (
    <div className={`app shell ${wide ? 'wide' : 'narrow'} ${presenting ? 'presenting' : ''}`}>
      {!presenting && header}
      {!wide && !presenting && (
        <div className="mode-strip">
          <div className="segm" role="group" aria-label="Routing method">
            {MODES.map(([m, , s]) => <button key={m} aria-pressed={mode === m} onClick={() => switchMode(m)}>{s}</button>)}
          </div>
        </div>
      )}
      {wide ? (
        <div className="shell-body" ref={setShell} style={{ '--sidebar': `${sidebarW}px` } as React.CSSProperties}>
          {!presenting && rail}
          {stage}
          {!presenting && !layout.detailsCollapsed && (
            <>
              <Splitter
                orientation="vertical" invert label="Divider between the network and the inspector" value={sidebarW} min={MIN.sidebar} max={sidebarMax}
                onLive={(v) => setVar('--sidebar', v)} onCommit={(v) => patchLayout({ sidebar: v })} onReset={() => patchLayout({ sidebar: DEFAULT_LAYOUT.sidebar })}
              />
              {inspector}
            </>
          )}
          {!presenting && layout.detailsCollapsed && (
            <button className="show-insp" onClick={() => patchLayout({ detailsCollapsed: false })} aria-label="Show inspector" title="Show inspector"><Icon name="panel" size={18} /></button>
          )}
        </div>
      ) : (
        <div className="mobile-body">
          {rail}
          {stage}
          <div className="mobile-panel">
            {mobileTab === 'step' && (mode === 'compare' ? <ComparePanel topo={applyPositions(topo, pos)} options={options} /> : stepCard)}
            {mobileTab === 'device' && deviceContent}
            {mobileTab === 'packet' && packetContent}
            {mobileTab === 'lesson' && lessonContent}
            {mobileTab === 'steps' && mode !== 'compare' && <Timeline frames={frames} cursor={cursor} onJump={(i) => { jump(i); setMobileTab('step'); }} hideFuture={oneAtATime} />}
            {mobileTab === 'settings' && settingsContent}
          </div>
          <nav className="bottom-nav" aria-label="Sections">
            {MOBILE_TABS.map(([k, l, icon]) => (
              <button key={k} aria-current={mobileTab === k ? 'page' : undefined} onClick={() => setMobileTab(k)}>
                <Icon name={icon} size={20} /><span>{l}</span>
              </button>
            ))}
          </nav>
        </div>
      )}
      {presenting && (
        <div className="present-bar">
          <button className="tbtn" onClick={() => { setPlaying(false); setCursor(Math.max(0, cursor - 1)); }} aria-label="Previous step"><Icon name="prev" size={16} /></button>
          {playing ? <button className="tbtn primary" onClick={() => setPlaying(false)}><Icon name="pause" size={14} /> Pause</button>
            : <button className="tbtn primary" onClick={() => setPlaying(true)} disabled={!(run || cursor < frames.length - 1)}><Icon name="play" size={14} /> Play</button>}
          <button className="tbtn" onClick={() => { setPlaying(false); advance(); }} aria-label="Next step"><Icon name="next" size={16} /></button>
          <span className="present-title">{mode !== 'compare' ? ev.title : 'Compare'}</span>
          <button className="tbtn" onClick={stopPresenting}>Exit (Esc)</button>
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
              <button className="btn primary" autoFocus onClick={() => { const kept = keepCurrentWork(); const lab = { ...dialog.shared, id: newId() }; setDialog(null); loadLab(lab, { inLibrary: false }, `Opened the shared lab "${lab.name}". Use Save lab to keep it in this browser.${kept}`); }}>Open shared lab</button>
              <button className="btn" onClick={() => setDialog(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

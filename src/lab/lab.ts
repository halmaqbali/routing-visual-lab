// Lab file format: topology + full device configuration + notes + simulation settings.
// Version 2 adds notes, switches, loopbacks, exercise data and a routing-table snapshot.
// Version 1 files (the earlier "Save" format) are migrated automatically.
import { DEFAULT_OPTIONS, type DeviceKind, type Level, type SimOptions, type Topology } from '../model/types';
import type { Tables } from '../engine/rib';

export const LAB_FORMAT = 'routing-visual-lab';
export const LAB_VERSION = 2;

export type NoteShade = 'white' | 'light' | 'mid' | 'dark';

export interface Note {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  /** Simple formatting: **bold**, lines starting with "- " become bullets, line breaks are kept. */
  text: string;
  shade: NoteShade;
  locked?: boolean;
  /** Optional arrow from the note to a device. */
  arrowTo?: string;
}

export type LabMode = 'static' | 'dv' | 'ls' | 'compare';

/** The part of a lab that describes the network and its settings. */
export interface LabCore {
  topo: Topology;
  notes: Note[];
  mode: LabMode;
  options: SimOptions;
  level: Level;
}

export interface Lab extends LabCore {
  format: typeof LAB_FORMAT;
  version: typeof LAB_VERSION;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  scenario?: string | null;
  /** Where the timeline was, plus the routing tables at that point (a snapshot for checking the restore). */
  sim?: { cursor: number; tables?: Tables };
  /** Present when the lab was shared as an exercise. `original` is the untouched starting configuration. */
  exercise?: { studentMode: boolean; instructions?: string; original: LabCore; sharedAt: string };
}

export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `lab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function mergeOptions(o?: Partial<SimOptions>): SimOptions {
  return { ...DEFAULT_OPTIONS, ...o, dv: { ...DEFAULT_OPTIONS.dv, ...(o?.dv ?? {}) } };
}

export function makeLab(core: LabCore, name = 'Untitled lab', extra: Partial<Lab> = {}): Lab {
  const now = new Date().toISOString();
  return { format: LAB_FORMAT, version: LAB_VERSION, id: newId(), name, createdAt: now, updatedAt: now, ...structuredClone(core), ...extra };
}

export function coreOf(lab: LabCore): LabCore {
  return structuredClone({ topo: lab.topo, notes: lab.notes, mode: lab.mode, options: lab.options, level: lab.level });
}

const KINDS: DeviceKind[] = ['router', 'pc', 'switch'];
const MODES: LabMode[] = ['static', 'dv', 'ls', 'compare'];

/** Structural checks that keep a broken or hostile file from crashing the simulator. */
export function checkTopology(t: unknown): string[] {
  const e: string[] = [];
  const topo = t as Topology;
  if (!topo || !Array.isArray(topo.devices) || !Array.isArray(topo.links)) return ['The file has no "topo" with "devices" and "links" lists.'];
  const ids = new Set<string>();
  for (const [k, d] of topo.devices.entries()) {
    if (!d || typeof d.id !== 'string' || !d.id) { e.push(`Device #${k + 1} has no id.`); continue; }
    if (ids.has(d.id)) e.push(`Device id "${d.id}" is used twice.`);
    ids.add(d.id);
    if (!KINDS.includes(d.kind)) e.push(`Device "${d.id}" has an unknown type "${String(d.kind)}".`);
    if (typeof d.name !== 'string') e.push(`Device "${d.id}" has no name.`);
    if (typeof d.x !== 'number' || typeof d.y !== 'number' || !Number.isFinite(d.x) || !Number.isFinite(d.y)) e.push(`Device "${d.id}" has no valid position.`);
    if (!Array.isArray(d.ifaces)) e.push(`Device "${d.id}" has no interface list.`);
    else for (const i of d.ifaces) if (!i || typeof i.id !== 'string' || typeof i.name !== 'string' || typeof i.ip !== 'string' || typeof i.prefix !== 'number') e.push(`Device "${d.id}" has a malformed interface.`);
    if (d.staticRoutes !== undefined && !Array.isArray(d.staticRoutes)) e.push(`Device "${d.id}" has malformed static routes.`);
  }
  for (const l of topo.links) {
    if (!l || typeof l.id !== 'string' || !l.a || !l.b) { e.push('A link is malformed.'); continue; }
    for (const end of [l.a, l.b]) {
      const d = topo.devices.find((x) => x.id === end.dev);
      if (!d) e.push(`Link "${l.id}" points to a missing device "${end.dev}".`);
      else if (Array.isArray(d.ifaces) && !d.ifaces.some((i) => i.id === end.iface)) e.push(`Link "${l.id}" points to a missing interface on ${d.name}.`);
    }
    if (typeof l.cost !== 'number' || typeof l.up !== 'boolean') e.push(`Link "${l.id}" has no valid cost / state.`);
  }
  return e;
}

function normaliseTopo(topo: Topology): Topology {
  const t = structuredClone(topo);
  for (const d of t.devices) {
    d.staticRoutes = Array.isArray(d.staticRoutes) ? d.staticRoutes : [];
    if (d.kind === 'pc' && typeof d.gateway !== 'string') d.gateway = '';
  }
  return t;
}

function normaliseNotes(n: unknown): Note[] {
  if (!Array.isArray(n)) return [];
  return n
    .filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string' && Number.isFinite(x.x) && Number.isFinite(x.y))
    .map((x) => ({
      id: x.id, x: x.x, y: x.y, w: Number.isFinite(x.w) ? x.w : 220, h: Number.isFinite(x.h) ? x.h : 120,
      title: typeof x.title === 'string' ? x.title : undefined, text: x.text,
      shade: (['white', 'light', 'mid', 'dark'] as const).includes(x.shade) ? x.shade : 'light',
      locked: x.locked === true || undefined, arrowTo: typeof x.arrowTo === 'string' ? x.arrowTo : undefined,
    }));
}

export type ParseResult = { ok: true; lab: Lab; migratedFrom?: number } | { ok: false; errors: string[] };

/** Read a lab from parsed JSON: validates the structure and migrates older versions. */
export function parseLab(raw: unknown, fallbackName = 'Imported lab'): ParseResult {
  const x = raw as Partial<Lab> & { version?: number; format?: string };
  if (!x || typeof x !== 'object') return { ok: false, errors: ['This is not a lab file (expected a JSON object).'] };
  if (x.format !== LAB_FORMAT) return { ok: false, errors: ['This JSON file is not a Routing Visual Lab file.'] };
  const version = typeof x.version === 'number' ? x.version : 1;
  if (version > LAB_VERSION) return { ok: false, errors: [`This lab was saved by a newer version (format ${version}). Please update the app.`] };
  const errors = checkTopology(x.topo);
  if (errors.length) return { ok: false, errors };
  const mode = MODES.includes(x.mode as LabMode) ? (x.mode as LabMode) : 'static';
  const level: Level = x.level === 'advanced' ? 'advanced' : 'beginner';
  const now = new Date().toISOString();
  const lab: Lab = {
    format: LAB_FORMAT, version: LAB_VERSION,
    id: typeof x.id === 'string' && x.id ? x.id : newId(),
    name: typeof x.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 120) : fallbackName,
    createdAt: typeof x.createdAt === 'string' ? x.createdAt : now,
    updatedAt: typeof x.updatedAt === 'string' ? x.updatedAt : now,
    topo: normaliseTopo(x.topo as Topology), notes: normaliseNotes(x.notes), mode, options: mergeOptions(x.options), level,
    scenario: typeof x.scenario === 'string' ? x.scenario : null,
  };
  if (x.sim && Number.isInteger(x.sim.cursor)) lab.sim = { cursor: x.sim.cursor, tables: x.sim.tables };
  if (x.exercise && x.exercise.original && !checkTopology(x.exercise.original.topo).length) {
    const o = x.exercise.original;
    lab.exercise = {
      studentMode: x.exercise.studentMode === true,
      instructions: typeof x.exercise.instructions === 'string' ? x.exercise.instructions : undefined,
      sharedAt: typeof x.exercise.sharedAt === 'string' ? x.exercise.sharedAt : now,
      original: { topo: normaliseTopo(o.topo), notes: normaliseNotes(o.notes), mode: MODES.includes(o.mode) ? o.mode : mode, options: mergeOptions(o.options), level: o.level === 'advanced' ? 'advanced' : 'beginner' },
    };
  }
  return version < LAB_VERSION ? { ok: true, lab, migratedFrom: version } : { ok: true, lab };
}

export function parseLabText(text: string, fallbackName?: string): ParseResult {
  try {
    return parseLab(JSON.parse(text), fallbackName);
  } catch {
    return { ok: false, errors: ['The file is not valid JSON.'] };
  }
}

export function serializeLab(lab: Lab): string {
  return JSON.stringify(lab, null, 2);
}

export function safeFileName(name: string) {
  return (name.trim() || 'lab').replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').slice(0, 60).toLowerCase() || 'lab';
}

/**
 * Prepare a lab for students. `stripStaticRoutes` removes every static route so students configure routing
 * themselves. The starting configuration is kept in `exercise.original` (never edited) for Reset Lab.
 */
export function makeExercise(lab: Lab, o: { stripStaticRoutes: boolean; instructions?: string }): Lab {
  const core = coreOf(lab);
  if (o.stripStaticRoutes) for (const d of core.topo.devices) d.staticRoutes = [];
  const now = new Date().toISOString();
  return {
    ...makeLab(core, lab.name),
    exercise: { studentMode: true, instructions: o.instructions?.trim() || undefined, original: coreOf(core), sharedAt: now },
  };
}

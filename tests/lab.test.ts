import { describe, expect, it } from 'vitest';
import { addStatic, staticRoute, switchedLan } from '../src/model/samples';
import { addLoopback } from '../src/model/topology';
import { DEFAULT_OPTIONS } from '../src/model/types';
import { coreOf, makeExercise, makeLab, parseLab, parseLabText, serializeLab, type Lab, type LabCore } from '../src/lab/lab';
import { CURRENT, LabLibrary, LEGACY_AUTOSAVE, memoryStore } from '../src/lab/library';
import { decodeLab, encodeLab, labCodeFromHash, shareLink } from '../src/lab/share';
import { applyTheme, loadTheme, saveTheme, THEME_KEY } from '../src/lab/theme';
import { buildStaticTables } from '../src/engine/static';
import { converge } from '../src/engine/simulation';

function configuredCore(): LabCore {
  let topo = switchedLan();
  topo = addStatic(topo, 'R1', staticRoute('192.168.2.0', 24, '10.0.12.2'), staticRoute('0.0.0.0', 0, '10.0.12.2', 5));
  topo = addStatic(topo, 'R2', staticRoute('192.168.1.0', 24, '10.0.12.1'));
  topo = addLoopback(topo, 'r1', '10.1.1.1', 32);
  topo.links[0].cost = 7;
  topo.links[4].up = false;
  return {
    topo,
    notes: [
      { id: 'n1', x: 40, y: 30, w: 240, h: 140, title: 'Task 1: Configure Static Routing', text: 'Configure **R1** to reach R3.\n- Then ping\n- Explain the return route', shade: 'light', arrowTo: 'r1' },
      { id: 'n2', x: 500, y: 400, w: 180, h: 90, text: 'Locked hint', shade: 'dark', locked: true },
    ],
    mode: 'dv',
    options: { ...DEFAULT_OPTIONS, ttl: 32, dv: { ...DEFAULT_OPTIONS.dv, profile: 'rip', poisonReverse: true } },
    level: 'advanced',
  };
}

describe('lab file format', () => {
  it('a configured topology survives export and import exactly', () => {
    const lab = makeLab(configuredCore(), 'Static routing lab');
    const back = parseLabText(serializeLab(lab));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(coreOf(back.lab)).toEqual(coreOf(lab));
    expect(back.lab.name).toBe('Static routing lab');
    // Every device keeps its full configuration, not just its position
    const r1 = back.lab.topo.devices.find((d) => d.id === 'r1')!;
    expect(r1.staticRoutes.map((r) => `${r.network}/${r.prefix}>${r.nextHop}@${r.ad}`)).toEqual(['192.168.2.0/24>10.0.12.2@1', '0.0.0.0/0>10.0.12.2@5']);
    expect(r1.ifaces.find((i) => i.kind === 'loopback')).toMatchObject({ ip: '10.1.1.1', prefix: 32 });
    expect(back.lab.topo.devices.find((d) => d.id === 'sw1')!.kind).toBe('switch');
    expect(back.lab.topo.devices.find((d) => d.id === 'pc1')!.gateway).toBe('192.168.1.1');
  });

  it('routing tables are reproduced from the restored configuration', () => {
    const lab = makeLab(configuredCore());
    const back = parseLabText(serializeLab(lab));
    if (!back.ok) throw new Error('parse failed');
    expect(buildStaticTables(back.lab.topo).tables).toEqual(buildStaticTables(lab.topo).tables);
    expect(converge(back.lab.topo, 'dv', back.lab.options).state.tables).toEqual(converge(lab.topo, 'dv', lab.options).state.tables);
  });

  it('migrates version 1 files (the earlier Save format)', () => {
    const v1 = { format: 'routing-visual-lab', version: 1, topo: switchedLan(), mode: 'ls', options: DEFAULT_OPTIONS, level: 'beginner', scenario: null };
    const r = parseLab(v1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migratedFrom).toBe(1);
    expect(r.lab.version).toBe(2);
    expect(r.lab.notes).toEqual([]);
    expect(r.lab.topo).toEqual(switchedLan());
    expect(r.lab.mode).toBe('ls');
  });

  it('rejects broken, foreign or newer files with clear messages', () => {
    expect(parseLabText('not json')).toEqual({ ok: false, errors: ['The file is not valid JSON.'] });
    expect(parseLab({ hello: 1 })).toMatchObject({ ok: false });
    const t = switchedLan();
    t.links[0].a.iface = 'nope';
    const r = parseLab({ format: 'routing-visual-lab', version: 2, topo: t });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/missing interface/);
    const newer = parseLab({ format: 'routing-visual-lab', version: 99, topo: switchedLan() });
    expect(newer.ok).toBe(false);
  });
});

describe('saved labs library', () => {
  it('saves, lists, reopens, renames, duplicates and deletes labs', () => {
    const lib = new LabLibrary(memoryStore());
    const a = makeLab(configuredCore(), 'Lab A');
    lib.save(a);
    lib.save(makeLab(configuredCore(), 'Lab B'));
    expect(lib.list().map((m) => m.name).sort()).toEqual(['Lab A', 'Lab B']);
    expect(coreOf(lib.load(a.id)!)).toEqual(coreOf(a));
    expect(lib.rename(a.id, 'Lab A — renamed')).toBe(true);
    expect(lib.load(a.id)!.name).toBe('Lab A — renamed');
    const copy = lib.duplicate(a.id)!;
    expect(copy.id).not.toBe(a.id);
    expect(copy.name).toBe('Lab A — renamed (copy)');
    expect(coreOf(copy)).toEqual(coreOf(a));
    lib.delete(a.id);
    expect(lib.load(a.id)).toBeNull();
    expect(lib.list().map((m) => m.name).sort()).toEqual(['Lab A — renamed (copy)', 'Lab B']);
  });

  it('autosaves the current work and survives a reload', () => {
    const store = memoryStore();
    const lab = makeLab(configuredCore(), 'Work in progress');
    new LabLibrary(store).saveCurrent(lab);
    const reopened = new LabLibrary(store).loadCurrent()!; // a new page load
    expect(coreOf(reopened)).toEqual(coreOf(lab));
  });

  it('migrates the old autosave when no new one exists', () => {
    const store = memoryStore();
    store.setItem(LEGACY_AUTOSAVE, JSON.stringify({ format: 'routing-visual-lab', version: 1, topo: switchedLan(), mode: 'static', options: DEFAULT_OPTIONS, level: 'beginner' }));
    const lab = new LabLibrary(store).loadCurrent()!;
    expect(lab.topo).toEqual(switchedLan());
    expect(store.getItem(CURRENT)).toBeNull();
  });
});

describe('sharing', () => {
  it('a share link carries the complete lab to another browser', async () => {
    const lab = makeLab(configuredCore(), 'Shared exercise');
    const link = await shareLink(lab, 'https://example.org/routing-visual-lab/');
    expect(link.startsWith('https://example.org/routing-visual-lab/#lab=')).toBe(true);
    // A different user: a fresh browser with empty storage, only the link
    const code = labCodeFromHash(new URL(link).hash)!;
    const r = await decodeLab(code);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(coreOf(r.lab)).toEqual(coreOf(lab));
    const theirLibrary = new LabLibrary(memoryStore());
    theirLibrary.save(r.lab);
    expect(coreOf(theirLibrary.load(r.lab.id)!)).toEqual(coreOf(lab));
  });

  it('compresses links (small enough for a QR code for typical labs)', async () => {
    const lab = makeLab(configuredCore());
    const code = await encodeLab(lab);
    expect(code.startsWith('z.')).toBe(true);
    expect(code.length).toBeLessThan(serializeLab(lab).length / 2);
  });

  it('reports damaged links instead of loading garbage', async () => {
    const code = await encodeLab(makeLab(configuredCore()));
    const r = await decodeLab(code.slice(0, code.length / 2));
    expect(r.ok).toBe(false);
  });

  it('exercise mode keeps an untouched original for Reset Lab and can strip static routes', () => {
    const lab: Lab = makeLab(configuredCore(), 'Instructor lab');
    const ex = makeExercise(lab, { stripStaticRoutes: true, instructions: 'Add the missing routes.' });
    expect(ex.exercise!.studentMode).toBe(true);
    expect(ex.topo.devices.every((d) => d.staticRoutes.length === 0)).toBe(true);
    expect(lab.topo.devices.find((d) => d.id === 'r1')!.staticRoutes.length).toBe(2); // instructor's lab unchanged
    // The student edits their copy; the original stays as shared
    ex.topo.devices.find((d) => d.id === 'r1')!.staticRoutes.push({ id: 'x', network: '1.0.0.0', prefix: 8, nextHop: '10.0.12.2', ad: 1, enabled: true });
    ex.notes.push({ id: 'n9', x: 0, y: 0, w: 10, h: 10, text: 'student note', shade: 'white' });
    expect(ex.exercise!.original.topo.devices.find((d) => d.id === 'r1')!.staticRoutes).toEqual([]);
    expect(ex.exercise!.original.notes.length).toBe(2);
    const back = parseLabText(serializeLab(ex));
    expect(back.ok && back.lab.exercise?.instructions).toBe('Add the missing routes.');
  });
});

describe('canvas notes and theme', () => {
  it('notes survive save, reload and sharing with their formatting, lock and arrow', async () => {
    const lab = makeLab(configuredCore());
    const lib = new LabLibrary(memoryStore());
    lib.save(lab);
    const n = lib.load(lab.id)!.notes;
    expect(n).toEqual(lab.notes);
    const shared = await decodeLab(await encodeLab(lab));
    expect(shared.ok && shared.lab.notes).toEqual(lab.notes);
  });

  it('switching theme only stores the theme preference and leaves labs untouched', () => {
    const store = memoryStore();
    const lab = makeLab(configuredCore());
    new LabLibrary(store).saveCurrent(lab);
    const before = store.getItem(CURRENT);
    saveTheme(store, 'dark');
    expect(loadTheme(store)).toBe('dark');
    expect(store.getItem(CURRENT)).toBe(before);
    expect([...store.data.keys()].sort()).toEqual([CURRENT, THEME_KEY].sort());
    const attrs: Record<string, string> = {};
    const root = { setAttribute: (k: string, v: string) => void (attrs[k] = v), removeAttribute: (k: string) => void delete attrs[k] };
    applyTheme(root, 'dark');
    expect(attrs['data-theme']).toBe('dark');
    applyTheme(root, 'system');
    expect(attrs['data-theme']).toBeUndefined();
  });
});

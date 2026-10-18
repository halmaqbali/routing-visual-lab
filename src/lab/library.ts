// Saved-labs library in browser storage, plus the current-work autosave.
import { coreOf, makeLab, parseLab, type Lab, type LabCore } from './lab';

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface LabMeta {
  id: string;
  name: string;
  updatedAt: string;
  devices: number;
  notes: number;
  exercise: boolean;
}

const INDEX = 'routing-visual-lab:library';
const ITEM = (id: string) => `routing-visual-lab:lab:${id}`;
export const CURRENT = 'routing-visual-lab:current';
/** The old (version 1) autosave key, migrated on first load. */
export const LEGACY_AUTOSAVE = 'routing-visual-lab:autosave';

function defaultStore(): KV | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class LabLibrary {
  constructor(private store: KV | null = defaultStore()) {}

  private readIndex(): LabMeta[] {
    try {
      const v = JSON.parse(this.store?.getItem(INDEX) ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private writeIndex(list: LabMeta[]) {
    this.store?.setItem(INDEX, JSON.stringify(list));
  }

  list(): LabMeta[] {
    return this.readIndex().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Save (create or overwrite) a lab. Throws if storage is full or unavailable. */
  save(lab: Lab): LabMeta {
    if (!this.store) throw new Error('Browser storage is not available (private mode or blocked). Use Export Lab to keep a file instead.');
    const saved: Lab = { ...lab, updatedAt: new Date().toISOString() };
    this.store.setItem(ITEM(lab.id), JSON.stringify(saved));
    const meta: LabMeta = { id: lab.id, name: lab.name, updatedAt: saved.updatedAt, devices: lab.topo.devices.length, notes: lab.notes.length, exercise: !!lab.exercise };
    this.writeIndex([meta, ...this.readIndex().filter((m) => m.id !== lab.id)]);
    return meta;
  }

  load(id: string): Lab | null {
    try {
      const raw = this.store?.getItem(ITEM(id));
      if (!raw) return null;
      const r = parseLab(JSON.parse(raw));
      return r.ok ? r.lab : null;
    } catch {
      return null;
    }
  }

  rename(id: string, name: string): boolean {
    const lab = this.load(id);
    if (!lab || !name.trim()) return false;
    this.save({ ...lab, name: name.trim().slice(0, 120) });
    return true;
  }

  duplicate(id: string): Lab | null {
    const lab = this.load(id);
    if (!lab) return null;
    const copy = makeLab(coreOf(lab), `${lab.name} (copy)`, { scenario: lab.scenario, exercise: lab.exercise ? structuredClone(lab.exercise) : undefined });
    this.save(copy);
    return copy;
  }

  delete(id: string) {
    this.store?.removeItem(ITEM(id));
    this.writeIndex(this.readIndex().filter((m) => m.id !== id));
  }

  // ---------------------------------------------------------------- current work (autosave)

  saveCurrent(lab: Lab) {
    try {
      this.store?.setItem(CURRENT, JSON.stringify(lab));
    } catch {
      /* full or blocked: autosave is best effort */
    }
  }

  /** The autosaved working lab, migrating the old version-1 autosave if that is all there is. */
  loadCurrent(): Lab | null {
    try {
      const raw = this.store?.getItem(CURRENT) ?? this.store?.getItem(LEGACY_AUTOSAVE);
      if (!raw) return null;
      const r = parseLab(JSON.parse(raw), 'My lab');
      return r.ok ? r.lab : null;
    } catch {
      return null;
    }
  }
}

export function memoryStore(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

export type { LabCore };

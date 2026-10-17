import type { Mode, SimOptions, Topology } from '../model/types';
import type { Change, Route, Tables } from './rib';

export type EventCategory = 'config' | 'control' | 'lsa' | 'spf' | 'data' | 'info';

export type AnimStyle = 'data' | 'dv' | 'lsa' | 'hello';

export interface Anim {
  from: string;
  to: string;
  linkId: string;
  style: AnimStyle;
  label?: string;
  drop?: boolean;
}

// ---------------------------------------------------------------- distance vector

export interface Advert {
  network: string;
  prefix: number;
  metric: number;
  poisoned?: boolean; // poison reverse
}

export interface DvCalcRow {
  key: string;
  advertised: number;
  linkCost: number;
  candidate: number;
  current: string; // description of the existing entry
  decision: 'new' | 'better' | 'update-same' | 'refresh' | 'worse' | 'equal' | 'connected' | 'unreachable';
  text: string;
}

export interface DvDetail {
  from: string;
  to: string;
  adverts: Advert[];
  omitted: string[]; // keys suppressed by split horizon
  rows: DvCalcRow[];
  triggered: boolean;
}

export interface DvState {
  infinity: number;
  rounds: number;
  changedSinceRound: boolean;
  converged: boolean;
}

// ---------------------------------------------------------------- link state

export interface LsaLink {
  to: string;
  linkId: string;
  cost: number;
}

export interface Lsa {
  origin: string;
  seq: number;
  links: LsaLink[];
  stubs: { network: string; prefix: number }[];
}

export interface LsNeighbor {
  router: string;
  linkId: string;
  cost: number;
  localIface: string;
  remoteIp: string;
}

export interface SpfRelax {
  node: string;
  via: string;
  linkId: string;
  cost: number;
  oldDist: number | null;
  newDist: number;
  outcome: 'improved' | 'new' | 'not-better' | 'confirmed';
  text: string;
}

export interface SpfStep {
  selected: string;
  selectedDist: number;
  confirmed: string[];
  tentative: Record<string, { dist: number; pred: string | null }>;
  relax: SpfRelax[];
}

export interface SpfResult {
  root: string;
  dist: Record<string, number>;
  pred: Record<string, { node: string; linkId: string } | null>;
  steps: SpfStep[];
  firstHop: Record<string, { router: string; linkId: string }>;
  /** Two-way checked edges used in the calculation. */
  edges: { a: string; b: string; linkId: string; cost: number }[];
}

export interface LsRouterState {
  neighbors: LsNeighbor[];
  lsdb: Record<string, Lsa>;
  seq: number;
  spf: SpfResult | null;
}

export interface LsState {
  routers: Record<string, LsRouterState>;
}

// ---------------------------------------------------------------- static

export interface StaticStatus {
  routeId: string;
  installed: boolean;
  reason: string;
}

// ---------------------------------------------------------------- queue

export type Pending =
  | { t: number; seq: number; type: 'round' }
  | { t: number; seq: number; type: 'triggered'; router: string; keys: string[] }
  | { t: number; seq: number; type: 'full-update'; router: string; to: string }
  | { t: number; seq: number; type: 'dv-deliver'; from: string; to: string; linkId: string; adverts: Advert[]; omitted: string[]; triggered: boolean }
  | { t: number; seq: number; type: 'hello'; linkId: string }
  | { t: number; seq: number; type: 'describe'; router: string }
  | { t: number; seq: number; type: 'originate'; router: string; reason: string }
  | { t: number; seq: number; type: 'lsa-deliver'; from: string; to: string; linkId: string; lsa: Lsa }
  | { t: number; seq: number; type: 'spf'; router: string };

export interface SimState {
  time: number;
  topo: Topology;
  mode: Mode;
  options: SimOptions;
  tables: Tables;
  staticStatus: Record<string, StaticStatus[]>;
  dv: DvState | null;
  ls: LsState | null;
  queue: Pending[];
  seq: number;
  done: boolean;
  /** For SPF frames: which router's calculation and how many steps are shown. */
  spfView: { router: string; step: number } | null;
}

export interface SimEvent {
  kind: string;
  category: EventCategory;
  time: number;
  title: string;
  explain: string;
  detail?: string[];
  routers?: string[];
  anim?: Anim;
  changes?: Change[];
  dv?: DvDetail;
  lsa?: { lsa: Lsa; installed: boolean };
  spf?: { router: string; step: number; total: number };
  ping?: import('./ping').HopStep;
}

export interface Frame {
  ev: SimEvent;
  state: SimState;
}

export type { Route };

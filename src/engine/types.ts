import type { Mode, SimOptions, Topology } from '../model/types';
import type { Change, Route, Tables } from './rib';
import type { L2State } from './l2';
import type { PacketView } from './packets';

export type EventCategory = 'config' | 'control' | 'lsa' | 'spf' | 'data' | 'info';

export type AnimStyle = 'data' | 'dv' | 'lsa' | 'hello';

export interface Anim {
  from: string;
  to: string;
  linkId: string;
  style: AnimStyle;
  label?: string;
  drop?: boolean;
  /** TTL carried by a data packet on this hop. */
  ttl?: number;
  /** Devices to travel through (e.g. R1 → SW1 → R2); defaults to a straight from → to line. */
  path?: string[];
  /** Extra simultaneous copies (switch flooding). */
  copies?: { from: string; to: string }[];
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
  /** A router id (point-to-point link) or a Network-LSA key `net:<DR address>` (transit LAN). */
  to: string;
  linkId: string;
  cost: number;
  /** Transit network: the router is attached to a LAN described by the DR's Network-LSA. */
  transit?: boolean;
}

export interface Lsa {
  /** Router that created the LSA (the DR, for a Network-LSA). */
  origin: string;
  seq: number;
  links: LsaLink[];
  stubs: { network: string; prefix: number }[];
  /** OSPF LSA type: 'router' (Type 1, default) or 'network' (Type 2, made by a LAN's DR). */
  kind?: 'router' | 'network';
  /** LSDB key: the router id for a Router-LSA, `net:<DR address>` for a Network-LSA. */
  id?: string;
  /** Network-LSA: the routers attached to the LAN (fully adjacent to the DR, plus the DR). */
  attached?: string[];
  /** Network-LSA: the LAN's address. */
  net?: { network: string; prefix: number };
}

export type NbrState = 'Init' | '2-Way' | 'ExStart' | 'Exchange' | 'Loading' | 'Full';

export interface LsNeighbor {
  router: string;
  linkId: string;
  cost: number;
  localIface: string;
  remoteIp: string;
  /** OSPF neighbour state. Only Full neighbours exchange LSAs and appear in Router-LSAs. */
  state: NbrState;
  /** The neighbour's router ID. */
  rid: string;
}

/** Per-interface OSPF state: the network type and, on a LAN, the elected DR and BDR. */
export interface LsIface {
  multiAccess: boolean;
  dr?: string;
  bdr?: string;
  /** The DR's interface address on this LAN (names the Network-LSA). */
  drIp?: string;
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
  /** First router on the shortest path; `via` is the transit LAN crossed to reach it, if any. */
  firstHop: Record<string, { router: string; linkId: string; via?: string }>;
  /** Two-way checked edges used in the calculation. */
  edges: { a: string; b: string; linkId: string; cost: number }[];
}

export interface LsRouterState {
  neighbors: LsNeighbor[];
  lsdb: Record<string, Lsa>;
  seq: number;
  spf: SpfResult | null;
  /** Interface id → OSPF interface state. */
  ifaces?: Record<string, LsIface>;
  /** Sequence numbers of the Network-LSAs this router originated as DR. */
  netSeq?: Record<string, number>;
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
  | { t: number; seq: number; type: 'hello'; router: string; iface: string }
  | { t: number; seq: number; type: 'hello-rx'; from: string; to: string; key: string; seen: string[]; dr?: string; bdr?: string }
  | { t: number; seq: number; type: 'elect'; net: string }
  | { t: number; seq: number; type: 'adj'; a: string; b: string; key: string; stage: 'exstart' | 'loading' }
  | { t: number; seq: number; type: 'dead'; router: string; key: string }
  | { t: number; seq: number; type: 'originate-net'; router: string; iface: string }
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
  /** Data-plane state learned from traffic: ARP caches and switch MAC tables. */
  l2: L2State;
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
  /** What the Packet Inspector shows for the packet in this event. */
  packet?: PacketView;
}

export interface Frame {
  ev: SimEvent;
  state: SimState;
}

export type { Route };

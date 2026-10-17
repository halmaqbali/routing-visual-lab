// Routing tables (RIB), longest-prefix matching and table diffs.
import { cidr, inSubnet, networkOf, parseIp } from '../model/ip';
import { ifaceUp, routers } from '../model/topology';
import type { Topology } from '../model/types';

export type RouteSource = 'connected' | 'static' | 'dv' | 'ls';

export interface Route {
  network: string;
  prefix: number;
  source: RouteSource;
  /** Next-hop IP as configured or learned. null for connected routes and interface-only statics. */
  nextHop: string | null;
  /** Outgoing interface id after resolution (null when unresolved / unreachable). */
  iface: string | null;
  /** Directly connected neighbour address actually used (differs from nextHop for recursive statics). */
  resolvedVia?: string | null;
  metric: number;
  ad: number;
  learnedFrom?: string; // router id (dv / ls)
  unreachable?: boolean;
  staticId?: string;
  note?: string;
}

export type Table = Route[];
export type Tables = Record<string, Table>;

export const AD = { connected: 0, static: 1, ls: 110, dv: 120 } as const;

export const routeKey = (r: { network: string; prefix: number }) => cidr(r.network, r.prefix);

export function sortTable(t: Table): Table {
  return [...t].sort((a, b) => (parseIp(a.network) ?? 0) - (parseIp(b.network) ?? 0) || b.prefix - a.prefix);
}

/** Connected routes for every interface that has an address and an enabled link. */
export function connectedRoutes(topo: Topology, routerId: string): Route[] {
  const dev = topo.devices.find((d) => d.id === routerId);
  if (!dev) return [];
  const out: Route[] = [];
  for (const i of dev.ifaces) {
    if (!ifaceUp(topo, routerId, i.id)) continue;
    out.push({ network: networkOf(i.ip, i.prefix), prefix: i.prefix, source: 'connected', nextHop: null, iface: i.id, metric: 0, ad: AD.connected });
  }
  return out;
}

export function usable(r: Route): boolean {
  return !r.unreachable && r.iface !== null;
}

export interface LookupResult {
  /** Every usable route whose network contains the destination, longest prefix first. */
  candidates: Route[];
  match: Route | null;
}

/** Longest-prefix match: the most specific usable route wins. */
export function lookup(table: Table, dest: string): LookupResult {
  const candidates = table
    .filter((r) => usable(r) && inSubnet(dest, r.network, r.prefix))
    .sort((a, b) => b.prefix - a.prefix || a.ad - b.ad || a.metric - b.metric);
  return { candidates, match: candidates[0] ?? null };
}

export function explainMatch(res: LookupResult, dest: string): string {
  if (!res.match) return `No route in the table contains ${dest}, and there is no default route (0.0.0.0/0).`;
  const m = res.match;
  if (res.candidates.length === 1) return `${routeKey(m)} is the only route that contains ${dest}.`;
  const others = res.candidates.slice(1).map((r) => routeKey(r)).join(', ');
  return `${res.candidates.length} routes contain ${dest} (${routeKey(m)}, ${others}). Longest-prefix match picks ${routeKey(m)} because /${m.prefix} is the most specific.`;
}

// ---------------------------------------------------------------- diffs

export interface Change {
  router: string;
  key: string;
  kind: 'added' | 'removed' | 'changed';
  before?: Route;
  after?: Route;
}

function same(a: Route, b: Route) {
  return a.source === b.source && a.nextHop === b.nextHop && a.iface === b.iface && a.metric === b.metric && !!a.unreachable === !!b.unreachable && a.resolvedVia === b.resolvedVia;
}

export function diffTable(router: string, before: Table, after: Table): Change[] {
  const out: Change[] = [];
  const bm = new Map(before.map((r) => [routeKey(r), r]));
  const am = new Map(after.map((r) => [routeKey(r), r]));
  for (const [k, a] of am) {
    const b = bm.get(k);
    if (!b) out.push({ router, key: k, kind: 'added', after: a });
    else if (!same(a, b)) out.push({ router, key: k, kind: 'changed', before: b, after: a });
  }
  for (const [k, b] of bm) if (!am.has(k)) out.push({ router, key: k, kind: 'removed', before: b });
  return out;
}

export function diffTables(topo: Topology, before: Tables, after: Tables): Change[] {
  return routers(topo).flatMap((r) => diffTable(r.id, before[r.id] ?? [], after[r.id] ?? []));
}

export function emptyTables(topo: Topology): Tables {
  return Object.fromEntries(routers(topo).map((r) => [r.id, [] as Table]));
}

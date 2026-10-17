// Run the three approaches on the same topology and compare what actually happened.
import { cidr, networkOf } from '../model/ip';
import { getDevice, routers } from '../model/topology';
import type { Mode, SimOptions, Topology } from '../model/types';
import { simulatePing, type PingResult } from './ping';
import { routeKey, type Route } from './rib';
import { applyLinkChange, createTimeline } from './simulation';
import type { Frame } from './types';

export interface PhaseStats {
  events: number;
  messages: number;
  tableChanges: number;
  ping: PingResult;
  routes: Record<string, Route | undefined>;
  limitHit: boolean;
}

export interface ModeComparison {
  mode: Mode;
  initial: PhaseStats;
  afterFailure?: PhaseStats;
  manual: string;
}

function stats(frames: Frame[], from: number, dest: string, src: string, dst: string): PhaseStats {
  const slice = frames.slice(from);
  const s = frames[frames.length - 1].state;
  const messages = slice.filter((f) => ['dv-update', 'dv-lost', 'ls-hello', 'ls-flood', 'ls-dup', 'ls-lost'].includes(f.ev.kind)).length;
  const tableChanges = slice.reduce((n, f) => n + (f.ev.changes?.length ?? 0), 0);
  const routes = Object.fromEntries(routers(s.topo).map((r) => [r.id, s.tables[r.id]?.find((x) => routeKey(x) === dest)]));
  return { events: slice.length, messages, tableChanges, ping: simulatePing(s.topo, s.tables, src, dst, s.options.ttl), routes, limitHit: slice.some((f) => f.ev.kind === 'limit') };
}

/** Is there still any physical path of enabled links between two devices? */
export function connected(topo: Topology, a: string, b: string): boolean {
  const seen = new Set([a]);
  const stack = [a];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === b) return true;
    for (const l of topo.links) {
      if (!l.up) continue;
      const nxt = l.a.dev === cur ? l.b.dev : l.b.dev === cur ? l.a.dev : null;
      if (nxt && !seen.has(nxt) && (nxt === b || getDevice(topo, nxt)?.kind === 'router')) {
        seen.add(nxt);
        stack.push(nxt);
      }
    }
  }
  return false;
}

export function destinationOf(topo: Topology, pc: string): string {
  const i = getDevice(topo, pc)?.ifaces[0];
  return i?.ip ? cidr(networkOf(i.ip, i.prefix), i.prefix) : '';
}

export function compareModes(topo: Topology, options: SimOptions, src: string, dst: string, failLink: string | null): ModeComparison[] {
  const dest = destinationOf(topo, dst);
  return (['static', 'dv', 'ls'] as Mode[]).map((mode) => {
    const frames = createTimeline(topo, mode, options);
    const initial = stats(frames, 0, dest, src, dst);
    let afterFailure: PhaseStats | undefined;
    let manual = '';
    if (failLink) {
      const t2 = structuredClone(topo);
      const l = t2.links.find((x) => x.id === failLink);
      if (l) {
        l.up = false;
        const after = applyLinkChange(frames, frames.length - 1, t2, [failLink], 'Link disabled');
        afterFailure = stats(after, frames.length, dest, src, dst);
        const stillPath = connected(t2, src, dst);
        if (afterFailure.ping.success) manual = mode === 'static' ? (initial.ping.success ? 'No — the configured static routes (for example a backup route) still work.' : 'No (but it did not work before either).') : 'No — the routers recalculated automatically.';
        else if (!stillPath) manual = 'The network is physically split: no routing method can deliver the packet.';
        else manual = mode === 'static' ? 'Yes — an administrator must change static routes (or should have configured a backup route).' : 'Not yet converged or blocked by a configuration problem — check the event list.';
      }
    }
    return { mode, initial, afterFailure, manual };
  });
}

export const MODE_FACTS: Record<Mode, { name: string; knows: string; obtain: string; exchanged: string; calc: string; failure: string }> = {
  static: {
    name: 'Static routing',
    knows: 'Only its directly connected networks.',
    obtain: 'An administrator types every remote route by hand on every router.',
    exchanged: 'Nothing. Routers never talk to each other about routes.',
    calc: 'None. The router only does a longest-prefix lookup when forwarding.',
    failure: 'A router only notices failures on its OWN interfaces. Remote failures are invisible unless a backup (floating) route was configured.',
  },
  dv: {
    name: 'Distance vector',
    knows: 'Its connected networks. Later: a cost and a next hop for each network — never the full map.',
    obtain: 'From neighbours\' advertisements ("I can reach X at cost N").',
    exchanged: 'Each router sends its whole table (or changed entries) to its direct neighbours only.',
    calc: 'Bellman-Ford style: candidate = link cost to neighbour + neighbour\'s advertised cost; keep the lowest.',
    failure: 'Bad news spreads hop by hop. Without loop prevention, routers can count to infinity.',
  },
  ls: {
    name: 'Link state',
    knows: 'Its connected networks and its neighbours. Later: the full topology map (LSDB).',
    obtain: 'Every router floods a description of its own links (LSA) to the whole network.',
    exchanged: 'LSAs — unchanged copies of each router\'s link description — flooded to all routers.',
    calc: 'Each router runs Dijkstra (SPF) on the database, with itself as the root.',
    failure: 'Routers next to the failure originate new LSAs; all routers update their database and re-run SPF.',
  },
};

// ---------------------------------------------------------------- distance-vector loop prevention comparison

export interface LoopRow {
  label: string;
  dv: SimOptions['dv'];
  events: number;
  updates: number;
  maxMetric: number;
  loopFrames: number;
  limitHit: boolean;
}

/** Two routers that use each other as next hop for the same usable route = a routing loop. */
export function hasLoop(frame: Frame, key: string): boolean {
  const t = frame.state.tables;
  for (const [a, table] of Object.entries(t)) {
    const r = table.find((x) => routeKey(x) === key && !x.unreachable && x.learnedFrom);
    if (!r) continue;
    const back = t[r.learnedFrom!]?.find((x) => routeKey(x) === key && !x.unreachable);
    if (back?.learnedFrom === a) return true;
  }
  return false;
}

export function compareLoopPrevention(topo: Topology, options: SimOptions, failLink: string, dest: string): LoopRow[] {
  const variants: [string, Partial<SimOptions['dv']>][] = [
    ['No loop prevention', { splitHorizon: false, poisonReverse: false, triggeredUpdates: false }],
    ['Split horizon', { splitHorizon: true, poisonReverse: false, triggeredUpdates: false }],
    ['Poison reverse', { splitHorizon: false, poisonReverse: true, triggeredUpdates: false }],
    ['Triggered updates only', { splitHorizon: false, poisonReverse: false, triggeredUpdates: true }],
    ['All three', { splitHorizon: true, poisonReverse: true, triggeredUpdates: true }],
  ];
  return variants.map(([label, patch]) => {
    const o: SimOptions = { ...options, dv: { ...options.dv, ...patch } };
    const frames = createTimeline(topo, 'dv', o);
    const t2 = structuredClone(topo);
    const l = t2.links.find((x) => x.id === failLink)!;
    l.up = false;
    const after = applyLinkChange(frames, frames.length - 1, t2, [failLink], 'fail').slice(frames.length);
    let maxMetric = 0;
    for (const f of after)
      for (const table of Object.values(f.state.tables)) for (const r of table) if (routeKey(r) === dest && !r.unreachable) maxMetric = Math.max(maxMetric, r.metric);
    return {
      label,
      dv: o.dv,
      events: after.length,
      updates: after.filter((f) => f.ev.kind === 'dv-update').length,
      maxMetric,
      loopFrames: after.filter((f) => hasLoop(f, dest)).length,
      limitHit: after.some((f) => f.ev.kind === 'limit'),
    };
  });
}

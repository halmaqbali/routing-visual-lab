// Deterministic event queue helpers shared by the protocol engines.
import { deviceName, getDevice, routerNeighbors, segmentOf } from '../model/topology';
import type { Topology } from '../model/types';
import type { Frame, Pending, SimEvent, SimState } from './types';

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type NewPending = DistributiveOmit<Pending, 'seq'>;

export function push(s: SimState, p: NewPending) {
  s.queue.push({ ...p, seq: s.seq++ } as Pending);
}

/** Earliest time first; equal times are processed in the order they were scheduled. */
export function popNext(s: SimState): Pending | undefined {
  if (s.queue.length === 0) return undefined;
  let best = 0;
  for (let i = 1; i < s.queue.length; i++) {
    const a = s.queue[i];
    const b = s.queue[best];
    if (a.t < b.t || (a.t === b.t && a.seq < b.seq)) best = i;
  }
  return s.queue.splice(best, 1)[0];
}

/** Copy everything that changes during a step. The topology is immutable and shared. */
export function cloneState(s: SimState): SimState {
  const { topo, ...rest } = s;
  const c = structuredClone(rest) as Omit<SimState, 'topo'>;
  return { ...c, topo };
}

export function frame(state: SimState, ev: Omit<SimEvent, 'time'>): Frame {
  return { ev: { ...ev, time: state.time }, state };
}

export const nm = (s: SimState, id: string) => deviceName(s.topo, id);

/** Devices crossed between two routers on an adjacency (for animating through switches). */
export function adjPath(topo: Topology, from: string, key: string): string[] | undefined {
  return routerNeighbors(topo, from).find((n) => n.key === key)?.path;
}

/** Routers affected when links change: the routers on the links and every router on a switch they touch. */
export function affectedRouters(topos: Topology[], linkIds: string[]): string[] {
  const out = new Set<string>();
  for (const topo of topos) {
    for (const id of linkIds) {
      const l = topo.links.find((x) => x.id === id);
      if (!l) continue;
      for (const end of [l.a, l.b]) {
        const d = getDevice(topo, end.dev);
        if (!d) continue;
        if (d.kind === 'router') out.add(d.id);
        if (d.kind === 'switch')
          for (const port of d.ifaces) for (const ep of segmentOf(topo, d.id, port.id).endpoints) if (ep.dev.kind === 'router') out.add(ep.dev.id);
      }
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

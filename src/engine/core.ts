// Deterministic event queue helpers shared by the protocol engines.
import { deviceName } from '../model/topology';
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

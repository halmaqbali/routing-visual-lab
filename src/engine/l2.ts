// Layer 2 data-plane state: ARP caches on routers/PCs and MAC address tables on switches.
// This state is learned by traffic (pings) and never changes routing tables.
import { linkOfIface } from '../model/topology';
import type { Topology } from '../model/types';

export interface MacEntry {
  mac: string;
  /** Switch port (interface id) where frames from this MAC arrive. */
  port: string;
  learnedAt: number;
}

export interface ArpEntry {
  mac: string;
  learnedAt: number;
}

export interface L2State {
  /** device id → (IP → MAC) */
  arp: Record<string, Record<string, ArpEntry>>;
  /** switch id → learned MAC table */
  mac: Record<string, MacEntry[]>;
}

/** Switch MAC-table aging time (time units; seconds in the RIP profile; Cisco default is 300 s). */
export const MAC_AGING = 300;

export const emptyL2 = (): L2State => ({ arp: {}, mac: {} });

export function cloneL2(l2: L2State): L2State {
  return structuredClone(l2);
}

/** Remove MAC entries whose port link is down (the switch forgets them, so they must be relearned). */
export function flushDownPorts(l2: L2State, topo: Topology): L2State {
  const out = cloneL2(l2);
  for (const sw of Object.keys(out.mac)) {
    out.mac[sw] = out.mac[sw].filter((e) => linkOfIface(topo, sw, e.port)?.up);
  }
  return out;
}

/** Remove entries older than the aging time. Returns the MACs that aged out. */
export function ageMacTable(l2: L2State, sw: string, now: number): string[] {
  const t = l2.mac[sw] ?? [];
  const old = t.filter((e) => now - e.learnedAt > MAC_AGING).map((e) => e.mac);
  l2.mac[sw] = t.filter((e) => now - e.learnedAt <= MAC_AGING);
  return old;
}

export function l2EntryCount(l2: L2State) {
  return {
    arp: Object.values(l2.arp).reduce((n, t) => n + Object.keys(t).length, 0),
    mac: Object.values(l2.mac).reduce((n, t) => n + t.length, 0),
  };
}

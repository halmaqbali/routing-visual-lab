import type { SimOptions, Topology } from '../src/model/types';
import { DEFAULT_OPTIONS } from '../src/model/types';
import type { Tables } from '../src/engine/rib';
import { routeKey } from '../src/engine/rib';

export function opts(dv: Partial<SimOptions['dv']> = {}, ttl = 16): SimOptions {
  return { ...DEFAULT_OPTIONS, ttl, dv: { ...DEFAULT_OPTIONS.dv, ...dv } };
}

export function route(tables: Tables, router: string, key: string) {
  return tables[router]?.find((r) => routeKey(r) === key);
}

export function setLink(topo: Topology, a: string, b: string, patch: { up?: boolean; cost?: number }): { topo: Topology; id: string } {
  const t = structuredClone(topo);
  const l = t.links.find((x) => (x.a.dev === a && x.b.dev === b) || (x.a.dev === b && x.b.dev === a))!;
  Object.assign(l, patch);
  return { topo: t, id: l.id };
}

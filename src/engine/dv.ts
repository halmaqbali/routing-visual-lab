// Event-driven distance-vector routing (generic weighted costs, or a RIP hop-count profile).
//
// Metric convention (both profiles): a directly connected network has cost 0 at the router that
// owns it. A receiver computes   candidate = cost of the link to the neighbour + neighbour's advertised cost.
// RIP profile: every link costs 1 hop, 15 is the largest usable metric and 16 means unreachable.
import { routeKey, sortTable, connectedRoutes, AD, type Route, type Table, diffTable, type Change } from './rib';
import { RIP_INFINITY, RIP_UPDATE_INTERVAL, type SimOptions, type Topology } from '../model/types';
import { routerNeighbors, routers, type Neighbor } from '../model/topology';
import { adjPath, affectedRouters, cloneState, frame, nm, popNext, push } from './core';
import type { Advert, DvCalcRow, Frame, Pending, SimState } from './types';
import { dvView, macFn } from './packets';

export const UPDATE_INTERVAL = RIP_UPDATE_INTERVAL;

export function dvInfinity(o: SimOptions) {
  return o.dv.profile === 'rip' ? RIP_INFINITY : o.dv.genericInfinity;
}

export function dvCost(o: SimOptions, linkCost: number) {
  return o.dv.profile === 'rip' ? 1 : linkCost;
}

const metricText = (m: number, inf: number) => (m >= inf ? `∞ (${inf})` : String(m));

export function dvInit(base: SimState): Frame[] {
  const s = cloneState(base);
  s.dv = { infinity: dvInfinity(s.options), rounds: 0, changedSinceRound: true, converged: false };
  const before = s.tables;
  s.tables = Object.fromEntries(routers(s.topo).map((r) => [r.id, sortTable(connectedRoutes(s.topo, r.id))]));
  const changes = routers(s.topo).flatMap((r) => diffTable(r.id, before[r.id] ?? [], s.tables[r.id]));
  push(s, { t: 0, type: 'round' });
  const profile = s.options.dv.profile === 'rip' ? 'RIP profile (hop count, 16 = unreachable)' : `generic weighted costs (infinity = ${s.dv.infinity})`;
  return [
    frame(s, {
      kind: 'dv-init',
      category: 'config',
      title: 'Start: routers know only their connected networks',
      explain: `Each router begins with ONLY its directly connected networks (cost 0). Nobody has a map of the network. They will learn remote networks from their neighbours' advertisements. Model: ${profile}.`,
      changes,
    }),
  ];
}

/** RIP-style route timeout: a learned route that is not re-advertised by its next hop for this long becomes unreachable. */
export const ROUTE_TIMEOUT = 180;

function localIfaceOn(topo: Topology, router: string, linkId: string) {
  const nb = routerNeighbors(topo, router).find((n) => n.key === linkId);
  if (nb) return nb.localIface.id;
  const l = topo.links.find((x) => x.id === linkId);
  if (!l) return null;
  return l.a.dev === router ? l.a.iface : l.b.dev === router ? l.b.iface : null;
}

/** Build what `from` advertises to neighbour `to` over a link, applying split horizon / poison reverse. */
export function buildAdverts(s: SimState, from: string, to: string, linkId: string, keys?: string[]): { adverts: Advert[]; omitted: string[] } {
  const inf = s.dv!.infinity;
  const myIf = localIfaceOn(s.topo, from, linkId);
  const adverts: Advert[] = [];
  const omitted: string[] = [];
  for (const r of s.tables[from] ?? []) {
    const k = routeKey(r);
    if (keys && !keys.includes(k)) continue;
    const metric = r.unreachable ? inf : Math.min(r.metric, inf);
    const learnedHere = r.source === 'dv' && r.learnedFrom === to && r.iface === myIf;
    if (learnedHere && s.options.dv.poisonReverse) {
      adverts.push({ network: r.network, prefix: r.prefix, metric: inf, poisoned: true });
      continue;
    }
    if (learnedHere && s.options.dv.splitHorizon) {
      omitted.push(k);
      continue;
    }
    adverts.push({ network: r.network, prefix: r.prefix, metric });
  }
  return { adverts, omitted };
}

function sendTo(s: SimState, from: string, nb: Neighbor, triggered: boolean, keys?: string[]) {
  const { adverts, omitted } = buildAdverts(s, from, nb.router, nb.key, keys);
  if (adverts.length === 0 && omitted.length === 0) return;
  push(s, { t: s.time + 1, type: 'dv-deliver', from, to: nb.router, linkId: nb.key, adverts, omitted, triggered });
}

function scheduleTriggered(s: SimState, router: string, keys: string[]) {
  if (!s.options.dv.triggeredUpdates || keys.length === 0) return;
  const existing = s.queue.find((q): q is Extract<Pending, { type: 'triggered' }> => q.type === 'triggered' && q.router === router && q.t === s.time);
  if (existing) existing.keys = [...new Set([...existing.keys, ...keys])];
  else push(s, { t: s.time, type: 'triggered', router, keys });
}

function ensureRounds(s: SimState) {
  s.done = false;
  s.dv!.converged = false;
  s.dv!.changedSinceRound = true;
  if (!s.queue.some((q) => q.type === 'round')) push(s, { t: (Math.floor(s.time / UPDATE_INTERVAL) + 1) * UPDATE_INTERVAL, type: 'round' });
}

/** Receiver processing of one distance-vector update. Exported for unit tests. */
export function processUpdate(s: SimState, to: string, from: string, linkId: string, adverts: Advert[]): { rows: DvCalcRow[]; table: Table; ok: boolean } {
  const inf = s.dv!.infinity;
  const nb = routerNeighbors(s.topo, to).find((n) => n.router === from && n.key === linkId);
  const table = [...(s.tables[to] ?? [])];
  if (!nb) return { rows: [], table, ok: false };
  const c = dvCost(s.options, nb.cost);
  const fromName = nm(s, from);
  const rows: DvCalcRow[] = [];
  for (const a of adverts) {
    const k = routeKey(a);
    const cand = a.metric >= inf ? inf : Math.min(a.metric + c, inf);
    const idx = table.findIndex((r) => routeKey(r) === k);
    const cur = idx >= 0 ? table[idx] : undefined;
    const curText = !cur ? 'no route' : cur.source === 'connected' ? 'connected (0)' : `${metricText(cur.unreachable ? inf : cur.metric, inf)} via ${nm(s, cur.learnedFrom ?? '')}`;
    const calc = a.metric >= inf ? `${fromName} says unreachable → candidate ∞` : `${c} + ${a.metric} = ${metricText(cand, inf)}`;
    const route: Route = { network: a.network, prefix: a.prefix, source: 'dv', nextHop: nb.remoteIface.ip, iface: nb.localIface.id, metric: cand, ad: AD.dv, learnedFrom: from, unreachable: cand >= inf || undefined, refreshedAt: s.time };
    const row = (decision: DvCalcRow['decision'], text: string) => rows.push({ key: k, advertised: a.metric, linkCost: c, candidate: cand, current: curText, decision, text: `${k}: ${calc}. ${text}` });
    if (cur?.source === 'connected') {
      row('connected', 'Directly connected here (cost 0) — keep the connected route.');
    } else if (!cur) {
      if (cand >= inf) row('unreachable', 'Unreachable and not in the table — nothing to learn.');
      else {
        table.push(route);
        row('new', `New network! Add it: next hop ${fromName}, cost ${cand}.`);
      }
    } else if (cur.learnedFrom === from && cur.iface === nb.localIface.id) {
      const curM = cur.unreachable ? inf : cur.metric;
      if (curM === cand) {
        table[idx] = { ...cur, refreshedAt: s.time };
        row('refresh', `Same as the current route via ${fromName} — no change (the route's timeout restarts).`);
      }
      else {
        table[idx] = route;
        row('update-same', cand >= inf
          ? `The current next hop ${fromName} now reports it unreachable — mark the route unreachable.`
          : `The current next hop ${fromName} changed its cost, so accept it even though it is ${cand > curM ? 'worse' : 'better'}: ${metricText(curM, inf)} → ${cand}.`);
      }
    } else {
      const curM = cur.unreachable ? inf : cur.metric;
      if (cand < curM) {
        table[idx] = route;
        row('better', `Better than the current ${curText}. Switch next hop to ${fromName}, cost ${cand}.`);
      } else if (cand === curM && cand < inf) row('equal', `Equal to the current cost — keep the existing route (no load sharing in this model).`);
      else row('worse', `Not better than the current ${curText} — ignore.`);
    }
  }
  return { rows, table: sortTable(table), ok: true };
}

export function dvStep(prev: SimState): Frame[] {
  const s = cloneState(prev);
  const p = popNext(s);
  if (!p) {
    s.done = true;
    return [];
  }
  s.time = Math.max(s.time, p.t);
  const inf = s.dv!.infinity;

  if (p.type === 'round') {
    const pendingWork = s.queue.some((q) => q.type !== 'round');
    // A learned route that was not refreshed in the last round is waiting for its timeout: not converged yet.
    const awaitingTimeout = Object.values(s.tables).some((t) => t.some((x) => x.source === 'dv' && !x.unreachable && x.refreshedAt !== undefined && x.refreshedAt < s.time - UPDATE_INTERVAL - 1));
    if (s.dv!.rounds > 0 && !s.dv!.changedSinceRound && !pendingWork && !awaitingTimeout) {
      s.dv!.converged = true;
      s.done = true;
      return [frame(s, {
        kind: 'dv-converged', category: 'info', title: 'Converged',
        explain: `A full round of periodic updates changed nothing, so every router agrees on the best routes: the network has converged (after ${s.dv!.rounds} update round${s.dv!.rounds === 1 ? '' : 's'}). Real routers keep sending periodic updates; the simulation stops here.`,
      })];
    }
    // Route timeout: learned routes whose next hop has stopped advertising them become unreachable.
    const timeoutFrames: Frame[] = [];
    for (const r of routers(s.topo)) {
      const old = s.tables[r.id] ?? [];
      const expired = old.filter((x) => x.source === 'dv' && !x.unreachable && x.learnedFrom && x.refreshedAt !== undefined && s.time - x.refreshedAt > ROUTE_TIMEOUT);
      if (!expired.length) continue;
      const table = old.map((x) => (expired.includes(x) ? { ...x, unreachable: true, metric: inf, note: `Timed out: not heard from ${nm(s, x.learnedFrom!)} for more than ${ROUTE_TIMEOUT} time units` } : x));
      const changes = diffTable(r.id, old, table);
      s.tables[r.id] = table;
      s.dv!.changedSinceRound = true;
      scheduleTriggered(s, r.id, changes.map((c) => c.key));
      timeoutFrames.push(frame(s, {
        kind: 'dv-timeout', category: 'control', title: `${r.name}: route timeout`, routers: [r.id],
        explain: `${r.name} has not heard ${expired.map((x) => `${routeKey(x)} from ${nm(s, x.learnedFrom!)}`).join(', ')} for more than ${ROUTE_TIMEOUT} time units (RIP's 180-second timeout). The neighbour may have disappeared, so the route is marked unreachable.`,
        changes,
      }));
    }
    s.dv!.rounds++;
    s.dv!.changedSinceRound = timeoutFrames.length > 0;
    let count = 0;
    for (const r of routers(s.topo)) {
      for (const nb of routerNeighbors(s.topo, r.id)) {
        sendTo(s, r.id, nb, false);
        count++;
      }
    }
    push(s, { t: s.time + UPDATE_INTERVAL, type: 'round' });
    return [...timeoutFrames.map((f) => ({ ...f, state: cloneState(f.state) })), frame(s, {
      kind: 'dv-round', category: 'control', title: `Update timer: periodic round ${s.dv!.rounds}`,
      explain: `The update timer expired (every ${UPDATE_INTERVAL} time units). Each router sends its current distance vector — a list of "network, cost" pairs — to each neighbour. ${count} updates are now on their way (each takes 1 time unit).`,
    })];
  }

  if (p.type === 'triggered' || p.type === 'full-update') {
    const nbs = routerNeighbors(s.topo, p.router).filter((n) => p.type === 'triggered' || n.router === p.to);
    for (const nb of nbs) sendTo(s, p.router, nb, true, p.type === 'triggered' ? p.keys : undefined);
    const what = p.type === 'triggered' ? `about ${p.keys.join(', ')}` : `with its full table to ${nm(s, p.to)} (new neighbour)`;
    return [frame(s, {
      kind: 'dv-triggered', category: 'control', title: `${nm(s, p.router)} sends a triggered update`, routers: [p.router],
      explain: `Triggered updates are ON: ${nm(s, p.router)}'s table just changed, so it immediately tells its neighbours ${what}, instead of waiting for the next periodic update.`,
    })];
  }

  if (p.type === 'dv-deliver') {
    const { rows, table, ok } = processUpdate(s, p.to, p.from, p.linkId, p.adverts);
    const fromN = nm(s, p.from);
    const toN = nm(s, p.to);
    if (!ok) {
      return [frame(s, {
        kind: 'dv-lost', category: 'control', title: `Update ${fromN} → ${toN} lost`, routers: [p.to],
        explain: `The link between ${fromN} and ${toN} is down, so this update never arrives.`,
        anim: { from: p.from, to: p.to, linkId: p.linkId, style: 'dv', drop: true, label: 'DV', path: adjPath(prev.topo, p.from, p.linkId) },
      })];
    }
    const changes: Change[] = diffTable(p.to, s.tables[p.to] ?? [], table);
    s.tables[p.to] = table;
    if (changes.length) {
      s.dv!.changedSinceRound = true;
      scheduleTriggered(s, p.to, changes.map((c) => c.key));
    }
    const advText = p.adverts.map((a) => `${routeKey(a)}=${metricText(a.metric, inf)}${a.poisoned ? ' (poison reverse)' : ''}`).join(', ');
    const summary = changes.length === 0 ? `${toN}'s table does not change.` : `${toN} changes ${changes.length} route${changes.length > 1 ? 's' : ''}: ${changes.map((c) => c.key).join(', ')}.`;
    const sh = p.omitted.length ? ` Split horizon: ${fromN} did not advertise ${p.omitted.join(', ')} back to ${toN}, because it learned those routes from ${toN}.` : '';
    const poison = p.adverts.some((a) => a.poisoned) ? ` Poison reverse: ${fromN} advertised routes it learned from ${toN} back as unreachable.` : '';
    return [frame(s, {
      kind: 'dv-update', category: 'control', title: `${fromN} → ${toN}: ${p.triggered ? 'triggered' : 'periodic'} update`, routers: [p.to, p.from],
      explain: `${toN} receives ${fromN}'s distance vector. ${fromN} only says HOW FAR it is from each network, not the path. ${toN} adds the cost of the link to ${fromN} to every advertised cost and keeps the cheapest option. ${summary}${sh}${poison}`,
      detail: [`Advertised: ${advText || '(nothing)'}`, ...rows.map((r) => r.text)],
      anim: { from: p.from, to: p.to, linkId: p.linkId, style: 'dv', label: p.triggered ? 'DV!' : 'DV', path: adjPath(s.topo, p.from, p.linkId) },
      changes,
      dv: { from: p.from, to: p.to, adverts: p.adverts, omitted: p.omitted, rows, triggered: p.triggered },
      packet: dvView(s.topo, p.from, p.to, p.linkId, p.adverts, s.options.dv.profile === 'rip', inf, p.triggered, macFn(s.topo)),
    })];
  }
  return [];
}

/** React to links that were enabled, disabled or changed cost while the simulation runs. */
export function dvLinkChange(prev: SimState, newTopo: Topology, linkIds: string[]): Frame[] {
  const frames: Frame[] = [];
  let s = cloneState(prev);
  const oldTopo = s.topo;
  s.topo = newTopo;
  const inf = s.dv!.infinity;
  const affected = affectedRouters([oldTopo, newTopo], linkIds);
  for (const r of affected) {
    const old = s.tables[r] ?? [];
    const conn = connectedRoutes(newTopo, r);
    const connKeys = new Set(conn.map(routeKey));
    const next: Table = [];
    for (const route of old) {
      const k = routeKey(route);
      if (connKeys.has(k)) continue; // reinstalled below
      if (route.source === 'connected') {
        next.push({ ...route, source: 'dv', unreachable: true, metric: inf, ad: AD.dv, note: 'Interface went down' });
      } else if (!route.unreachable && route.iface && !conn.some((c) => c.iface === route.iface)) {
        next.push({ ...route, unreachable: true, metric: inf, note: 'Exit interface went down' });
      } else next.push(route);
    }
    next.push(...conn);
    const table = sortTable(next);
    const changes = diffTable(r, old, table);
    s.tables[r] = table;
    if (changes.length) {
      frames.push(frame(s, {
        kind: 'dv-detect', category: 'control', title: `${nm(s, r)} detects an interface change`, routers: [r],
        explain: `${nm(s, r)} notices the change on its own interface. Connected networks that went down, and routes that used that interface, are marked unreachable (∞ = ${inf}). Routes that came up are added as connected. Other routers do not know yet — they only find out from advertisements.`,
        changes,
      }));
      scheduleTriggered(s, r, changes.map((c) => c.key));
      s = cloneState(s);
    }
  }
  // A new adjacency (link up, or a router joining a switch): both routers send their full table at once (if triggered updates are on).
  if (s.options.dv.triggeredUpdates) {
    for (const r of affected) {
      const before = new Set(routerNeighbors(oldTopo, r).map((n) => n.key));
      for (const nb of routerNeighbors(newTopo, r)) if (!before.has(nb.key)) push(s, { t: s.time, type: 'full-update', router: r, to: nb.router });
    }
  }
  ensureRounds(s);
  if (frames.length === 0) {
    frames.push(frame(s, { kind: 'dv-detect', category: 'info', title: 'No immediate table change', explain: 'The routers on this link have no route that changes immediately. Any cost change is used when the next advertisement arrives.' }));
  } else frames[frames.length - 1] = { ...frames[frames.length - 1], state: s };
  return frames;
}

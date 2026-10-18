// Simplified link-state routing (OSPF-inspired teaching model) with Dijkstra's SPF.
// Stages: discover neighbours → describe links → originate LSA → flood → LSDB → SPF → install routes.
import { cidr, networkOf } from '../model/ip';
import { getDevice, routerNeighbors, routers } from '../model/topology';
import type { Topology } from '../model/types';
import { adjPath, affectedRouters, cloneState, frame, nm, popNext, push } from './core';
import { AD, connectedRoutes, diffTable, routeKey, sortTable, type Route, type Table } from './rib';
import type { Frame, LsRouterState, Lsa, SimState, SpfRelax, SpfResult, SpfStep } from './types';
import { lsuView, macFn, ospfHelloView } from './packets';

export const SPF_DELAY = 5;

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function lsr(s: SimState, r: string): LsRouterState {
  const ls = s.ls!;
  if (!ls.routers[r]) ls.routers[r] = { neighbors: [], lsdb: {}, seq: 0, spf: null };
  return ls.routers[r];
}

/** The LSA a router would originate from its current neighbours and connected networks. */
export function describeLinks(s: SimState, r: string): Omit<Lsa, 'seq'> {
  const st = lsr(s, r);
  return {
    origin: r,
    links: st.neighbors.map((n) => ({ to: n.router, linkId: n.linkId, cost: n.cost })),
    stubs: connectedRoutes(s.topo, r).map((c) => ({ network: c.network, prefix: c.prefix })),
  };
}

export function lsInit(base: SimState): Frame[] {
  const s = cloneState(base);
  s.ls = { routers: {} };
  s.tables = {};
  for (const r of routers(s.topo)) {
    lsr(s, r.id);
    s.tables[r.id] = sortTable(connectedRoutes(s.topo, r.id));
  }
  const seen = new Set<string>();
  for (const r of routers(s.topo))
    for (const nb of routerNeighbors(s.topo, r.id))
      if (!seen.has(nb.key)) {
        seen.add(nb.key);
        push(s, { t: 0, type: 'hello', key: nb.key, a: r.id, b: nb.router });
      }
  for (const r of routers(s.topo)) push(s, { t: 0, type: 'describe', router: r.id });
  for (const r of routers(s.topo)) push(s, { t: 0, type: 'originate', router: r.id, reason: 'initial' });
  return [frame(s, {
    kind: 'ls-init', category: 'config', title: 'Start: connected networks only',
    explain: 'Each router starts with its connected networks. In link state routing every router will collect a full map of the network (the link-state database) and calculate its own shortest paths with Dijkstra\'s algorithm.',
  })];
}


function flood(s: SimState, from: string, lsa: Lsa, except?: string) {
  for (const n of lsr(s, from).neighbors) if (n.router !== except) push(s, { t: s.time + 1, type: 'lsa-deliver', from, to: n.router, linkId: n.linkId, lsa });
}

function scheduleSpf(s: SimState, r: string) {
  s.queue = s.queue.filter((q) => !(q.type === 'spf' && q.router === r));
  push(s, { t: s.time + SPF_DELAY, type: 'spf', router: r });
}

const lsaText = (s: SimState, l: Lsa) =>
  `LSA ${nm(s, l.origin)} #${l.seq}: ${l.links.map((x) => `${nm(s, x.to)} cost ${x.cost}`).join(', ') || 'no router neighbours'}; networks ${l.stubs.map((x) => cidr(x.network, x.prefix)).join(', ') || 'none'}`;

// ---------------------------------------------------------------- Dijkstra

/** Dijkstra from `root` over the LSDB. A link is used only if BOTH routers list it (two-way check). */
export function dijkstra(root: string, lsdb: Record<string, Lsa>, nameOf: (id: string) => string = (x) => x): SpfResult {
  const edges: SpfResult['edges'] = [];
  const adj: Record<string, { to: string; linkId: string; cost: number }[]> = {};
  for (const u of Object.keys(lsdb).sort(byName)) {
    for (const l of lsdb[u].links) {
      const back = lsdb[l.to]?.links.some((x) => x.to === u && x.linkId === l.linkId);
      if (!back) continue;
      (adj[u] ??= []).push({ to: l.to, linkId: l.linkId, cost: l.cost });
      if (byName(u, l.to) < 0) edges.push({ a: u, b: l.to, linkId: l.linkId, cost: l.cost });
    }
  }
  const dist: Record<string, number> = { [root]: 0 };
  const pred: SpfResult['pred'] = { [root]: null };
  const confirmed: string[] = [];
  const steps: SpfStep[] = [];
  const tentative = new Set<string>([root]);
  while (tentative.size) {
    const sel = [...tentative].sort((a, b) => dist[a] - dist[b] || byName(a, b))[0];
    tentative.delete(sel);
    confirmed.push(sel);
    const relax: SpfRelax[] = [];
    for (const e of (adj[sel] ?? []).slice().sort((a, b) => byName(a.to, b.to) || a.cost - b.cost)) {
      const nd = dist[sel] + e.cost;
      const old = e.to in dist ? dist[e.to] : null;
      const calc = `${nameOf(sel)} (${dist[sel]}) + link ${e.cost} = ${nd}`;
      if (confirmed.includes(e.to)) {
        relax.push({ node: e.to, via: sel, linkId: e.linkId, cost: e.cost, oldDist: old, newDist: nd, outcome: 'confirmed', text: `${nameOf(e.to)} is already confirmed (${old}) — skip.` });
      } else if (old === null) {
        dist[e.to] = nd;
        pred[e.to] = { node: sel, linkId: e.linkId };
        tentative.add(e.to);
        relax.push({ node: e.to, via: sel, linkId: e.linkId, cost: e.cost, oldDist: null, newDist: nd, outcome: 'new', text: `${nameOf(e.to)}: ${calc}. First path found → tentative ${nd} via ${nameOf(sel)}.` });
      } else if (nd < old) {
        dist[e.to] = nd;
        pred[e.to] = { node: sel, linkId: e.linkId };
        relax.push({ node: e.to, via: sel, linkId: e.linkId, cost: e.cost, oldDist: old, newDist: nd, outcome: 'improved', text: `${nameOf(e.to)}: ${calc} < ${old}. Better! Predecessor changes to ${nameOf(sel)}.` });
      } else {
        relax.push({ node: e.to, via: sel, linkId: e.linkId, cost: e.cost, oldDist: old, newDist: nd, outcome: 'not-better', text: `${nameOf(e.to)}: ${calc} is not better than ${old} — keep.` });
      }
    }
    steps.push({
      selected: sel,
      selectedDist: dist[sel],
      confirmed: [...confirmed],
      tentative: Object.fromEntries([...tentative].sort(byName).map((n) => [n, { dist: dist[n], pred: pred[n]?.node ?? null }])),
      relax,
    });
  }
  const firstHop: SpfResult['firstHop'] = {};
  for (const n of confirmed) {
    if (n === root) continue;
    let cur = n;
    let guard = 0;
    while (pred[cur] && pred[cur]!.node !== root && guard++ < 100) cur = pred[cur]!.node;
    if (pred[cur]) firstHop[n] = { router: cur, linkId: pred[cur]!.linkId };
  }
  const fdist: Record<string, number> = {};
  for (const n of confirmed) fdist[n] = dist[n];
  return { root, dist: fdist, pred: Object.fromEntries(confirmed.map((n) => [n, pred[n]])), steps, firstHop, edges };
}

/** Turn an SPF tree into routes: every network advertised by a reachable router. */
export function spfRoutes(topo: Topology, root: string, spf: SpfResult, lsdb: Record<string, Lsa>): Table {
  const conn = connectedRoutes(topo, root);
  const connKeys = new Set(conn.map(routeKey));
  const best = new Map<string, Route>();
  const origins = Object.keys(spf.dist).filter((o) => o !== root).sort((a, b) => spf.dist[a] - spf.dist[b] || byName(a, b));
  const rootNbrs = routerNeighbors(topo, root);
  for (const o of origins) {
    const fh = spf.firstHop[o];
    if (!fh) continue;
    const adj = rootNbrs.find((n) => n.key === fh.linkId);
    if (!adj) continue;
    const myEnd = { iface: adj.localIface.id };
    const nhIp = adj.remoteIface.ip;
    for (const st of lsdb[o]?.stubs ?? []) {
      const k = cidr(st.network, st.prefix);
      if (connKeys.has(k) || best.has(k)) continue;
      const path: string[] = [];
      let c: string | undefined = o;
      while (c) {
        path.unshift(getDevice(topo, c)?.name ?? c);
        c = spf.pred[c]?.node;
      }
      best.set(k, {
        network: st.network, prefix: st.prefix, source: 'ls', nextHop: nhIp, iface: myEnd.iface, metric: spf.dist[o], ad: AD.ls, learnedFrom: fh.router,
        note: `Shortest path ${path.join(' → ')} (cost ${spf.dist[o]}); ${cidr(networkOf(st.network, st.prefix), st.prefix)} is attached to ${getDevice(topo, o)?.name}.`,
      });
    }
  }
  return sortTable([...conn, ...best.values()]);
}

// ---------------------------------------------------------------- events

export function lsStep(prev: SimState): Frame[] {
  let s = cloneState(prev);
  const p = popNext(s);
  if (!p) {
    s.done = true;
    return [];
  }
  s.time = Math.max(s.time, p.t);
  s.spfView = null;

  if (p.type === 'hello') {
    const { a, b } = p;
    let cost = 1;
    let viaSwitch = false;
    for (const r of [a, b]) {
      const nb = routerNeighbors(s.topo, r).find((n) => n.key === p.key);
      if (!nb) continue;
      if (r === a) {
        cost = nb.cost;
        viaSwitch = nb.path.length > 2;
      }
      const st = lsr(s, r);
      st.neighbors = st.neighbors.filter((n) => n.linkId !== p.key);
      st.neighbors.push({ router: nb.router, linkId: nb.key, cost: nb.cost, localIface: nb.localIface.id, remoteIp: nb.remoteIface.ip });
      st.neighbors.sort((x, y) => byName(x.router, y.router));
    }
    return [frame(s, {
      kind: 'ls-hello', category: 'lsa', title: `Hello: ${nm(s, a)} ↔ ${nm(s, b)} become neighbours`, routers: [a, b],
      explain: `${nm(s, a)} and ${nm(s, b)} exchange Hello messages ${viaSwitch ? 'across the switch (they are on the same LAN)' : 'on their shared link'} and see each other, so they become neighbours. Interface cost: ${cost}. (Simplified: no hello/dead timers, no DR election.)`,
      anim: { from: a, to: b, linkId: p.key, style: 'hello', label: 'Hello', path: adjPath(s.topo, a, p.key) },
      packet: ospfHelloView(s.topo, a, b, p.key, macFn(s.topo)),
    })];
  }

  if (p.type === 'describe') {
    const d = describeLinks(s, p.router);
    return [frame(s, {
      kind: 'ls-describe', category: 'lsa', title: `${nm(s, p.router)} describes its local links`, routers: [p.router],
      explain: `${nm(s, p.router)} lists what it knows FIRST-HAND: neighbours ${d.links.map((x) => `${nm(s, x.to)} (cost ${x.cost})`).join(', ') || 'none'}, and its connected networks ${d.stubs.map((x) => cidr(x.network, x.prefix)).join(', ') || 'none'}.`,
    })];
  }

  if (p.type === 'originate') {
    const st = lsr(s, p.router);
    st.seq += 1;
    const lsa: Lsa = { ...describeLinks(s, p.router), seq: st.seq };
    st.lsdb[p.router] = lsa;
    flood(s, p.router, lsa);
    scheduleSpf(s, p.router);
    return [frame(s, {
      kind: 'ls-originate', category: 'lsa', title: `${nm(s, p.router)} originates LSA #${lsa.seq}`, routers: [p.router],
      explain: `${nm(s, p.router)} packs its link description into a link-state advertisement (LSA) with sequence number ${lsa.seq}${p.reason !== 'initial' ? ` because ${p.reason}` : ''}, stores it in its own database and sends it to every neighbour. A higher sequence number means newer information.`,
      detail: [lsaText(s, lsa)],
      lsa: { lsa, installed: true },
    })];
  }

  if (p.type === 'lsa-deliver') {
    const fromN = nm(s, p.from);
    const toN = nm(s, p.to);
    if (!routerNeighbors(s.topo, p.to).some((n) => n.key === p.linkId && n.router === p.from)) {
      return [frame(s, {
        kind: 'ls-lost', category: 'lsa', title: `LSA ${fromN} → ${toN} lost`, routers: [p.to],
        explain: `The link is down, so ${toN} never receives this LSA.`,
        anim: { from: p.from, to: p.to, linkId: p.linkId, style: 'lsa', drop: true, label: 'LSA', path: adjPath(prev.topo, p.from, p.linkId) },
      })];
    }
    const st = lsr(s, p.to);
    const have = st.lsdb[p.lsa.origin];
    const owner = nm(s, p.lsa.origin);
    if (!have || p.lsa.seq > have.seq) {
      st.lsdb[p.lsa.origin] = p.lsa;
      flood(s, p.to, p.lsa, p.from);
      scheduleSpf(s, p.to);
      const total = Object.keys(st.lsdb).length;
      return [frame(s, {
        kind: 'ls-flood', category: 'lsa', title: `${toN} receives ${owner}'s LSA #${p.lsa.seq}`, routers: [p.to],
        explain: `${toN} gets ${owner}'s LSA from ${fromN}. It is ${have ? `newer than the stored #${have.seq}` : 'new'}, so ${toN} stores it (its database now holds ${total} LSA${total > 1 ? 's' : ''}) and floods an unchanged copy to its other neighbours. The LSA is NOT modified: every router gets the same original description.`,
        detail: [lsaText(s, p.lsa)],
        anim: { from: p.from, to: p.to, linkId: p.linkId, style: 'lsa', label: `LSA ${owner}`, path: adjPath(s.topo, p.from, p.linkId) },
        lsa: { lsa: p.lsa, installed: true },
        packet: lsuView(s.topo, p.from, p.to, p.linkId, p.lsa, macFn(s.topo)),
      })];
    }
    return [frame(s, {
      kind: 'ls-dup', category: 'lsa', title: `${toN} discards a duplicate of ${owner}'s LSA`, routers: [p.to],
      explain: `${toN} already has ${owner}'s LSA #${have.seq}, so the copy from ${fromN} is not new. It is discarded and NOT flooded again — this is what stops flooding from going on forever.`,
      anim: { from: p.from, to: p.to, linkId: p.linkId, style: 'lsa', label: `LSA ${owner}`, path: adjPath(s.topo, p.from, p.linkId) },
      lsa: { lsa: p.lsa, installed: false },
      packet: lsuView(s.topo, p.from, p.to, p.linkId, p.lsa, macFn(s.topo)),
    })];
  }

  if (p.type === 'spf') {
    const r = p.router;
    const rn = nm(s, r);
    const st = lsr(s, r);
    const spf = dijkstra(r, st.lsdb, (id) => nm(s, id));
    st.spf = spf;
    const frames: Frame[] = [];
    s.spfView = { router: r, step: 0 };
    frames.push(frame(s, {
      kind: 'spf-start', category: 'spf', title: `${rn} runs SPF (Dijkstra) with itself as the root`, routers: [r],
      explain: `${rn}'s database has ${Object.keys(st.lsdb).length} LSAs and has been quiet for ${SPF_DELAY} time units, so ${rn} calculates shortest paths. Every router does this separately, always with ITSELF as the starting point (root). A link is only used if both routers on it advertise it.`,
      spf: { router: r, step: 0, total: spf.steps.length },
    }));
    spf.steps.forEach((step, i) => {
      s = cloneState(s);
      s.spfView = { router: r, step: i + 1 };
      const improved = step.relax.filter((x) => x.outcome === 'improved' || x.outcome === 'new');
      frames.push(frame(s, {
        kind: 'spf-step', category: 'spf', title: `${rn} SPF step ${i + 1}: confirm ${nm(s, step.selected)} (cost ${step.selectedDist})`, routers: [r],
        explain: `${nm(s, step.selected)} has the lowest tentative cost (${step.selectedDist}), so its shortest path is now confirmed. Then ${rn} checks ${nm(s, step.selected)}'s neighbours: ${step.relax.length ? step.relax.map((x) => x.text).join(' ') : 'no unconfirmed neighbours.'}${improved.length === 0 && step.relax.length ? ' No tentative cost improved.' : ''}`,
        spf: { router: r, step: i + 1, total: spf.steps.length },
      }));
    });
    s = cloneState(s);
    const table = spfRoutes(s.topo, r, spf, st.lsdb);
    const changes = diffTable(r, s.tables[r] ?? [], table);
    s.tables[r] = table;
    s.spfView = { router: r, step: spf.steps.length };
    const fhText = Object.entries(spf.firstHop).sort(([a], [b]) => byName(a, b)).map(([n, f]) => `${nm(s, n)} via ${nm(s, f.router)}`).join(', ');
    frames.push(frame(s, {
      kind: 'ls-install', category: 'spf', title: `${rn} installs routes from its shortest-path tree`, routers: [r],
      explain: `For each destination router, ${rn} follows the shortest-path tree back towards itself to find the FIRST router on the path — that neighbour is the next hop. (${fhText || 'no other routers reachable'}). Networks attached to each router get that router's path cost. ${changes.length ? `${changes.length} route change${changes.length > 1 ? 's' : ''}.` : 'No route changes.'}`,
      changes,
      spf: { router: r, step: spf.steps.length, total: spf.steps.length },
    }));
    if (!s.queue.length) {
      s = cloneState(s);
      s.done = true;
      frames.push(frame(s, { kind: 'ls-converged', category: 'info', title: 'Converged', explain: 'All LSAs have been flooded and every router has run SPF on the same database. Every router now has a consistent routing table.' }));
    }
    return frames;
  }
  return [];
}

/** React to links enabled/disabled or cost changes: detect, re-originate, flood, recalculate. */
export function lsLinkChange(prev: SimState, newTopo: Topology, linkIds: string[]): Frame[] {
  const frames: Frame[] = [];
  let s = cloneState(prev);
  const oldTopo = s.topo;
  s.topo = newTopo;
  s.done = false;
  const affected = affectedRouters([oldTopo, newTopo], linkIds);
  for (const r of affected) {
    const st = lsr(s, r);
    const nbs = routerNeighbors(newTopo, r);
    const before = st.neighbors;
    st.neighbors = nbs.map((nb) => ({ router: nb.router, linkId: nb.key, cost: nb.cost, localIface: nb.localIface.id, remoteIp: nb.remoteIface.ip }));
    const lost = before.filter((b) => !st.neighbors.some((n) => n.linkId === b.linkId));
    const gained = st.neighbors.filter((n) => !before.some((b) => b.linkId === n.linkId));
    // Routes out of interfaces that are no longer up are removed immediately.
    const conn = connectedRoutes(newTopo, r);
    const upIfaces = new Set(conn.map((c) => c.iface));
    const old = s.tables[r] ?? [];
    const table = sortTable([...conn, ...old.filter((x) => x.source !== 'connected' && x.iface && upIfaces.has(x.iface) && !conn.some((c) => routeKey(c) === routeKey(x)))]);
    const changes = diffTable(r, old, table);
    s.tables[r] = table;
    const parts: string[] = [];
    if (lost.length) parts.push(`lost neighbour ${lost.map((x) => nm(s, x.router)).join(', ')}`);
    if (gained.length) parts.push(`new neighbour ${gained.map((x) => nm(s, x.router)).join(', ')}`);
    if (!lost.length && !gained.length) parts.push('a local link or its cost changed');
    frames.push(frame(s, {
      kind: 'ls-detect', category: 'lsa', title: `${nm(s, r)} detects a local change`, routers: [r],
      explain: `${nm(s, r)} ${parts.join('; ')}. Routes that used a failed interface are removed at once. ${nm(s, r)} will originate a new LSA with a higher sequence number so that every router learns about the change.`,
      changes,
    }));
    // Database synchronisation with a new neighbour: send everything we know.
    for (const g of gained) for (const lsa of Object.values(st.lsdb)) push(s, { t: s.time + 1, type: 'lsa-deliver', from: r, to: g.router, linkId: g.linkId, lsa });
    push(s, { t: s.time, type: 'originate', router: r, reason: parts.join('; ') });
    s = cloneState(s);
  }
  if (frames.length === 0) frames.push(frame(s, { kind: 'ls-detect', category: 'info', title: 'No router affected', explain: 'No router interface changed.' }));
  else frames[frames.length - 1] = { ...frames[frames.length - 1], state: s };
  return frames;
}

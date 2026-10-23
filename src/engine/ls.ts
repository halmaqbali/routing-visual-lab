// Link-state routing modelled on OSPFv2 (single area 0), with Dijkstra's SPF.
//  - Hellos: neighbours go Init → 2-Way when each sees its own router ID in the other's Hello.
//  - Switched LANs (multi-access): DR/BDR election by highest router ID (priority 1, no preemption);
//    routers become FULL only with the DR and BDR; DROTHERs stay 2-Way with each other.
//  - Adjacency: ExStart → Exchange (DBD headers) → Loading (LSR / LSU) → Full.
//  - Router-LSAs (Type 1) list only FULL neighbours; the DR originates a Network-LSA (Type 2) for its LAN.
//  - Flooding only over FULL adjacencies; loopbacks are advertised as /32 host routes.
//  - A neighbour that disappears behind a switch is declared down after the Dead interval (40).
// Not modelled: areas, LSA ageing/MaxAge, retransmission, periodic Hellos (only the ones that matter), timers jitter.
import { cidr, inSubnet, networkOf, parseIp } from '../model/ip';
import { getDevice, ifaceUp, isLoopback, linkOfIface, otherEnd, ownerOfIp, routerNeighbors, routers } from '../model/topology';
import type { Topology } from '../model/types';
import { adjPath, affectedRouters, cloneState, frame, nm, popNext, push } from './core';
import { AD, connectedRoutes, diffTable, routeKey, sortTable, type Route, type Table } from './rib';
import type { Frame, LsIface, LsNeighbor, LsRouterState, Lsa, SimState, SpfRelax, SpfResult, SpfStep } from './types';
import { lsuView, macFn, ospfHelloView, ospfMsgView, routerId } from './packets';

export const SPF_DELAY = 5;
export const DEAD_INTERVAL = 40;

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const netKey = (drIp: string) => `net:${drIp}`;
export const isNetNode = (id: string) => id.startsWith('net:');
export const lsaKey = (l: Lsa) => (l.kind === 'network' ? l.id! : l.origin);

/** A readable name for an SPF node: a router's name, or "LAN 192.168.1.0/24 (DR R2)" for a transit network. */
export function lsLabel(topo: Topology, id: string): string {
  if (!isNetNode(id)) return getDevice(topo, id)?.name ?? id;
  const ip = id.slice(4);
  const o = ownerOfIp(topo, ip);
  return o ? `LAN ${cidr(networkOf(ip, o.iface.prefix), o.iface.prefix)} (DR ${o.dev.name})` : `LAN (DR ${ip})`;
}

const ridNum = (topo: Topology, r: string) => parseIp(routerId(topo, r)) ?? 0;

function lsr(s: SimState, r: string): LsRouterState {
  const ls = s.ls!;
  if (!ls.routers[r]) ls.routers[r] = { neighbors: [], lsdb: {}, seq: 0, spf: null, ifaces: {}, netSeq: {} };
  const st = ls.routers[r];
  st.ifaces ??= {};
  st.netSeq ??= {};
  return st;
}

function isMulti(topo: Topology, r: string, ifaceId: string) {
  const l = linkOfIface(topo, r, ifaceId);
  return !!l && getDevice(topo, otherEnd(l, r).dev)?.kind === 'switch';
}

function ifst(s: SimState, r: string, ifaceId: string): LsIface {
  const st = lsr(s, r);
  return (st.ifaces![ifaceId] ??= { multiAccess: isMulti(s.topo, r, ifaceId) });
}

const ifaceName = (s: SimState, r: string, ifaceId: string) => getDevice(s.topo, r)?.ifaces.find((i) => i.id === ifaceId)?.name ?? ifaceId;

/** The Router-LSA a router would originate now: only FULL neighbours, transit LANs, and stub networks. */
export function describeLinks(s: SimState, r: string): Omit<Lsa, 'seq'> {
  const st = lsr(s, r);
  const dev = getDevice(s.topo, r)!;
  const links: Lsa['links'] = [];
  const stubs: Lsa['stubs'] = [];
  for (const ifc of dev.ifaces) {
    if (!ifaceUp(s.topo, r, ifc.id)) continue;
    if (isLoopback(ifc)) {
      stubs.push({ network: ifc.ip, prefix: 32 });
      continue;
    }
    const cost = linkOfIface(s.topo, r, ifc.id)?.cost ?? 1;
    const full = st.neighbors.filter((n) => n.localIface === ifc.id && n.state === 'Full');
    const net = { network: networkOf(ifc.ip, ifc.prefix), prefix: ifc.prefix };
    const info = st.ifaces![ifc.id];
    if (info?.multiAccess) {
      const transit = info.dr && info.drIp && ((info.dr === r && full.length > 0) || full.some((n) => n.router === info.dr));
      if (transit) links.push({ to: netKey(info.drIp!), linkId: netKey(info.drIp!), cost, transit: true });
      else stubs.push(net);
    } else {
      for (const n of full) links.push({ to: n.router, linkId: n.linkId, cost: n.cost });
      stubs.push(net);
    }
  }
  return { origin: r, links, stubs, kind: 'router', id: r };
}

const sameLsa = (a: Omit<Lsa, 'seq'>, b: Omit<Lsa, 'seq'>) =>
  JSON.stringify([a.links, a.stubs, a.attached ?? null]) === JSON.stringify([b.links, b.stubs, b.attached ?? null]);

const lsaName = (s: SimState, l: Lsa) => (l.kind === 'network' ? `Network-LSA of ${lsLabel(s.topo, l.id!)}` : `Router-LSA of ${nm(s, l.origin)}`);

const lsaText = (s: SimState, l: Lsa) =>
  l.kind === 'network'
    ? `Network-LSA #${l.seq} for ${l.net ? cidr(l.net.network, l.net.prefix) : '?'}: attached routers ${(l.attached ?? []).map((x) => nm(s, x)).join(', ')}`
    : `Router-LSA ${nm(s, l.origin)} #${l.seq}: ${l.links.map((x) => (x.transit ? `${lsLabel(s.topo, x.to)} cost ${x.cost}` : `${nm(s, x.to)} cost ${x.cost}`)).join(', ') || 'no full adjacencies'}; networks ${l.stubs.map((x) => cidr(x.network, x.prefix)).join(', ') || 'none'}`;

function flood(s: SimState, from: string, lsa: Lsa, except?: string) {
  for (const n of lsr(s, from).neighbors) if (n.state === 'Full' && n.router !== except) push(s, { t: s.time + 1, type: 'lsa-deliver', from, to: n.router, linkId: n.linkId, lsa });
}

function scheduleSpf(s: SimState, r: string) {
  s.queue = s.queue.filter((q) => !(q.type === 'spf' && q.router === r));
  push(s, { t: s.time + SPF_DELAY, type: 'spf', router: r });
}

function queueOriginate(s: SimState, r: string, reason: string) {
  const q = s.queue.find((x) => x.type === 'originate' && x.router === r && x.t === s.time);
  if (q && q.type === 'originate') {
    if (!q.reason.includes(reason)) q.reason = `${q.reason}; ${reason}`;
  } else push(s, { t: s.time, type: 'originate', router: r, reason });
}

function queueNetLsa(s: SimState, r: string, iface: string) {
  if (!s.queue.some((x) => x.type === 'originate-net' && x.router === r && x.iface === iface && x.t === s.time)) push(s, { t: s.time, type: 'originate-net', router: r, iface });
}

function ensureHello(s: SimState, r: string, iface: string) {
  if (!s.queue.some((x) => x.type === 'hello' && x.router === r && x.iface === iface && x.t >= s.time)) push(s, { t: s.time, type: 'hello', router: r, iface });
}

function queueAdj(s: SimState, a: string, b: string, key: string) {
  if (s.queue.some((x) => x.type === 'adj' && x.key === key)) return;
  push(s, { t: s.time + 1, type: 'adj', a, b, key, stage: 'exstart' });
}

const nbr = (s: SimState, r: string, key: string) => lsr(s, r).neighbors.find((n) => n.linkId === key);
const adjWanted = (info: LsIface | undefined, a: string, b: string) => !info?.multiAccess || [info.dr, info.bdr].includes(a) || [info.dr, info.bdr].includes(b);

/** Called when router `r` reaches 2-Way with neighbour `n`: decide whether they form a full adjacency. */
function onTwoWay(s: SimState, r: string, n: LsNeighbor) {
  const info = lsr(s, r).ifaces![n.localIface];
  const other = nbr(s, n.router, n.linkId);
  const otherReady = !!other && other.state !== 'Init';
  if (!info?.multiAccess) {
    if (otherReady) queueAdj(s, r, n.router, n.linkId);
    return;
  }
  if (info.dr) {
    if (otherReady && adjWanted(info, r, n.router)) queueAdj(s, r, n.router, n.linkId);
    return;
  }
  const ifc = getDevice(s.topo, r)?.ifaces.find((i) => i.id === n.localIface);
  if (!ifc) return;
  const net = cidr(networkOf(ifc.ip, ifc.prefix), ifc.prefix);
  if (!s.queue.some((x) => x.type === 'elect' && x.net === net)) push(s, { t: s.time + 1, type: 'elect', net });
}

// ---------------------------------------------------------------- Dijkstra

/**
 * Dijkstra from `root` over the LSDB. Point-to-point links are used only if BOTH routers list them
 * (two-way check). A transit LAN is a node of its own: router → LAN costs the router's interface cost,
 * LAN → router costs 0, and only routers listed in the DR's Network-LSA are attached.
 */
export function dijkstra(root: string, lsdb: Record<string, Lsa>, nameOf: (id: string) => string = (x) => x): SpfResult {
  const edges: SpfResult['edges'] = [];
  const adj: Record<string, { to: string; linkId: string; cost: number }[]> = {};
  for (const u of Object.keys(lsdb).sort(byName)) {
    const l = lsdb[u];
    if (l.kind === 'network') {
      for (const r of l.attached ?? []) {
        if (!lsdb[r]?.links.some((x) => x.transit && x.to === u)) continue;
        (adj[u] ??= []).push({ to: r, linkId: u, cost: 0 });
      }
      continue;
    }
    for (const link of l.links) {
      if (link.transit) {
        const n = lsdb[link.to];
        if (n?.kind !== 'network' || !(n.attached ?? []).includes(u)) continue;
        (adj[u] ??= []).push({ to: link.to, linkId: link.to, cost: link.cost });
        edges.push({ a: u, b: link.to, linkId: link.to, cost: link.cost });
        continue;
      }
      const back = lsdb[link.to]?.links.some((x) => x.to === u && x.linkId === link.linkId);
      if (!back) continue;
      (adj[u] ??= []).push({ to: link.to, linkId: link.linkId, cost: link.cost });
      if (byName(u, link.to) < 0) edges.push({ a: u, b: link.to, linkId: link.linkId, cost: link.cost });
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
      const calc = `${nameOf(sel)} (${dist[sel]}) + ${isNetNode(sel) ? 'LAN to router 0' : `link ${e.cost}`} = ${nd}`;
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
  // First hop = the first ROUTER after the root on the path (a transit LAN in between is remembered as `via`).
  const firstHop: SpfResult['firstHop'] = {};
  for (const n of confirmed) {
    if (n === root) continue;
    const path = [n];
    let guard = 0;
    while (pred[path[0]] && guard++ < 200) path.unshift(pred[path[0]]!.node);
    const x1 = path[1];
    if (!x1) continue;
    if (isNetNode(x1)) {
      const x2 = path[2];
      if (x2) firstHop[n] = { router: x2, linkId: pred[x2]!.linkId, via: x1 };
    } else firstHop[n] = { router: x1, linkId: pred[x1]!.linkId };
  }
  const fdist: Record<string, number> = {};
  for (const n of confirmed) fdist[n] = dist[n];
  return { root, dist: fdist, pred: Object.fromEntries(confirmed.map((n) => [n, pred[n]])), steps, firstHop, edges };
}

/** Turn an SPF tree into routes: every network advertised by a reachable router or transit LAN. */
export function spfRoutes(topo: Topology, root: string, spf: SpfResult, lsdb: Record<string, Lsa>): Table {
  const conn = connectedRoutes(topo, root);
  const connKeys = new Set(conn.map(routeKey));
  const best = new Map<string, Route>();
  const nodes = Object.keys(spf.dist).filter((o) => o !== root).sort((a, b) => spf.dist[a] - spf.dist[b] || byName(a, b));
  const rootNbrs = routerNeighbors(topo, root);
  for (const o of nodes) {
    const fh = spf.firstHop[o];
    if (!fh) continue;
    let adj = rootNbrs.find((n) => n.key === fh.linkId && n.router === fh.router);
    if (fh.via) {
      const lan = lsdb[fh.via]?.net;
      adj = rootNbrs.find((n) => n.router === fh.router && !!lan && inSubnet(n.localIface.ip, lan.network, lan.prefix)) ?? adj;
    }
    if (!adj) continue;
    const lsa = lsdb[o];
    const prefixes = lsa?.kind === 'network' ? (lsa.net ? [lsa.net] : []) : lsa?.stubs ?? [];
    for (const st of prefixes) {
      const k = cidr(st.network, st.prefix);
      if (connKeys.has(k) || best.has(k)) continue;
      const path: string[] = [];
      let c: string | undefined = o;
      while (c) {
        path.unshift(lsLabel(topo, c));
        c = spf.pred[c]?.node;
      }
      best.set(k, {
        network: st.network, prefix: st.prefix, source: 'ls', nextHop: adj.remoteIface.ip, iface: adj.localIface.id, metric: spf.dist[o], ad: AD.ls, learnedFrom: fh.router,
        note: `Shortest path ${path.join(' → ')} (cost ${spf.dist[o]}).${st.prefix === 32 && lsa?.kind !== 'network' ? ' OSPF advertises a loopback as a /32 host route.' : ''}`,
      });
    }
  }
  return sortTable([...conn, ...best.values()]);
}

// ---------------------------------------------------------------- start

export function lsInit(base: SimState): Frame[] {
  const s = cloneState(base);
  s.ls = { routers: {} };
  s.tables = {};
  for (const r of routers(s.topo)) {
    lsr(s, r.id);
    s.tables[r.id] = sortTable(connectedRoutes(s.topo, r.id));
  }
  for (const r of routers(s.topo)) {
    const ifaces = [...new Set(routerNeighbors(s.topo, r.id).map((n) => n.localIface.id))];
    for (const i of ifaces) {
      ifst(s, r.id, i);
      push(s, { t: 0, type: 'hello', router: r.id, iface: i });
    }
    if (!ifaces.length) push(s, { t: 0, type: 'originate', router: r.id, reason: 'it has no OSPF neighbours, so it describes only its own networks' });
  }
  return [frame(s, {
    kind: 'ls-init', category: 'config', title: 'Start: connected networks only',
    explain: 'Each router starts with its connected networks. OSPF-style link state: routers discover neighbours with Hellos, form FULL adjacencies, flood link-state advertisements so every router builds the same map (the LSDB), then each runs Dijkstra with itself as the root.',
  })];
}

// ---------------------------------------------------------------- events

function handle(s: SimState, prev: SimState, p: NonNullable<ReturnType<typeof popNext>>): Frame[] {
  if (p.type === 'hello') {
    const r = p.router;
    if (!ifaceUp(s.topo, r, p.iface)) return [];
    const nbs = routerNeighbors(s.topo, r).filter((n) => n.localIface.id === p.iface);
    if (!nbs.length) return [];
    const st = lsr(s, r);
    const info = ifst(s, r, p.iface);
    const seen = st.neighbors.filter((n) => n.localIface === p.iface).map((n) => n.router);
    for (const nb of nbs) push(s, { t: s.time + 1, type: 'hello-rx', from: r, to: nb.router, key: nb.key, seen, dr: info.dr, bdr: info.bdr });
    const ifn = ifaceName(s, r, p.iface);
    return [frame(s, {
      kind: 'ls-hello', category: 'lsa', title: `${nm(s, r)} sends a Hello on ${ifn}`, routers: [r],
      explain: `${nm(s, r)} (router ID ${routerId(s.topo, r)}) sends an OSPF Hello out of ${ifn} to 224.0.0.5. It lists the neighbours it has already heard on this link: ${seen.length ? seen.map((x) => nm(s, x)).join(', ') : 'none yet'}.${info.multiAccess ? ' This is a switched LAN, so every router on it receives the Hello.' : ''}`,
      anim: { from: r, to: nbs[0].router, linkId: nbs[0].key, style: 'hello', label: 'Hello', path: nbs[0].path, copies: nbs.slice(1).map((n) => ({ from: r, to: n.router })) },
      packet: ospfHelloView(s.topo, r, p.iface, seen, info.dr, info.bdr, macFn(s.topo), nbs[0].router),
    })];
  }

  if (p.type === 'hello-rx') {
    const nb = routerNeighbors(s.topo, p.to).find((n) => n.key === p.key && n.router === p.from);
    if (!nb) return [];
    const st = lsr(s, p.to);
    const info = ifst(s, p.to, nb.localIface.id);
    // On an established LAN, a newcomer accepts the DR/BDR announced in Hellos (no preemption).
    if (info.multiAccess && !info.dr && p.dr) {
      info.dr = p.dr;
      info.bdr = p.bdr;
      const drIf = getDevice(s.topo, p.dr)?.ifaces.find((i) => i.ip && inSubnet(i.ip, nb.localIface.ip, nb.localIface.prefix));
      info.drIp = drIf?.ip;
    }
    const seesMe = p.seen.includes(p.to);
    let n = nbr(s, p.to, p.key);
    const fromN = nm(s, p.from);
    const toN = nm(s, p.to);
    if (!n) {
      n = { router: p.from, linkId: p.key, cost: nb.cost, localIface: nb.localIface.id, remoteIp: nb.remoteIface.ip, state: seesMe ? '2-Way' : 'Init', rid: routerId(s.topo, p.from) };
      st.neighbors.push(n);
      st.neighbors.sort((x, y) => byName(x.router, y.router));
      ensureHello(s, p.to, nb.localIface.id);
      if (n.state === '2-Way') onTwoWay(s, p.to, n);
      return [frame(s, {
        kind: 'ls-nbr', category: 'lsa', title: `${toN} hears ${fromN}: ${n.state}`, routers: [p.to],
        explain: n.state === 'Init'
          ? `${toN} receives ${fromN}'s Hello but its own router ID is not listed in it yet, so ${fromN} is in state INIT ("I hear you, but you have not heard me"). ${toN} replies with its own Hello.`
          : `${toN} receives ${fromN}'s Hello and finds its OWN router ID in it, so communication works both ways: ${fromN} goes straight to 2-WAY.`,
      })];
    }
    if (n.state === 'Init' && seesMe) {
      n.state = '2-Way';
      onTwoWay(s, p.to, n);
      const multi = info.multiAccess;
      return [frame(s, {
        kind: 'ls-nbr', category: 'lsa', title: `${toN} ↔ ${fromN}: 2-Way`, routers: [p.to],
        explain: `${toN} now sees its own router ID in ${fromN}'s Hello, so the neighbourship is 2-WAY: each router knows the other hears it.${multi ? ' On a LAN the routers now elect a Designated Router (DR) before forming adjacencies.' : ' On a point-to-point link they go on to form a full adjacency.'}`,
      })];
    }
    return [];
  }

  if (p.type === 'elect') {
    const [network, len] = p.net.split('/');
    const prefix = Number(len);
    const cands: { r: string; iface: string; ip: string }[] = [];
    for (const r of routers(s.topo)) {
      for (const ifc of r.ifaces) {
        if (isLoopback(ifc) || !ifc.ip || ifc.prefix !== prefix || !inSubnet(ifc.ip, network, prefix) || !ifaceUp(s.topo, r.id, ifc.id)) continue;
        if (!isMulti(s.topo, r.id, ifc.id)) continue;
        if (!lsr(s, r.id).neighbors.some((n) => n.localIface === ifc.id && n.state !== 'Init')) continue;
        cands.push({ r: r.id, iface: ifc.id, ip: ifc.ip });
      }
    }
    if (!cands.length) return [];
    cands.sort((a, b) => ridNum(s.topo, b.r) - ridNum(s.topo, a.r) || byName(a.r, b.r));
    const ids = cands.map((c) => c.r);
    const prevDr = cands.map((c) => ifst(s, c.r, c.iface).dr).find((d) => d && ids.includes(d));
    const prevBdr = cands.map((c) => ifst(s, c.r, c.iface).bdr).find((d) => d && ids.includes(d));
    const dr = prevDr ?? prevBdr ?? cands[0].r;
    const bdr = prevDr && prevBdr && prevBdr !== dr ? prevBdr : cands.find((c) => c.r !== dr)?.r;
    const drIp = cands.find((c) => c.r === dr)!.ip;
    const unchanged = cands.every((c) => { const i = ifst(s, c.r, c.iface); return i.dr === dr && i.bdr === bdr; });
    for (const c of cands) Object.assign(ifst(s, c.r, c.iface), { dr, bdr, drIp });
    // Adjacencies: FULL only with the DR and BDR. DROTHER pairs fall back to (or stay in) 2-Way.
    for (const c of cands) {
      for (const n of lsr(s, c.r).neighbors.filter((x) => x.localIface === c.iface)) {
        const want = [dr, bdr].includes(c.r) || [dr, bdr].includes(n.router);
        if (!want && n.state !== 'Init' && n.state !== '2-Way') n.state = '2-Way';
        if (want && n.state === '2-Way' && nbr(s, n.router, n.linkId)?.state === '2-Way') queueAdj(s, c.r, n.router, n.linkId);
      }
    }
    if (unchanged) return [];
    // A new DR (or BDR) changes how the LAN is described: everyone re-advertises, the DR makes the Network-LSA.
    if (prevDr !== dr || prevBdr !== bdr) {
      for (const c of cands) if (prevDr || prevBdr) queueOriginate(s, c.r, `the LAN ${p.net} has a new DR/BDR`);
      const drCand = cands.find((c) => c.r === dr)!;
      queueNetLsa(s, dr, drCand.iface);
    }
    const others = ids.filter((x) => x !== dr && x !== bdr);
    return [frame(s, {
      kind: 'ls-elect', category: 'lsa', title: `DR/BDR election on LAN ${p.net}: DR ${nm(s, dr)}${bdr ? `, BDR ${nm(s, bdr)}` : ''}`, routers: ids,
      explain: `${prevDr ? `${nm(s, dr)} stays the Designated Router (OSPF does not replace a working DR).` : prevBdr ? `The old DR is gone, so the Backup DR ${nm(s, dr)} takes over as DR.` : `All priorities are equal (1), so the highest router ID wins: ${nm(s, dr)} (${routerId(s.topo, dr)}) becomes the Designated Router (DR).`}${bdr ? ` ${nm(s, bdr)} (${routerId(s.topo, bdr)}) is the Backup DR.` : ''}${others.length ? ` ${others.map((x) => nm(s, x)).join(', ')} ${others.length > 1 ? 'are' : 'is'} DROTHER: they form FULL adjacencies only with the DR and BDR and stay 2-Way with each other. This keeps flooding on a LAN small.` : ''} The DR will describe the LAN in a Network-LSA.`,
    })];
  }

  if (p.type === 'adj') {
    const A = nbr(s, p.a, p.key);
    const B = nbr(s, p.b, p.key);
    if (!A || !B || !routerNeighbors(s.topo, p.a).some((n) => n.key === p.key)) return [];
    const an = nm(s, p.a);
    const bn = nm(s, p.b);
    const path = adjPath(s.topo, p.a, p.key);
    if (p.stage === 'exstart') {
      if (A.state === 'Full' && B.state === 'Full') return [];
      A.state = 'Exchange';
      B.state = 'Exchange';
      const master = ridNum(s.topo, p.a) > ridNum(s.topo, p.b) ? p.a : p.b;
      const hdrs = (r: string) => Object.values(lsr(s, r).lsdb).map((l) => `${l.kind === 'network' ? 'Net' : 'Rtr'} ${l.kind === 'network' ? lsLabel(s.topo, l.id!) : nm(s, l.origin)} #${l.seq}`);
      push(s, { t: s.time + 1, type: 'adj', a: p.a, b: p.b, key: p.key, stage: 'loading' });
      return [frame(s, {
        kind: 'ls-adj', category: 'lsa', title: `${an} ↔ ${bn}: ExStart → Exchange (DBD)`, routers: [p.a, p.b],
        explain: `To become fully adjacent, ${an} and ${bn} first agree who leads (ExStart: the higher router ID, ${nm(s, master)}, is master). Then they swap Database Description (DBD) packets that list only the HEADERS of the LSAs each one has. ${an} has ${hdrs(p.a).join(', ') || 'nothing yet'}; ${bn} has ${hdrs(p.b).join(', ') || 'nothing yet'}.`,
        anim: { from: p.a, to: p.b, linkId: p.key, style: 'lsa', label: 'DBD', path },
        packet: ospfMsgView(s.topo, master, master === p.a ? p.b : p.a, p.key, 'DBD', hdrs(master), `Database Description: ${hdrs(master).length} LSA header(s)`, ['A DBD lists LSA headers (type, origin, sequence number), not the full LSAs. Each router compares the list with its own database to see what it is missing.'], macFn(s.topo)),
      })];
    }
    // Loading: request what is missing (LSR), receive it (LSU), acknowledge (LSAck), then FULL.
    const missing = (have: LsRouterState, other: LsRouterState) => Object.values(other.lsdb).filter((l) => { const k = lsaKey(l); return !have.lsdb[k] || have.lsdb[k].seq < l.seq; });
    const sa = lsr(s, p.a);
    const sb = lsr(s, p.b);
    const forA = missing(sa, sb);
    const forB = missing(sb, sa);
    for (const l of forA) sa.lsdb[lsaKey(l)] = l;
    for (const l of forB) sb.lsdb[lsaKey(l)] = l;
    if (forA.length) scheduleSpf(s, p.a);
    if (forB.length) scheduleSpf(s, p.b);
    A.state = 'Full';
    B.state = 'Full';
    queueOriginate(s, p.a, `it became FULL with ${bn}`);
    queueOriginate(s, p.b, `it became FULL with ${an}`);
    for (const [r, n] of [[p.a, A], [p.b, B]] as const) {
      const info = lsr(s, r).ifaces![n.localIface];
      if (info?.multiAccess && info.dr === r) queueNetLsa(s, r, n.localIface);
    }
    const list = (ls: Lsa[]) => ls.map((l) => lsaName(s, l)).join(', ');
    const asker = forA.length ? p.a : p.b;
    const asked = forA.length ? forA : forB;
    return [frame(s, {
      kind: 'ls-adj', category: 'lsa', title: `${an} ↔ ${bn}: Loading → FULL`, routers: [p.a, p.b],
      explain: `${forA.length || forB.length
        ? `Loading: ${forA.length ? `${an} sends a Link State Request (LSR) for ${list(forA)}; ${bn} answers with a Link State Update (LSU).` : ''} ${forB.length ? `${bn} requests ${list(forB)} from ${an} the same way.` : ''} Each LSU is acknowledged with an LSAck.`
        : 'Their databases already match, so nothing has to be requested.'} The two routers are now FULL: fully adjacent with synchronised databases. Only FULL neighbours appear in Router-LSAs and are used for flooding.`,
      anim: { from: asker === p.a ? p.b : p.a, to: asker, linkId: p.key, style: 'lsa', label: asked.length ? 'LSU' : 'Full', path: asker === p.a ? adjPath(s.topo, p.b, p.key) : path },
      packet: ospfMsgView(s.topo, asker, asker === p.a ? p.b : p.a, p.key, 'LSR', asked.map((l) => lsaName(s, l)), asked.length ? `Link State Request: ${asked.length} LSA(s)` : 'Link State Request: nothing missing', ['An LSR asks for the full LSAs that the DBD exchange showed are missing or older. The reply is a Link State Update (LSU).'], macFn(s.topo)),
    })];
  }

  if (p.type === 'dead') {
    const st = lsr(s, p.router);
    const n = st.neighbors.find((x) => x.linkId === p.key);
    if (!n || routerNeighbors(s.topo, p.router).some((x) => x.key === p.key)) return [];
    st.neighbors = st.neighbors.filter((x) => x !== n);
    const info = st.ifaces![n.localIface];
    if (info?.multiAccess && (info.dr === n.router || info.bdr === n.router)) {
      const ifc = getDevice(s.topo, p.router)?.ifaces.find((i) => i.id === n.localIface);
      if (ifc) {
        const net = cidr(networkOf(ifc.ip, ifc.prefix), ifc.prefix);
        if (!s.queue.some((x) => x.type === 'elect' && x.net === net)) push(s, { t: s.time, type: 'elect', net });
      }
    }
    queueOriginate(s, p.router, `neighbour ${nm(s, n.router)} is down`);
    if (info?.multiAccess && info.dr === p.router) queueNetLsa(s, p.router, n.localIface);
    return [frame(s, {
      kind: 'ls-dead', category: 'lsa', title: `${nm(s, p.router)}: Dead interval expired for ${nm(s, n.router)}`, routers: [p.router],
      explain: `${nm(s, p.router)} has not received a Hello from ${nm(s, n.router)} for ${DEAD_INTERVAL} time units (the Dead interval), so it declares the neighbour DOWN.${info?.multiAccess && (info.dr === n.router || info.bdr === n.router) ? ` ${nm(s, n.router)} was the ${info.dr === n.router ? 'DR' : 'BDR'}, so the LAN runs a new election.` : ''} It will originate a new Router-LSA without it.`,
    })];
  }

  if (p.type === 'originate') {
    const st = lsr(s, p.router);
    const d = describeLinks(s, p.router);
    const cur = st.lsdb[p.router];
    if (cur && sameLsa(cur, d)) return [];
    const frames: Frame[] = [];
    if (!cur) {
      frames.push(frame(s, {
        kind: 'ls-describe', category: 'lsa', title: `${nm(s, p.router)} describes its local links`, routers: [p.router],
        explain: `${nm(s, p.router)} lists what it knows FIRST-HAND: ${d.links.length ? `links to ${d.links.map((x) => `${lsLabel(s.topo, x.to)} (cost ${x.cost})`).join(', ')}` : 'no full adjacencies yet'}, and stub networks ${d.stubs.map((x) => cidr(x.network, x.prefix)).join(', ') || 'none'}.${d.stubs.some((x) => x.prefix === 32) ? ' Loopbacks are advertised as /32 host routes, as OSPF does.' : ''}`,
      }));
      s = cloneState(s);
    }
    const st2 = lsr(s, p.router);
    st2.seq += 1;
    const lsa: Lsa = { ...d, seq: st2.seq };
    st2.lsdb[p.router] = lsa;
    flood(s, p.router, lsa);
    scheduleSpf(s, p.router);
    frames.push(frame(s, {
      kind: 'ls-originate', category: 'lsa', title: `${nm(s, p.router)} originates Router-LSA #${lsa.seq}`, routers: [p.router],
      explain: `${nm(s, p.router)} puts its link description in a Router-LSA (Type 1) with sequence number ${lsa.seq} because ${p.reason}. It stores it and floods it to its FULL neighbours. A higher sequence number means newer information.`,
      detail: [lsaText(s, lsa)],
      lsa: { lsa, installed: true },
    }));
    return frames;
  }

  if (p.type === 'originate-net') {
    const st = lsr(s, p.router);
    const info = st.ifaces![p.iface];
    const ifc = getDevice(s.topo, p.router)?.ifaces.find((i) => i.id === p.iface);
    if (!info || info.dr !== p.router || !info.drIp || !ifc) return [];
    const full = st.neighbors.filter((n) => n.localIface === p.iface && n.state === 'Full').map((n) => n.router);
    if (!full.length) return [];
    const id = netKey(info.drIp);
    const attached = [p.router, ...full].sort(byName);
    const net = { network: networkOf(ifc.ip, ifc.prefix), prefix: ifc.prefix };
    const cur = st.lsdb[id];
    if (cur && JSON.stringify(cur.attached) === JSON.stringify(attached)) return [];
    st.netSeq![id] = (st.netSeq![id] ?? 0) + 1;
    const lsa: Lsa = { origin: p.router, seq: st.netSeq![id], links: [], stubs: [], kind: 'network', id, attached, net };
    st.lsdb[id] = lsa;
    flood(s, p.router, lsa);
    scheduleSpf(s, p.router);
    return [frame(s, {
      kind: 'ls-originate', category: 'lsa', title: `${nm(s, p.router)} (DR) originates a Network-LSA for ${cidr(net.network, net.prefix)}`, routers: [p.router],
      explain: `As the DR, ${nm(s, p.router)} describes the LAN ${cidr(net.network, net.prefix)} in a Network-LSA (Type 2) listing the attached routers: ${attached.map((x) => nm(s, x)).join(', ')}. In the shortest-path calculation the LAN becomes a node of its own: router → LAN costs the router's interface cost, LAN → router costs 0.`,
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
    const key = lsaKey(p.lsa);
    const have = st.lsdb[key];
    const what = lsaName(s, p.lsa);
    const owner = p.lsa.kind === 'network' ? `LAN ${p.lsa.net ? cidr(p.lsa.net.network, p.lsa.net.prefix) : ''}` : nm(s, p.lsa.origin);
    if (!have || p.lsa.seq > have.seq) {
      st.lsdb[key] = p.lsa;
      flood(s, p.to, p.lsa, p.from);
      scheduleSpf(s, p.to);
      const total = Object.keys(st.lsdb).length;
      return [frame(s, {
        kind: 'ls-flood', category: 'lsa', title: `${toN} receives the ${what} #${p.lsa.seq}`, routers: [p.to],
        explain: `${toN} gets the ${what} from ${fromN}. It is ${have ? `newer than the stored #${have.seq}` : 'new'}, so ${toN} stores it (its database now holds ${total} LSA${total > 1 ? 's' : ''}), acknowledges it and floods an unchanged copy to its other FULL neighbours. The LSA is NOT modified: every router gets the same original description.`,
        detail: [lsaText(s, p.lsa)],
        anim: { from: p.from, to: p.to, linkId: p.linkId, style: 'lsa', label: `LSA ${owner}`, path: adjPath(s.topo, p.from, p.linkId) },
        lsa: { lsa: p.lsa, installed: true },
        packet: lsuView(s.topo, p.from, p.to, p.linkId, p.lsa, macFn(s.topo)),
      })];
    }
    return [frame(s, {
      kind: 'ls-dup', category: 'lsa', title: `${toN} discards a duplicate ${what}`, routers: [p.to],
      explain: `${toN} already has the ${what} #${have.seq}, so the copy from ${fromN} is not new. It is acknowledged but discarded and NOT flooded again — this is what stops flooding from going on forever.`,
      anim: { from: p.from, to: p.to, linkId: p.linkId, style: 'lsa', label: `LSA ${owner}`, path: adjPath(s.topo, p.from, p.linkId) },
      lsa: { lsa: p.lsa, installed: false },
      packet: lsuView(s.topo, p.from, p.to, p.linkId, p.lsa, macFn(s.topo)),
    })];
  }

  if (p.type === 'spf') {
    const r = p.router;
    const rn = nm(s, r);
    const st = lsr(s, r);
    const spf = dijkstra(r, st.lsdb, (id) => lsLabel(s.topo, id));
    st.spf = spf;
    const frames: Frame[] = [];
    s.spfView = { router: r, step: 0 };
    frames.push(frame(s, {
      kind: 'spf-start', category: 'spf', title: `${rn} runs SPF (Dijkstra) with itself as the root`, routers: [r],
      explain: `${rn}'s database has ${Object.keys(st.lsdb).length} LSAs and has been quiet for ${SPF_DELAY} time units, so ${rn} calculates shortest paths. Every router does this separately, always with ITSELF as the starting point (root). A point-to-point link is only used if both routers on it advertise it; a LAN is a node of its own, described by its DR.`,
      spf: { router: r, step: 0, total: spf.steps.length },
    }));
    let cur = s;
    spf.steps.forEach((step, i) => {
      cur = cloneState(cur);
      cur.spfView = { router: r, step: i + 1 };
      const improved = step.relax.filter((x) => x.outcome === 'improved' || x.outcome === 'new');
      const sel = lsLabel(cur.topo, step.selected);
      frames.push(frame(cur, {
        kind: 'spf-step', category: 'spf', title: `${rn} SPF step ${i + 1}: confirm ${sel} (cost ${step.selectedDist})`, routers: [r],
        explain: `${sel} has the lowest tentative cost (${step.selectedDist}), so its shortest path is now confirmed. Then ${rn} checks its links: ${step.relax.length ? step.relax.map((x) => x.text).join(' ') : 'no unconfirmed neighbours.'}${improved.length === 0 && step.relax.length ? ' No tentative cost improved.' : ''}`,
        spf: { router: r, step: i + 1, total: spf.steps.length },
      }));
    });
    cur = cloneState(cur);
    const table = spfRoutes(cur.topo, r, spf, lsr(cur, r).lsdb);
    const changes = diffTable(r, cur.tables[r] ?? [], table);
    cur.tables[r] = table;
    cur.spfView = { router: r, step: spf.steps.length };
    const fhText = Object.entries(spf.firstHop).filter(([n]) => !isNetNode(n)).sort(([a], [b]) => byName(a, b)).map(([n, f]) => `${nm(cur, n)} via ${nm(cur, f.router)}`).join(', ');
    frames.push(frame(cur, {
      kind: 'ls-install', category: 'spf', title: `${rn} installs routes from its shortest-path tree`, routers: [r],
      explain: `For each destination, ${rn} follows the shortest-path tree back towards itself to find the FIRST router on the path — that neighbour is the next hop (${fhText || 'no other routers reachable'}). Networks get the cost of the path to the router or LAN that advertises them. ${changes.length ? `${changes.length} route change${changes.length > 1 ? 's' : ''}.` : 'No route changes.'}`,
      changes,
      spf: { router: r, step: spf.steps.length, total: spf.steps.length },
    }));
    if (!cur.queue.some((q) => q.type !== 'dead')) {
      cur = cloneState(cur);
      cur.done = !cur.queue.length;
      frames.push(frame(cur, { kind: 'ls-converged', category: 'info', title: 'Converged', explain: 'All adjacencies are FULL, every LSA has been flooded and every router has run SPF on the same database. Every router now has a consistent routing table.' }));
    }
    return frames;
  }
  return [];
}

export function lsStep(prev: SimState): Frame[] {
  const s = cloneState(prev);
  s.spfView = null;
  // Process queued events until one produces something to show (some, like a Hello that changes nothing, are silent).
  for (let guard = 0; guard < 10000; guard++) {
    const p = popNext(s);
    if (!p) {
      s.done = true;
      return [];
    }
    s.time = Math.max(s.time, p.t);
    const frames = handle(s, prev, p);
    if (frames.length) return frames;
  }
  return [];
}

/** React to links enabled/disabled or cost changes: detect locally, or wait for the Dead interval behind a switch. */
export function lsLinkChange(prev: SimState, newTopo: Topology, linkIds: string[], before?: Topology): Frame[] {
  const frames: Frame[] = [];
  let s = cloneState(prev);
  const oldTopo = before ?? s.topo;
  s.topo = newTopo;
  s.done = false;
  for (const r of affectedRouters([oldTopo, newTopo], linkIds)) {
    const st = lsr(s, r);
    const dev = getDevice(newTopo, r);
    if (!dev) continue;
    const parts: string[] = [];
    for (const ifc of dev.ifaces) {
      if (isLoopback(ifc)) continue;
      const wasUp = ifaceUp(oldTopo, r, ifc.id);
      const isUp = ifaceUp(newTopo, r, ifc.id);
      if (wasUp && !isUp) {
        st.neighbors = st.neighbors.filter((n) => n.localIface !== ifc.id);
        delete st.ifaces![ifc.id];
        parts.push(`its interface ${ifc.name} went down (neighbours on it are lost at once)`);
      } else if (!wasUp && isUp) {
        st.ifaces![ifc.id] = { multiAccess: isMulti(newTopo, r, ifc.id) };
        push(s, { t: s.time, type: 'hello', router: r, iface: ifc.id });
        parts.push(`its interface ${ifc.name} came up, so it starts sending Hellos`);
      } else if (isUp) {
        const oldCost = linkOfIface(oldTopo, r, ifc.id)?.cost;
        const newCost = linkOfIface(newTopo, r, ifc.id)?.cost;
        if (oldCost !== newCost && newCost !== undefined) {
          for (const n of st.neighbors) if (n.localIface === ifc.id) n.cost = newCost;
          parts.push(`the cost of ${ifc.name} changed to ${newCost}`);
        }
      }
    }
    // Neighbours that vanished behind a switch while this router's own link stayed up: wait for the Dead interval.
    const waiting = st.neighbors.filter((n) => !routerNeighbors(newTopo, r).some((x) => x.key === n.linkId));
    for (const n of waiting) push(s, { t: s.time + DEAD_INTERVAL, type: 'dead', router: r, key: n.linkId });
    // Routes out of interfaces that are no longer up are removed immediately.
    const conn = connectedRoutes(newTopo, r);
    const upIfaces = new Set(conn.map((c) => c.iface));
    const old = s.tables[r] ?? [];
    const table = sortTable([...conn, ...old.filter((x) => x.source !== 'connected' && x.iface && upIfaces.has(x.iface) && !conn.some((c) => routeKey(c) === routeKey(x)))]);
    const changes = diffTable(r, old, table);
    s.tables[r] = table;
    if (parts.length) {
      queueOriginate(s, r, parts.join('; '));
      for (const [i, info] of Object.entries(st.ifaces!)) if (info.multiAccess && info.dr === r) queueNetLsa(s, r, i);
    }
    if (parts.length || changes.length || waiting.length) {
      frames.push(frame(s, {
        kind: 'ls-detect', category: 'lsa', title: parts.length ? `${nm(s, r)} detects a local change` : `${nm(s, r)} has not noticed yet`, routers: [r],
        explain: `${parts.length ? `${nm(s, r)}: ${parts.join('; ')}. Routes that used a failed interface are removed at once, and it will originate a new Router-LSA with a higher sequence number.` : ''}${waiting.length ? ` ${nm(s, r)}'s own link is still up, so it does not notice yet that ${waiting.map((n) => nm(s, n.router)).join(', ')} disappeared behind the switch. It will declare ${waiting.length > 1 ? 'them' : 'it'} down when no Hello arrives for the Dead interval (${DEAD_INTERVAL}).` : ''}`,
        changes,
      }));
      s = cloneState(s);
    }
  }
  if (frames.length === 0) frames.push(frame(s, { kind: 'ls-detect', category: 'info', title: 'No router affected', explain: 'No router interface changed.' }));
  else frames[frames.length - 1] = { ...frames[frames.length - 1], state: s };
  return frames;
}

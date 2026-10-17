// Static routing: connected routes + configured static routes with recursive next-hop resolution.
import { inSubnet, isNetworkAddress, isValidIp } from '../model/ip';
import { getDevice, ifaceUp, routers } from '../model/topology';
import type { Device, StaticRoute, Topology } from '../model/types';
import { connectedRoutes, lookup, routeKey, sortTable, type Route, type Table, type Tables } from './rib';
import type { StaticStatus } from './types';

const MAX_PASSES = 8;

interface Resolution {
  ok: boolean;
  iface: string | null;
  via: string | null;
  reason: string;
}

/**
 * Resolve a static route against the routes installed so far.
 * - next hop on a connected network: resolved directly.
 * - next hop reachable only through another route: recursive resolution (uses that route's exit).
 * - exit interface only: treated as a point-to-point route out of that interface.
 * A route may not resolve through itself (same prefix), which prevents self-recursion.
 */
export function resolveStatic(dev: Device, topo: Topology, sr: StaticRoute, rib: Table): Resolution {
  if (!isValidIp(sr.network) || !isNetworkAddress(sr.network, sr.prefix)) return { ok: false, iface: null, via: null, reason: 'Invalid destination network.' };
  if (sr.iface) {
    const ifc = dev.ifaces.find((i) => i.id === sr.iface);
    if (!ifc) return { ok: false, iface: null, via: null, reason: 'Exit interface does not exist.' };
    if (!ifaceUp(topo, dev.id, ifc.id)) return { ok: false, iface: null, via: null, reason: `Exit interface ${ifc.name} is down.` };
    if (!sr.nextHop) return { ok: true, iface: ifc.id, via: null, reason: `Sent straight out of ${ifc.name}.` };
    if (!isValidIp(sr.nextHop) || !inSubnet(sr.nextHop, ifc.ip, ifc.prefix)) return { ok: false, iface: null, via: null, reason: `Next hop ${sr.nextHop} is not on ${ifc.name}'s network.` };
    return { ok: true, iface: ifc.id, via: sr.nextHop, reason: `Next hop ${sr.nextHop} is on ${ifc.name}.` };
  }
  if (!isValidIp(sr.nextHop)) return { ok: false, iface: null, via: null, reason: 'Invalid next-hop address.' };
  if (dev.ifaces.some((i) => i.ip === sr.nextHop)) return { ok: false, iface: null, via: null, reason: 'Next hop is this router\'s own address.' };
  const res = lookup(rib.filter((r) => routeKey(r) !== routeKey(sr)), sr.nextHop);
  const m = res.match;
  if (!m) return { ok: false, iface: null, via: null, reason: `No route to the next hop ${sr.nextHop}, so the router cannot tell which way to send packets.` };
  const ifName = dev.ifaces.find((i) => i.id === m.iface)?.name ?? '?';
  if (m.source === 'connected') return { ok: true, iface: m.iface, via: sr.nextHop, reason: `Next hop ${sr.nextHop} is on connected network ${routeKey(m)} (${ifName}).` };
  return {
    ok: true,
    iface: m.iface,
    via: m.resolvedVia ?? m.nextHop,
    reason: `Recursive: next hop ${sr.nextHop} is reached through route ${routeKey(m)}, so packets leave ${ifName} towards ${m.resolvedVia ?? m.nextHop}.`,
  };
}

export function buildStaticTable(topo: Topology, routerId: string): { table: Table; status: StaticStatus[] } {
  const dev = getDevice(topo, routerId)!;
  const connected = connectedRoutes(topo, routerId);
  let rib: Table = connected;
  let status: StaticStatus[] = [];
  let lastSig = '';
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const candidates: { sr: StaticRoute; route: Route }[] = [];
    status = [];
    for (const sr of dev.staticRoutes) {
      if (!sr.enabled) {
        status.push({ routeId: sr.id, installed: false, reason: 'Disabled by the user.' });
        continue;
      }
      const r = resolveStatic(dev, topo, sr, rib);
      if (!r.ok) {
        status.push({ routeId: sr.id, installed: false, reason: r.reason });
        continue;
      }
      candidates.push({
        sr,
        route: { network: sr.network, prefix: sr.prefix, source: 'static', nextHop: sr.nextHop || null, iface: r.iface, resolvedVia: r.via, metric: 0, ad: sr.ad, staticId: sr.id, note: r.reason },
      });
      status.push({ routeId: sr.id, installed: true, reason: r.reason });
    }
    // Best route per prefix: lowest administrative distance; first configured wins a tie.
    const best = new Map<string, Route>(connected.map((c) => [routeKey(c), c]));
    for (const { route } of candidates) {
      const k = routeKey(route);
      const cur = best.get(k);
      if (!cur || route.ad < cur.ad) best.set(k, route);
    }
    for (const s of status) {
      if (!s.installed) continue;
      const c = candidates.find((x) => x.sr.id === s.routeId)!;
      const winner = best.get(routeKey(c.route))!;
      if (winner !== c.route) {
        s.installed = false;
        s.reason =
          winner.source === 'connected'
            ? 'Not used: the network is directly connected (AD 0).'
            : `Backup only: another route to ${routeKey(c.route)} has a lower administrative distance (${winner.ad} < ${c.route.ad}). It is installed if that route fails.`;
      }
    }
    rib = sortTable([...best.values()]);
    const sig = JSON.stringify(rib);
    if (sig === lastSig) break;
    lastSig = sig;
  }
  return { table: rib, status };
}

export function buildStaticTables(topo: Topology): { tables: Tables; status: Record<string, StaticStatus[]> } {
  const tables: Tables = {};
  const status: Record<string, StaticStatus[]> = {};
  for (const r of routers(topo)) {
    const b = buildStaticTable(topo, r.id);
    tables[r.id] = b.table;
    status[r.id] = b.status;
  }
  return { tables, status };
}

export function connectedOnlyTables(topo: Topology): Tables {
  return Object.fromEntries(routers(topo).map((r) => [r.id, sortTable(connectedRoutes(topo, r.id))]));
}

/** Plain-English description of a route. */
export function describeRoute(topo: Topology, routerId: string, r: Route): string {
  const dev = getDevice(topo, routerId);
  const ifName = dev?.ifaces.find((i) => i.id === r.iface)?.name ?? '?';
  const dest = r.prefix === 0 ? 'any network not matched by a more specific route (default route)' : `network ${routeKey(r)}`;
  if (r.unreachable) return `${routeKey(r)} is currently unreachable (metric = infinity). Packets for it are dropped.`;
  if (r.source === 'connected') return `${routeKey(r)} is directly connected on ${ifName}. Deliver packets straight to the destination host.`;
  const neighbor = r.nextHop ? topo.devices.find((d) => d.ifaces.some((i) => i.ip === (r.resolvedVia ?? r.nextHop)))?.name : undefined;
  if (!r.nextHop) return `To reach ${dest}, send the packet out of interface ${ifName}.`;
  const viaText = r.resolvedVia && r.resolvedVia !== r.nextHop ? ` (resolved recursively; the packet actually goes to ${r.resolvedVia})` : '';
  return `To reach ${dest}, send the packet to neighbour ${neighbor ?? r.nextHop} (${r.nextHop}) through interface ${ifName}${viaText}.`;
}

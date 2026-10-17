import { inSubnet, networkOf, parseIp } from './ip';
import type { Device, DeviceKind, Iface, Link, Topology } from './types';

export function getDevice(topo: Topology, id: string): Device | undefined {
  return topo.devices.find((d) => d.id === id);
}

export function deviceName(topo: Topology, id: string): string {
  return getDevice(topo, id)?.name ?? id;
}

export function getIface(topo: Topology, devId: string, ifaceId: string): Iface | undefined {
  return getDevice(topo, devId)?.ifaces.find((i) => i.id === ifaceId);
}

export function ifaceName(topo: Topology, devId: string, ifaceId: string | null | undefined): string {
  if (!ifaceId) return '-';
  return getIface(topo, devId, ifaceId)?.name ?? ifaceId;
}

export function linkOfIface(topo: Topology, devId: string, ifaceId: string): Link | undefined {
  return topo.links.find((l) => (l.a.dev === devId && l.a.iface === ifaceId) || (l.b.dev === devId && l.b.iface === ifaceId));
}

export function otherEnd(link: Link, devId: string) {
  return link.a.dev === devId ? link.b : link.a;
}

export function localEnd(link: Link, devId: string) {
  return link.a.dev === devId ? link.a : link.b;
}

/** An interface is usable when it has an address and its link is enabled. */
export function ifaceUp(topo: Topology, devId: string, ifaceId: string): boolean {
  const ifc = getIface(topo, devId, ifaceId);
  if (!ifc || !ifc.ip) return false;
  const link = linkOfIface(topo, devId, ifaceId);
  return !!link && link.up;
}

export interface Neighbor {
  router: string;
  link: Link;
  localIface: Iface;
  remoteIface: Iface;
  cost: number;
}

/** Router neighbours over enabled links whose two ends share a subnet. */
export function routerNeighbors(topo: Topology, routerId: string): Neighbor[] {
  const out: Neighbor[] = [];
  for (const link of topo.links) {
    if (!link.up) continue;
    if (link.a.dev !== routerId && link.b.dev !== routerId) continue;
    const me = localEnd(link, routerId);
    const them = otherEnd(link, routerId);
    const peer = getDevice(topo, them.dev);
    if (!peer || peer.kind !== 'router') continue;
    const li = getIface(topo, routerId, me.iface);
    const ri = getIface(topo, them.dev, them.iface);
    if (!li || !ri || !li.ip || !ri.ip) continue;
    if (!inSubnet(ri.ip, li.ip, li.prefix) || li.prefix !== ri.prefix) continue;
    out.push({ router: peer.id, link, localIface: li, remoteIface: ri, cost: link.cost });
  }
  return out.sort((x, y) => x.router.localeCompare(y.router, undefined, { numeric: true }) || x.link.id.localeCompare(y.link.id));
}

export function routers(topo: Topology): Device[] {
  return topo.devices.filter((d) => d.kind === 'router');
}

export function pcs(topo: Topology): Device[] {
  return topo.devices.filter((d) => d.kind === 'pc');
}

/** Which device/interface owns an address (first match). */
export function ownerOfIp(topo: Topology, ip: string): { dev: Device; iface: Iface } | undefined {
  for (const dev of topo.devices) {
    for (const iface of dev.ifaces) if (iface.ip === ip) return { dev, iface };
  }
  return undefined;
}

// ---------------------------------------------------------------- editing helpers (pure)

function nextId(topo: Topology, prefix: string): string {
  const used = new Set<string>([...topo.devices.map((d) => d.id), ...topo.links.map((l) => l.id)]);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

function nextName(topo: Topology, base: string): string {
  const used = new Set(topo.devices.map((d) => d.name));
  let n = 1;
  while (used.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}

export function addDevice(topo: Topology, kind: DeviceKind, x: number, y: number): { topo: Topology; id: string } {
  const t = clone(topo);
  const id = nextId(t, kind === 'router' ? 'r' : 'pc');
  t.devices.push({ id, kind, name: nextName(t, kind === 'router' ? 'R' : 'PC'), x, y, ifaces: [], staticRoutes: [], gateway: kind === 'pc' ? '' : undefined });
  return { topo: t, id };
}

export function removeDevice(topo: Topology, id: string): Topology {
  const t = clone(topo);
  const removedLinks = t.links.filter((l) => l.a.dev === id || l.b.dev === id);
  t.links = t.links.filter((l) => !removedLinks.includes(l));
  for (const l of removedLinks) {
    const o = otherEnd(l, id);
    const d = getDevice(t, o.dev);
    if (d) d.ifaces = d.ifaces.filter((i) => i.id !== o.iface);
  }
  t.devices = t.devices.filter((d) => d.id !== id);
  return t;
}

export function removeLink(topo: Topology, linkId: string): Topology {
  const t = clone(topo);
  const link = t.links.find((l) => l.id === linkId);
  if (!link) return t;
  for (const end of [link.a, link.b]) {
    const d = getDevice(t, end.dev);
    if (d) d.ifaces = d.ifaces.filter((i) => i.id !== end.iface);
  }
  t.links = t.links.filter((l) => l.id !== linkId);
  return t;
}

function usedNetworks(topo: Topology): Set<string> {
  const s = new Set<string>();
  for (const d of topo.devices) for (const i of d.ifaces) if (i.ip) s.add(`${networkOf(i.ip, i.prefix)}/${i.prefix}`);
  return s;
}

function numberIn(name: string): number | null {
  const m = /(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

function newIface(dev: Device): Iface {
  if (dev.kind === 'pc') return { id: `${dev.id}-eth${dev.ifaces.length}`, name: `eth${dev.ifaces.length}`, ip: '', prefix: 24 };
  let n = 0;
  while (dev.ifaces.some((i) => i.name === `G0/0/${n}`)) n++;
  return { id: `${dev.id}-g${n}`, name: `G0/0/${n}`, ip: '', prefix: 24 };
}

/**
 * Connect two devices and assign sensible addresses:
 *  router Ri – router Rj : 10.0.ij.0/24 (Ri = .i, Rj = .j) when possible
 *  router Rk – PC         : 192.168.k.0/24 (router .1, PC .10, PC gateway = router)
 */
export function addLink(topo: Topology, aId: string, bId: string): { topo: Topology; error?: string; id?: string } {
  if (aId === bId) return { topo, error: 'A link needs two different devices.' };
  const t = clone(topo);
  const a = getDevice(t, aId);
  const b = getDevice(t, bId);
  if (!a || !b) return { topo, error: 'Device not found.' };
  if (a.kind === 'pc' && b.kind === 'pc') return { topo, error: 'This lab connects PCs to routers only (switches are not modelled).' };
  const pc = a.kind === 'pc' ? a : b.kind === 'pc' ? b : null;
  if (pc && pc.ifaces.length > 0) return { topo, error: `${pc.name} already has a link. Each PC has one network card in this lab.` };
  if (t.links.some((l) => (l.a.dev === aId && l.b.dev === bId) || (l.a.dev === bId && l.b.dev === aId)))
    return { topo, error: 'These devices are already linked.' };

  const ia = newIface(a);
  a.ifaces.push(ia);
  const ib = newIface(b);
  b.ifaces.push(ib);
  const id = nextId(t, 'l');
  t.links.push({ id, a: { dev: aId, iface: ia.id }, b: { dev: bId, iface: ib.id }, cost: 1, up: true });

  const used = usedNetworks(topo);
  if (!pc) {
    const na = numberIn(a.name);
    const nb = numberIn(b.name);
    let third: number | null = null;
    if (na && nb && na < 10 && nb < 10) {
      const c = Math.min(na, nb) * 10 + Math.max(na, nb);
      if (!used.has(`10.0.${c}.0/24`)) third = c;
    }
    for (let n = 100; third === null && n < 255; n++) if (!used.has(`10.0.${n}.0/24`)) third = n;
    if (third !== null) {
      const ha = na && nb && na !== nb && na < 255 ? na : 1;
      const hb = na && nb && na !== nb && nb < 255 ? nb : 2;
      ia.ip = `10.0.${third}.${ha}`;
      ib.ip = `10.0.${third}.${hb}`;
    }
  } else {
    const router = pc === a ? b : a;
    const rIf = pc === a ? ib : ia;
    const pIf = pc === a ? ia : ib;
    const k = numberIn(router.name);
    let third: number | null = null;
    if (k && k < 100 && !used.has(`192.168.${k}.0/24`)) third = k;
    for (let n = 100; third === null && n < 255; n++) if (!used.has(`192.168.${n}.0/24`)) third = n;
    if (third !== null) {
      rIf.ip = `192.168.${third}.1`;
      pIf.ip = `192.168.${third}.10`;
      pc.gateway = rIf.ip;
    }
  }
  return { topo: t, id };
}

export function sortIps(ips: string[]): string[] {
  return [...ips].sort((x, y) => (parseIp(x) ?? 0) - (parseIp(y) ?? 0));
}

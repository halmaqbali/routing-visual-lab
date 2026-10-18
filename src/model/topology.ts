import { formatIp, inSubnet, networkOf, parseIp } from './ip';
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

export const isLoopback = (i: Iface) => i.kind === 'loopback';

/** An interface is usable when it has an address and (unless it is a loopback) its link is enabled. */
export function ifaceUp(topo: Topology, devId: string, ifaceId: string): boolean {
  const ifc = getIface(topo, devId, ifaceId);
  if (!ifc || !ifc.ip) return false;
  if (isLoopback(ifc)) return true;
  const link = linkOfIface(topo, devId, ifaceId);
  return !!link && link.up;
}

/** Stable, locally administered MAC address (02:...) derived from device and interface ids. */
export function macOf(devId: string, iface: Iface): string {
  if (iface.mac) return iface.mac;
  let h = 2166136261;
  for (const ch of `${devId}/${iface.id}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const b = [0x02, 0x00, (h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255];
  return b.map((x) => x.toString(16).padStart(2, '0')).join(':');
}

export const BROADCAST_MAC = 'ff:ff:ff:ff:ff:ff';

// ---------------------------------------------------------------- Layer 2 segments

export interface Endpoint {
  dev: Device;
  iface: Iface;
}

/**
 * Everything reachable at Layer 2 from one interface: the routers' and PCs' interfaces on the same
 * broadcast domain, and the switches in between. Only enabled links are followed.
 */
export function segmentOf(topo: Topology, devId: string, ifaceId: string): { endpoints: Endpoint[]; switches: string[] } {
  const endpoints: Endpoint[] = [];
  const switches: string[] = [];
  const start = linkOfIface(topo, devId, ifaceId);
  if (!start || !start.up) return { endpoints, switches };
  const seenSw = new Set<string>();
  const queue: { dev: string; iface: string }[] = [otherEnd(start, devId)];
  const self = getDevice(topo, devId);
  const selfIf = self?.ifaces.find((i) => i.id === ifaceId);
  if (self && selfIf && self.kind !== 'switch') endpoints.push({ dev: self, iface: selfIf });
  while (queue.length) {
    const end = queue.shift()!;
    const d = getDevice(topo, end.dev);
    if (!d) continue;
    if (d.kind !== 'switch') {
      const i = d.ifaces.find((x) => x.id === end.iface);
      if (i && !endpoints.some((e) => e.dev.id === d.id && e.iface.id === i.id)) endpoints.push({ dev: d, iface: i });
      continue;
    }
    if (seenSw.has(d.id)) continue;
    seenSw.add(d.id);
    switches.push(d.id);
    for (const port of d.ifaces) {
      const l = linkOfIface(topo, d.id, port.id);
      if (l && l.up) queue.push(otherEnd(l, d.id));
    }
  }
  return { endpoints, switches };
}

/** Devices crossed by a frame from one interface to another on the same segment (both ends included). */
export function l2Path(topo: Topology, fromDev: string, fromIface: string, toDev: string, toIface: string): string[] | null {
  const start = linkOfIface(topo, fromDev, fromIface);
  if (!start || !start.up) return null;
  const prev = new Map<string, string>();
  const first = otherEnd(start, fromDev);
  if (first.dev === toDev) return first.iface === toIface ? [fromDev, toDev] : null;
  const queue: string[] = [];
  if (getDevice(topo, first.dev)?.kind === 'switch') {
    queue.push(first.dev);
    prev.set(first.dev, fromDev);
  }
  while (queue.length) {
    const sw = queue.shift()!;
    for (const port of getDevice(topo, sw)!.ifaces) {
      const l = linkOfIface(topo, sw, port.id);
      if (!l || !l.up) continue;
      const o = otherEnd(l, sw);
      if (prev.has(o.dev) || o.dev === fromDev) continue;
      if (o.dev === toDev && o.iface === toIface) {
        const path = [toDev, sw];
        let c = sw;
        while (prev.get(c) && prev.get(c) !== fromDev) {
          c = prev.get(c)!;
          path.push(c);
        }
        path.push(fromDev);
        return path.reverse();
      }
      if (getDevice(topo, o.dev)?.kind === 'switch') {
        prev.set(o.dev, sw);
        queue.push(o.dev);
      }
    }
  }
  return null;
}

export interface Neighbor {
  router: string;
  /** Adjacency id, the same on both routers: the link id for a direct link, or a key for routers meeting through switches. */
  key: string;
  /** This router's own physical link on the adjacency. */
  link: Link;
  localIface: Iface;
  remoteIface: Iface;
  cost: number;
  /** Devices crossed between the two routers (both included), e.g. [R1, SW1, R2]. */
  path: string[];
}

/** Router neighbours: other routers on the same Layer 2 segment (direct link or via switches) in the same subnet. */
export function routerNeighbors(topo: Topology, routerId: string): Neighbor[] {
  const out: Neighbor[] = [];
  const me = getDevice(topo, routerId);
  if (!me) return out;
  for (const li of me.ifaces) {
    if (isLoopback(li) || !li.ip) continue;
    const link = linkOfIface(topo, routerId, li.id);
    if (!link || !link.up) continue;
    for (const ep of segmentOf(topo, routerId, li.id).endpoints) {
      if (ep.dev.id === routerId || ep.dev.kind !== 'router') continue;
      const ri = ep.iface;
      if (!ri.ip || !inSubnet(ri.ip, li.ip, li.prefix) || li.prefix !== ri.prefix) continue;
      const direct = otherEnd(link, routerId).dev === ep.dev.id;
      const key = direct ? link.id : `seg:${[`${routerId}/${li.id}`, `${ep.dev.id}/${ri.id}`].sort().join('|')}`;
      const path = l2Path(topo, routerId, li.id, ep.dev.id, ri.id) ?? [routerId, ep.dev.id];
      out.push({ router: ep.dev.id, key, link, localIface: li, remoteIface: ri, cost: link.cost, path });
    }
  }
  return out.sort((x, y) => x.router.localeCompare(y.router, undefined, { numeric: true }) || x.key.localeCompare(y.key));
}

export function routers(topo: Topology): Device[] {
  return topo.devices.filter((d) => d.kind === 'router');
}

export function pcs(topo: Topology): Device[] {
  return topo.devices.filter((d) => d.kind === 'pc');
}

export function switches(topo: Topology): Device[] {
  return topo.devices.filter((d) => d.kind === 'switch');
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

const KIND_PREFIX: Record<DeviceKind, [idPrefix: string, namePrefix: string]> = { router: ['r', 'R'], pc: ['pc', 'PC'], switch: ['sw', 'SW'] };

export function addDevice(topo: Topology, kind: DeviceKind, x: number, y: number): { topo: Topology; id: string } {
  const t = clone(topo);
  const [ip, np] = KIND_PREFIX[kind];
  const id = nextId(t, ip);
  t.devices.push({ id, kind, name: nextName(t, np), x, y, ifaces: [], staticRoutes: [], gateway: kind === 'pc' ? '' : undefined });
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

/** Add a loopback interface (LoopBack0, LoopBack1, ...) to a router. */
export function addLoopback(topo: Topology, routerId: string, ip = '', prefix = 24): Topology {
  const t = clone(topo);
  const d = getDevice(t, routerId);
  if (!d || d.kind !== 'router') return t;
  let n = 0;
  while (d.ifaces.some((i) => i.name === `LoopBack${n}`)) n++;
  const k = numberIn(d.name);
  const used = usedNetworks(t);
  const auto = !ip && k && k < 255 && n === 0 && !used.has(`10.${k}.${k}.0/24`) ? `10.${k}.${k}.${k}` : ip;
  d.ifaces.push({ id: `${d.id}-lo${n}`, name: `LoopBack${n}`, ip: auto, prefix, kind: 'loopback' });
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
  if (dev.kind === 'switch') {
    let n = 1;
    while (dev.ifaces.some((i) => i.name === `Port ${n}`)) n++;
    return { id: `${dev.id}-p${n}`, name: `Port ${n}`, ip: '', prefix: 24 };
  }
  let n = 0;
  while (dev.ifaces.some((i) => i.name === `G0/0/${n}`)) n++;
  return { id: `${dev.id}-g${n}`, name: `G0/0/${n}`, ip: '', prefix: 24 };
}

/** Give an interface joining a switched segment an address in that segment's subnet (or a new LAN). */
function addressOnSegment(t: Topology, dev: Device, iface: Iface, before: Topology) {
  const seg = segmentOf(t, dev.id, iface.id).endpoints.filter((e) => !(e.dev.id === dev.id && e.iface.id === iface.id));
  const withIp = seg.find((e) => e.iface.ip);
  const used = new Set(seg.map((e) => e.iface.ip).filter(Boolean));
  let net: string;
  let prefix = 24;
  if (withIp) {
    prefix = withIp.iface.prefix;
    net = networkOf(withIp.iface.ip, prefix);
  } else {
    const nets = usedNetworks(before);
    const k = dev.kind === 'router' ? numberIn(dev.name) : null;
    let third: number | null = k && k < 100 && !nets.has(`192.168.${k}.0/24`) ? k : null;
    for (let n = 100; third === null && n < 255; n++) if (!nets.has(`192.168.${n}.0/24`)) third = n;
    if (third === null) return;
    net = `192.168.${third}.0`;
  }
  const base = parseIp(net)!;
  const size = 2 ** (32 - prefix);
  const candidates = dev.kind === 'router' ? [1, 2, 3, 4, 5, 6, 7, 8, 9] : Array.from({ length: Math.min(size - 2, 240) }, (_, i) => i + 10);
  for (const h of candidates) {
    if (h >= size - 1) break;
    const ip = formatIp((base + h) >>> 0);
    if (!used.has(ip) && !ownerOfIp(t, ip)) {
      iface.ip = ip;
      iface.prefix = prefix;
      break;
    }
  }
  // Default gateways: a PC uses the first router on its segment; PCs without a working gateway adopt a new router.
  const routerEp = [...seg, { dev, iface }].find((e) => e.dev.kind === 'router' && e.iface.ip);
  if (!routerEp) return;
  for (const e of [...seg, { dev, iface }]) {
    if (e.dev.kind !== 'pc' || !e.iface.ip) continue;
    if (!e.dev.gateway || !inSubnet(e.dev.gateway, e.iface.ip, e.iface.prefix)) e.dev.gateway = routerEp.iface.ip;
  }
}

/**
 * Connect two devices and assign sensible addresses:
 *  router Ri – router Rj : 10.0.ij.0/24 (Ri = .i, Rj = .j) when possible
 *  router Rk – PC         : 192.168.k.0/24 (router .1, PC .10, PC gateway = router)
 *  anything – switch      : an address in the switched LAN's subnet (or a new 192.168.x.0/24 LAN)
 */
export function addLink(topo: Topology, aId: string, bId: string): { topo: Topology; error?: string; id?: string } {
  if (aId === bId) return { topo, error: 'A link needs two different devices.' };
  const t = clone(topo);
  const a = getDevice(t, aId);
  const b = getDevice(t, bId);
  if (!a || !b) return { topo, error: 'Device not found.' };
  if (a.kind === 'pc' && b.kind === 'pc') return { topo, error: 'Connect two PCs through a switch (or a router). Direct PC-to-PC cables are not modelled.' };
  const pc = a.kind === 'pc' ? a : b.kind === 'pc' ? b : null;
  if (pc && pc.ifaces.length > 0) return { topo, error: `${pc.name} already has a link. Each PC has one network card; connect more PCs through a switch.` };
  if (t.links.some((l) => (l.a.dev === aId && l.b.dev === bId) || (l.a.dev === bId && l.b.dev === aId)))
    return { topo, error: 'These devices are already linked.' };

  const ia = newIface(a);
  a.ifaces.push(ia);
  const ib = newIface(b);
  b.ifaces.push(ib);
  const id = nextId(t, 'l');
  t.links.push({ id, a: { dev: aId, iface: ia.id }, b: { dev: bId, iface: ib.id }, cost: 1, up: true });

  const used = usedNetworks(topo);
  if (a.kind === 'switch' || b.kind === 'switch') {
    if (a.kind !== 'switch') addressOnSegment(t, a, ia, topo);
    if (b.kind !== 'switch') addressOnSegment(t, b, ib, topo);
  } else if (!pc) {
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

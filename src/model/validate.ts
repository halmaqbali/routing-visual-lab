import { cidr, hostAddressProblem, inSubnet, isNetworkAddress, isValidIp, isValidPrefix, networkOf } from './ip';
import { getDevice, isLoopback, segmentOf } from './topology';
import type { Device, StaticRoute, Topology } from './types';

export interface Issue {
  severity: 'error' | 'warning';
  dev?: string;
  link?: string;
  route?: string;
  message: string;
}

export function validateIfaceAddress(ip: string, prefix: number): string | null {
  if (!ip) return null;
  if (!isValidIp(ip)) return `"${ip}" is not a valid IPv4 address. Use four numbers from 0 to 255, e.g. 192.168.1.1.`;
  if (!isValidPrefix(prefix) || prefix < 1 || prefix > 31) return `Prefix /${prefix} is not usable on an interface. Use a prefix from /1 to /31 (usually /24 or /30).`;
  return hostAddressProblem(ip, prefix);
}

export function validateStaticRoute(_topo: Topology, dev: Device, r: StaticRoute): Issue[] {
  const out: Issue[] = [];
  const at = (message: string, severity: Issue['severity'] = 'error') => out.push({ severity, dev: dev.id, route: r.id, message: `${dev.name} static route ${r.network}/${r.prefix}: ${message}` });
  if (!isValidIp(r.network)) at(`destination "${r.network}" is not a valid IPv4 network.`);
  else if (!isValidPrefix(r.prefix)) at(`prefix length must be 0–32.`);
  else if (!isNetworkAddress(r.network, r.prefix))
    at(`${r.network} has host bits set for /${r.prefix}. The network address is ${networkOf(r.network, r.prefix)}/${r.prefix}.`);
  if (!r.nextHop && !r.iface) at('give a next-hop address, an exit interface, or both.');
  if (r.nextHop) {
    if (!isValidIp(r.nextHop)) at(`next hop "${r.nextHop}" is not a valid IPv4 address.`);
    else if (dev.ifaces.some((i) => i.ip === r.nextHop)) at(`next hop ${r.nextHop} is this router's own address. The next hop must be a neighbouring router.`);
    else if (r.iface) {
      const ifc = dev.ifaces.find((i) => i.id === r.iface);
      if (ifc && ifc.ip && !inSubnet(r.nextHop, ifc.ip, ifc.prefix)) at(`next hop ${r.nextHop} is not in the subnet of exit interface ${ifc.name} (${cidr(networkOf(ifc.ip, ifc.prefix), ifc.prefix)}).`);
    } else if (!dev.ifaces.some((i) => i.ip && inSubnet(r.nextHop, i.ip, i.prefix)))
      at(`next hop ${r.nextHop} is not on a directly connected network. It will only work through recursive lookup of another route.`, 'warning');
  }
  if (r.iface && !dev.ifaces.some((i) => i.id === r.iface)) at('exit interface no longer exists.');
  if (!Number.isInteger(r.ad) || r.ad < 1 || r.ad > 255) at('administrative distance must be 1–255.');
  return out;
}

export function validateTopology(topo: Topology): Issue[] {
  const issues: Issue[] = [];
  const seenIp = new Map<string, string>();
  const subnetOwner = new Map<string, string>(); // subnet -> where it is used

  for (const dev of topo.devices) {
    if (!dev.name.trim()) issues.push({ severity: 'error', dev: dev.id, message: 'A device has an empty name.' });
    for (const ifc of dev.ifaces) {
      const where = `${dev.name} ${ifc.name}`;
      if (dev.kind === 'switch') {
        if (ifc.ip) issues.push({ severity: 'error', dev: dev.id, message: `${where}: an unmanaged switch port has no IP address. Remove ${ifc.ip}; switches forward Ethernet frames and do not route IP.` });
        continue;
      }
      if (!ifc.ip) {
        issues.push({ severity: 'warning', dev: dev.id, message: `${where} has no IP address, so it cannot send or receive IP packets.` });
        continue;
      }
      const p = validateIfaceAddress(ifc.ip, ifc.prefix);
      if (p) {
        issues.push({ severity: 'error', dev: dev.id, message: `${where}: ${p}` });
        continue;
      }
      const prev = seenIp.get(ifc.ip);
      if (prev) issues.push({ severity: 'error', dev: dev.id, message: `Duplicate address ${ifc.ip}: used by ${prev} and ${where}. Every interface needs a unique address.` });
      else seenIp.set(ifc.ip, where);
    }
    const dup = dev.ifaces.filter((i) => i.ip).map((i) => cidr(networkOf(i.ip, i.prefix), i.prefix));
    const dupSet = dup.filter((s, k) => dup.indexOf(s) !== k);
    for (const s of new Set(dupSet)) issues.push({ severity: 'error', dev: dev.id, message: `${dev.name} has two interfaces in the same network ${s}. Each router interface must be in a different network.` });

    if (dev.kind === 'pc') {
      const ifc = dev.ifaces[0];
      if (!dev.gateway) issues.push({ severity: 'warning', dev: dev.id, message: `${dev.name} has no default gateway. It can only reach its own subnet.` });
      else if (!isValidIp(dev.gateway)) issues.push({ severity: 'error', dev: dev.id, message: `${dev.name} default gateway "${dev.gateway}" is not a valid IPv4 address.` });
      else if (ifc && ifc.ip && !inSubnet(dev.gateway, ifc.ip, ifc.prefix))
        issues.push({ severity: 'error', dev: dev.id, message: `${dev.name} default gateway ${dev.gateway} is not in its own subnet ${cidr(networkOf(ifc.ip, ifc.prefix), ifc.prefix)}. A gateway must be directly reachable.` });
      else if (ifc) {
        const seg = segmentOf(topo, dev.id, ifc.id).endpoints;
        const routersOnSeg = seg.filter((e) => e.dev.kind === 'router');
        if (seg.length > 1 && !routersOnSeg.some((e) => e.iface.ip === dev.gateway))
          issues.push({ severity: 'error', dev: dev.id, message: `${dev.name} default gateway ${dev.gateway} is not a router interface on its network (${routersOnSeg.map((e) => `${e.dev.name} ${e.iface.ip || 'no address'}`).join(', ') || 'no router connected'}).` });
      }
    } else if (dev.kind === 'router') {
      for (const r of dev.staticRoutes) issues.push(...validateStaticRoute(topo, dev, r));
    }
  }

  // Switch loops: this lab has no Spanning Tree Protocol, so a loop of switches would cause a broadcast storm.
  const parent = new Map<string, string>();
  const find = (x: string): string => (parent.get(x) ?? x) === x ? x : find(parent.get(x)!);
  for (const link of topo.links) {
    const da = getDevice(topo, link.a.dev);
    const db = getDevice(topo, link.b.dev);
    if (!link.up || da?.kind !== 'switch' || db?.kind !== 'switch') continue;
    const ra = find(da.id);
    const rb = find(db.id);
    if (ra === rb) issues.push({ severity: 'error', link: link.id, message: `Switch loop through ${da.name}–${db.name}. Unmanaged switches here have no Spanning Tree Protocol, so a loop would flood broadcasts forever. Disable or remove one of the links.` });
    else parent.set(ra, rb);
  }

  for (const link of topo.links) {
    const na = getDevice(topo, link.a.dev)?.name;
    const nb = getDevice(topo, link.b.dev)?.name;
    if (!Number.isFinite(link.cost) || link.cost < 1 || !Number.isInteger(link.cost)) issues.push({ severity: 'error', link: link.id, message: `Link ${na}–${nb} cost must be a whole number of at least 1.` });
  }

  // Each Layer 2 segment (a direct link, or everything joined by switches) must use exactly one subnet.
  const seen = new Set<string>();
  for (const dev of topo.devices) {
    if (dev.kind === 'switch') continue;
    for (const ifc of dev.ifaces) {
      if (isLoopback(ifc) || seen.has(`${dev.id}/${ifc.id}`)) continue;
      const seg = segmentOf(topo, dev.id, ifc.id).endpoints;
      seg.forEach((e) => seen.add(`${e.dev.id}/${e.iface.id}`));
      const addressed = seg.filter((e) => e.iface.ip && !validateIfaceAddress(e.iface.ip, e.iface.prefix));
      if (addressed.length === 0) continue;
      const first = addressed[0];
      const odd = addressed.filter((e) => e.iface.prefix !== first.iface.prefix || !inSubnet(e.iface.ip, first.iface.ip, first.iface.prefix));
      const label = seg.map((e) => e.dev.name).join(', ');
      if (odd.length)
        issues.push({ severity: 'error', dev: odd[0].dev.id, message: `${label} share one network segment but are not in the same subnet (${addressed.map((e) => `${e.dev.name} ${e.iface.ip}/${e.iface.prefix}`).join(', ')}). Devices that can reach each other directly must use one subnet.` });
      else {
        const sn = cidr(networkOf(first.iface.ip, first.iface.prefix), first.iface.prefix);
        const prev = subnetOwner.get(sn);
        if (prev) issues.push({ severity: 'error', dev: first.dev.id, message: `Network ${sn} is used on two separate segments (${prev} and ${label}). Each link or switched LAN needs its own network.` });
        else subnetOwner.set(sn, label);
      }
    }
    for (const ifc of dev.ifaces.filter(isLoopback)) {
      if (!ifc.ip || validateIfaceAddress(ifc.ip, ifc.prefix)) continue;
      const sn = cidr(networkOf(ifc.ip, ifc.prefix), ifc.prefix);
      const prev = subnetOwner.get(sn);
      if (prev) issues.push({ severity: 'error', dev: dev.id, message: `${dev.name} ${ifc.name} network ${sn} is already used by ${prev}. A loopback needs its own network.` });
      else subnetOwner.set(sn, `${dev.name} ${ifc.name}`);
    }
  }
  return issues;
}

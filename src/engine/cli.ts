// Huawei VRP / Cisco IOS command generation from the same configuration model the simulator uses.
import { maskString, networkOf, parseIp } from '../model/ip';
import { linkOfIface } from '../model/topology';
import type { Device, DvOptions, Mode, Topology } from '../model/types';

const fullName = (short: string) => short.replace(/^G/, 'GigabitEthernet');

/** Huawei uses a preference value (static default 60). AD a maps to preference 59 + a so ordering is preserved. */
export const huaweiPreference = (ad: number) => Math.min(255, 59 + ad);

function classful(ip: string): string {
  const first = (parseIp(ip) ?? 0) >>> 24;
  const len = first < 128 ? 8 : first < 192 ? 16 : 24;
  return networkOf(ip, len);
}

function wildcard(len: number) {
  return maskString(len)
    .split('.')
    .map((o) => 255 - Number(o))
    .join('.');
}

export function generateCli(topo: Topology, dev: Device, mode: Mode, dv: DvOptions, vendor: 'cisco' | 'huawei'): string[] {
  if (dev.kind !== 'router') return [];
  const L: string[] = [];
  const cisco = vendor === 'cisco';
  L.push(cisco ? 'enable' : 'system-view', cisco ? 'configure terminal' : '', cisco ? `hostname ${dev.name}` : `sysname ${dev.name}`);
  for (const i of dev.ifaces) {
    const link = linkOfIface(topo, dev.id, i.id);
    L.push(`interface ${fullName(i.name)}`);
    if (i.ip) L.push(cisco ? ` ip address ${i.ip} ${maskString(i.prefix)}` : ` ip address ${i.ip} ${i.prefix}`);
    if (mode === 'ls' && link) L.push(cisco ? ` ip ospf cost ${link.cost}` : ` ospf cost ${link.cost}`);
    if (mode === 'dv' && dv.profile === 'rip' && !cisco) {
      if (!dv.splitHorizon && !dv.poisonReverse) L.push(' undo rip split-horizon');
      if (dv.poisonReverse) L.push(' rip poison-reverse');
    }
    if (mode === 'dv' && dv.profile === 'rip' && cisco && !dv.splitHorizon && !dv.poisonReverse) L.push(' no ip split-horizon');
    L.push(link?.up === false ? ' shutdown' : cisco ? ' no shutdown' : ' undo shutdown');
    L.push(cisco ? ' exit' : ' quit');
  }
  if (mode === 'static') {
    for (const r of dev.staticRoutes) {
      const out = r.iface ? dev.ifaces.find((i) => i.id === r.iface) : undefined;
      const pre = r.enabled ? '' : cisco ? '! (disabled) ' : '# (disabled) ';
      if (cisco) {
        const target = [out ? fullName(out.name) : '', r.nextHop].filter(Boolean).join(' ');
        L.push(`${pre}ip route ${r.network} ${maskString(r.prefix)} ${target}${r.ad !== 1 ? ` ${r.ad}` : ''}`);
      } else {
        const target = [out ? fullName(out.name) : '', r.nextHop].filter(Boolean).join(' ');
        L.push(`${pre}ip route-static ${r.network} ${r.prefix} ${target}${r.ad !== 1 ? ` preference ${huaweiPreference(r.ad)}` : ''}`);
      }
    }
  }
  if (mode === 'dv') {
    const nets = [...new Set(dev.ifaces.filter((i) => i.ip).map((i) => classful(i.ip)))];
    if (dv.profile !== 'rip') L.push(cisco ? '! Generic weighted distance vector: no real protocol. Use the RIP profile for real commands.' : '# Generic weighted distance vector: no real protocol. Use the RIP profile for real commands.');
    L.push(cisco ? 'router rip' : 'rip 1', cisco ? ' version 2' : ' version 2', cisco ? ' no auto-summary' : ' undo summary');
    for (const n of nets) L.push(` network ${n}`);
    L.push(cisco ? ' exit' : ' quit');
  }
  if (mode === 'ls') {
    L.push(cisco ? 'router ospf 1' : 'ospf 1', cisco ? '' : ' area 0');
    for (const i of dev.ifaces.filter((x) => x.ip)) L.push(cisco ? ` network ${networkOf(i.ip, i.prefix)} ${wildcard(i.prefix)} area 0` : `  network ${networkOf(i.ip, i.prefix)} ${wildcard(i.prefix)}`);
    L.push(cisco ? ' exit' : ' quit');
  }
  L.push(cisco ? 'end' : 'return');
  return L.filter((x) => x !== '');
}

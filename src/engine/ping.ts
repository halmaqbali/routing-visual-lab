// Packet forwarding: a simulated ICMP echo request and echo reply, hop by hop.
import { cidr, inSubnet, networkOf } from '../model/ip';
import { getDevice, ifaceName, linkOfIface, otherEnd } from '../model/topology';
import type { Device, Topology } from '../model/types';
import { explainMatch, lookup, routeKey, type Route, type Tables } from './rib';

export type FailureCode =
  | 'invalid-config'
  | 'no-gateway'
  | 'gateway-unreachable'
  | 'no-route'
  | 'missing-return-route'
  | 'next-hop-unreachable'
  | 'link-down'
  | 'host-unreachable'
  | 'ttl-expired';

export interface HopStep {
  phase: 'request' | 'reply';
  at: string;
  action: 'send' | 'forward' | 'deliver' | 'receive' | 'drop';
  srcIp: string;
  dstIp: string;
  ttlIn: number;
  ttlOut: number;
  table?: Route[];
  candidates?: Route[];
  chosen?: Route | null;
  why: string;
  nextHopIp?: string;
  outIface?: string;
  outIfaceName?: string;
  toDevice?: string;
  linkId?: string;
  failure?: FailureCode;
  message: string;
}

export interface PingResult {
  steps: HopStep[];
  success: boolean;
  failure?: { code: FailureCode; at: string; phase: 'request' | 'reply'; message: string };
  requestPath: string[];
  replyPath: string[];
}

const MAX_STEPS = 300;

interface Leg {
  steps: HopStep[];
  path: string[];
  delivered: boolean;
  failure?: { code: FailureCode; at: string; message: string };
}

function pcIp(pc: Device) {
  return pc.ifaces[0]?.ip ?? '';
}

/** Which device sits at the far end of an interface's link, and with what address. */
function peerOn(topo: Topology, devId: string, ifaceId: string) {
  const link = linkOfIface(topo, devId, ifaceId);
  if (!link) return null;
  const o = otherEnd(link, devId);
  const dev = getDevice(topo, o.dev);
  const ifc = dev?.ifaces.find((i) => i.id === o.iface);
  if (!dev || !ifc) return null;
  return { link, dev, ifc };
}

function leg(topo: Topology, tables: Tables, phase: 'request' | 'reply', src: Device, dstIp: string, ttl: number): Leg {
  const steps: HopStep[] = [];
  const path: string[] = [src.id];
  const fail = (code: FailureCode, at: string, message: string, extra: Partial<HopStep> = {}): Leg => {
    steps.push({ phase, at, action: 'drop', srcIp: pcIp(src), dstIp, ttlIn: extra.ttlIn ?? ttl, ttlOut: extra.ttlOut ?? ttl, why: message, failure: code, message, ...extra });
    return { steps, path, delivered: false, failure: { code, at, message } };
  };
  const srcIp = pcIp(src);
  const sIf = src.ifaces[0];
  const kind = phase === 'request' ? 'echo request' : 'echo reply';
  if (!sIf || !srcIp) return fail('invalid-config', src.id, `${src.name} has no IP address, so it cannot send an ICMP ${kind}.`);
  const link = linkOfIface(topo, src.id, sIf.id);
  const peer = peerOn(topo, src.id, sIf.id);

  // Step 1: the host decides where to send the frame.
  const local = inSubnet(dstIp, srcIp, sIf.prefix);
  let firstHopIp: string;
  let why: string;
  if (local) {
    firstHopIp = dstIp;
    why = `${dstIp} is in ${src.name}'s own subnet ${cidr(networkOf(srcIp, sIf.prefix), sIf.prefix)}, so it is delivered directly.`;
  } else {
    if (!src.gateway) return fail('no-gateway', src.id, `${dstIp} is not in ${src.name}'s subnet, and ${src.name} has no default gateway configured. A host needs a gateway to reach remote networks.`);
    if (!inSubnet(src.gateway, srcIp, sIf.prefix))
      return fail('gateway-unreachable', src.id, `${src.name}'s default gateway ${src.gateway} is not in its own subnet, so ${src.name} cannot reach it.`);
    firstHopIp = src.gateway;
    why = `${dstIp} is NOT in ${src.name}'s subnet ${cidr(networkOf(srcIp, sIf.prefix), sIf.prefix)}, so ${src.name} sends it to its default gateway ${src.gateway}.`;
  }
  if (!link || !link.up || !peer) return fail('link-down', src.id, `${src.name}'s link is disabled, so the packet cannot leave ${src.name}.`, { why });
  if (peer.ifc.ip !== firstHopIp)
    return fail(local ? 'host-unreachable' : 'gateway-unreachable', src.id, `${src.name} asks (ARP) for ${firstHopIp} on its link, but no device there has that address.`, { why });
  steps.push({
    phase, at: src.id, action: 'send', srcIp, dstIp, ttlIn: ttl, ttlOut: ttl, why, nextHopIp: firstHopIp, outIface: sIf.id, outIfaceName: sIf.name, toDevice: peer.dev.id, linkId: link.id,
    message: `${src.name} sends an ICMP ${kind} to ${dstIp} (TTL ${ttl}). Next hop: ${firstHopIp} (${peer.dev.name}). The destination IP stays ${dstIp}.`,
  });

  let cur = peer.dev;
  let ttlNow = ttl;
  path.push(cur.id);
  for (let n = 0; n < MAX_STEPS; n++) {
    if (cur.kind === 'pc') {
      if (pcIp(cur) === dstIp) {
        steps.push({ phase, at: cur.id, action: 'receive', srcIp, dstIp, ttlIn: ttlNow, ttlOut: ttlNow, why: `${dstIp} is ${cur.name}'s own address.`, message: `${cur.name} receives the ICMP ${kind}.` });
        return { steps, path, delivered: true };
      }
      return fail('host-unreachable', cur.id, `${cur.name} received a packet for ${dstIp}, which is not its address. Hosts do not forward packets, so it is dropped.`, { ttlIn: ttlNow, ttlOut: ttlNow });
    }
    // Router
    const table = tables[cur.id] ?? [];
    if (cur.ifaces.some((i) => i.ip === dstIp)) {
      steps.push({ phase, at: cur.id, action: 'receive', srcIp, dstIp, ttlIn: ttlNow, ttlOut: ttlNow, why: `${dstIp} belongs to ${cur.name} itself.`, message: `${cur.name} receives the packet (it is addressed to the router).` });
      return { steps, path, delivered: true };
    }
    const ttlOut = ttlNow - 1;
    const res = lookup(table, dstIp);
    if (ttlOut <= 0) {
      const visits = path.filter((p) => p === cur.id).length;
      const loopText = visits > 1 ? ` The packet has visited ${cur.name} ${visits} times (${path.map((p) => getDevice(topo, p)?.name).slice(-8).join(' → ')}): the routers are forwarding it in a loop.` : '';
      return fail('ttl-expired', cur.id, `TTL reached 0 at ${cur.name}, so ${cur.name} drops the packet.${loopText}`, { ttlIn: ttlNow, ttlOut: 0, table, candidates: res.candidates, chosen: res.match, why: 'TTL limits how many routers a packet may cross.' });
    }
    if (!res.match) {
      const code: FailureCode = phase === 'reply' ? 'missing-return-route' : 'no-route';
      const msg =
        phase === 'reply'
          ? `${cur.name} has no route back to ${dstIp}. The echo request arrived, but the reply cannot return: a missing return route. Routing must work in BOTH directions.`
          : `${cur.name} has no route that contains ${dstIp} and no default route, so it drops the packet.`;
      return fail(code, cur.id, msg, { ttlIn: ttlNow, ttlOut, table, candidates: [], chosen: null, why: explainMatch(res, dstIp) });
    }
    const r = res.match;
    const why = explainMatch(res, dstIp);
    const outIf = cur.ifaces.find((i) => i.id === r.iface);
    const outName = outIf?.name ?? '?';
    const p = r.iface ? peerOn(topo, cur.id, r.iface) : null;
    if (!outIf || !p || !p.link.up)
      return fail('link-down', cur.id, `${cur.name} would send the packet out of ${outName}, but that interface's link is down.`, { ttlIn: ttlNow, ttlOut, table, candidates: res.candidates, chosen: r, why });
    let target: string;
    if (r.source === 'connected') target = dstIp;
    else if (r.resolvedVia || r.nextHop) target = (r.resolvedVia ?? r.nextHop)!;
    else target = p.ifc.ip; // interface-only static: point-to-point link
    if (p.ifc.ip !== target) {
      const code: FailureCode = r.source === 'connected' ? 'host-unreachable' : 'next-hop-unreachable';
      const msg =
        r.source === 'connected'
          ? `${dstIp} is on ${cur.name}'s connected network ${routeKey(r)}, but no device on ${outName} answers ARP for ${dstIp}. Host unreachable.`
          : `${cur.name} chose next hop ${target} out of ${outName}, but no device on that link has address ${target}. Next hop unreachable.`;
      return fail(code, cur.id, msg, { ttlIn: ttlNow, ttlOut, table, candidates: res.candidates, chosen: r, why, nextHopIp: target, outIface: outIf.id, outIfaceName: outName });
    }
    const deliver = r.source === 'connected';
    steps.push({
      phase, at: cur.id, action: deliver ? 'deliver' : 'forward', srcIp, dstIp, ttlIn: ttlNow, ttlOut, table, candidates: res.candidates, chosen: r, why,
      nextHopIp: target, outIface: outIf.id, outIfaceName: outName, toDevice: p.dev.id, linkId: p.link.id,
      message: deliver
        ? `${cur.name}: ${dstIp} is on directly connected network ${routeKey(r)}. Decrease TTL ${ttlNow}→${ttlOut} and deliver it to ${p.dev.name} out of ${outName}.`
        : `${cur.name}: best match ${routeKey(r)}. Decrease TTL ${ttlNow}→${ttlOut} and forward to next hop ${target} (${p.dev.name}) out of ${outName}. The destination IP is still ${dstIp}.`,
    });
    ttlNow = ttlOut;
    cur = p.dev;
    path.push(cur.id);
  }
  return fail('ttl-expired', cur.id, 'Too many steps.');
}

export function simulatePing(topo: Topology, tables: Tables, srcId: string, dstId: string, ttl: number): PingResult {
  const src = getDevice(topo, srcId);
  const dst = getDevice(topo, dstId);
  if (!src || !dst) return { steps: [], success: false, requestPath: [], replyPath: [], failure: { code: 'invalid-config', at: srcId, phase: 'request', message: 'Choose two PCs.' } };
  const dstIp = pcIp(dst);
  if (!dstIp) {
    const message = `${dst.name} has no IP address, so it cannot be pinged.`;
    return { steps: [], success: false, requestPath: [], replyPath: [], failure: { code: 'invalid-config', at: dst.id, phase: 'request', message } };
  }
  const req = leg(topo, tables, 'request', src, dstIp, ttl);
  if (!req.delivered) return { steps: req.steps, success: false, requestPath: req.path, replyPath: [], failure: { ...req.failure!, phase: 'request' } };
  const rep = leg(topo, tables, 'reply', dst, pcIp(src), ttl);
  return {
    steps: [...req.steps, ...rep.steps],
    success: rep.delivered,
    requestPath: req.path,
    replyPath: rep.path,
    failure: rep.failure ? { ...rep.failure, phase: 'reply' } : undefined,
  };
}

export function ifaceLabel(topo: Topology, devId: string, ifaceId: string | null | undefined) {
  return ifaceName(topo, devId, ifaceId);
}

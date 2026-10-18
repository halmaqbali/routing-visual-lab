// Packet forwarding: ICMP echo request + echo reply between any PCs/routers (including loopbacks),
// with ARP resolution, switch MAC learning/flooding, longest-prefix matching and TTL at every router.
import { cidr, inSubnet, networkOf } from '../model/ip';
import { BROADCAST_MAC, deviceName, getDevice, ifaceName, ifaceUp, isLoopback, l2Path, linkOfIface, macOf, otherEnd, segmentOf, type Endpoint } from '../model/topology';
import type { Device, Iface, Topology } from '../model/types';
import { ageMacTable, cloneL2, emptyL2, type L2State } from './l2';
import { arpView, icmpView, type PacketView } from './packets';
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
  | 'frame-lost'
  | 'ttl-expired';

export type PingOutcome = 'success' | 'unreachable' | 'ttl-expired' | 'timeout';

export type HopAction =
  | 'send' | 'forward' | 'deliver' | 'receive' | 'drop'
  | 'arp-request' | 'arp-reply' | 'arp-learn' | 'switch-forward' | 'switch-flood' | 'switch-filter';

export interface HopStep {
  phase: 'request' | 'reply';
  at: string;
  action: HopAction;
  layer: 2 | 3;
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
  inIfaceName?: string;
  toDevice?: string;
  linkId?: string;
  /** Several copies leave at once (switch flooding). */
  copies?: { from: string; to: string }[];
  srcMac?: string;
  dstMac?: string;
  failure?: FailureCode;
  message: string;
  packet: PacketView;
  /** ARP caches and MAC tables after this step. */
  l2: L2State;
  /** For switch steps: what the switch learned and decided. */
  macDecision?: { switch: string; learned: string; port: string; decision: 'forward' | 'flood' | 'filter'; outPorts: string[] };
}

export interface PingRequest {
  /** Source device (PC or router). */
  src: string;
  /** Optional source address (a router may choose one of its interfaces, e.g. a loopback). */
  srcIp?: string;
  /** Destination IP address (any interface, including loopbacks). */
  dstIp: string;
  seq?: number;
}

export interface PingResult {
  steps: HopStep[];
  success: boolean;
  outcome: PingOutcome;
  outcomeText: string;
  failure?: { code: FailureCode; at: string; phase: 'request' | 'reply'; message: string };
  requestPath: string[];
  replyPath: string[];
  srcIp: string;
  dstIp: string;
  l2: L2State;
}

const MAX_STEPS = 400;

interface Ctx {
  topo: Topology;
  tables: Tables;
  l2: L2State;
  time: number;
  ttl: number;
  seq: number;
  phase: 'request' | 'reply';
  steps: HopStep[];
  origin: string;
  target?: string;
}

type NewStep = Omit<HopStep, 'l2' | 'phase'>;

function push(ctx: Ctx, s: NewStep) {
  ctx.steps.push({ ...s, phase: ctx.phase, l2: cloneL2(ctx.l2) });
}

const nm = (ctx: Ctx, id: string) => deviceName(ctx.topo, id);
const ifName = (i?: Iface | null) => i?.name;

function firstHopDevice(topo: Topology, dev: string, iface: string): { dev: string; linkId: string } | null {
  const l = linkOfIface(topo, dev, iface);
  if (!l || !l.up) return null;
  return { dev: otherEnd(l, dev).dev, linkId: l.id };
}

interface FrameSpec {
  srcMac: string;
  dstMac: string;
  view: (at: string, next: string | undefined, notes: string[]) => PacketView;
  srcIp: string;
  dstIp: string;
  ttl: number;
}

/**
 * Put a frame on the wire from (dev, iface) and follow it through switches.
 * Switches learn source MACs, forward known unicast to one port and flood broadcast/unknown unicast.
 * Returns the router/PC interfaces that received a copy, in arrival order.
 */
function transmit(ctx: Ctx, from: Device, fromIf: Iface, f: FrameSpec): Endpoint[] {
  const link = linkOfIface(ctx.topo, from.id, fromIf.id);
  if (!link || !link.up) return [];
  const arrivals: Endpoint[] = [];
  const queue: { dev: string; iface: string }[] = [otherEnd(link, from.id)];
  const visited = new Set<string>();
  while (queue.length && ctx.steps.length < MAX_STEPS) {
    const end = queue.shift()!;
    const d = getDevice(ctx.topo, end.dev);
    if (!d) continue;
    const inPort = d.ifaces.find((i) => i.id === end.iface);
    if (!inPort) continue;
    if (d.kind !== 'switch') {
      arrivals.push({ dev: d, iface: inPort });
      continue;
    }
    if (visited.has(d.id)) continue; // no loops (validation rejects switch loops)
    visited.add(d.id);
    const aged = ageMacTable(ctx.l2, d.id, ctx.time);
    const table = (ctx.l2.mac[d.id] = (ctx.l2.mac[d.id] ?? []).filter((e) => linkOfIface(ctx.topo, d.id, e.port)?.up));
    const known = table.find((e) => e.mac === f.srcMac);
    let learnText: string;
    if (!known) {
      table.push({ mac: f.srcMac, port: inPort.id, learnedAt: ctx.time });
      learnText = `It learns that ${f.srcMac} is reachable through ${inPort.name} (new MAC table entry).`;
    } else if (known.port !== inPort.id) {
      const oldPort = ifaceName(ctx.topo, d.id, known.port);
      known.port = inPort.id;
      known.learnedAt = ctx.time;
      learnText = `${f.srcMac} used to be on ${oldPort} but now arrives on ${inPort.name}, so the switch relearns it.`;
    } else {
      known.learnedAt = ctx.time;
      learnText = `${f.srcMac} is already known on ${inPort.name} (its aging timer restarts).`;
    }
    const broadcast = f.dstMac === BROADCAST_MAC;
    const entry = broadcast ? undefined : table.find((e) => e.mac === f.dstMac);
    let decision: 'forward' | 'flood' | 'filter';
    let outPorts: Iface[];
    if (entry && entry.port === inPort.id) {
      decision = 'filter';
      outPorts = [];
    } else if (entry) {
      decision = 'forward';
      outPorts = d.ifaces.filter((p) => p.id === entry.port && linkOfIface(ctx.topo, d.id, p.id)?.up);
    } else {
      decision = 'flood';
      outPorts = d.ifaces.filter((p) => p.id !== inPort.id && linkOfIface(ctx.topo, d.id, p.id)?.up);
    }
    const nexts = outPorts.map((p) => otherEnd(linkOfIface(ctx.topo, d.id, p.id)!, d.id));
    const why =
      decision === 'flood'
        ? broadcast
          ? `The destination is the broadcast address ${BROADCAST_MAC}, so the switch floods the frame out of every other port.`
          : `${f.dstMac} is not in the MAC table (unknown unicast), so the switch floods the frame out of every other port.`
        : decision === 'forward'
          ? `${f.dstMac} is in the MAC table on ${outPorts[0]?.name ?? '?'}, so the switch forwards the frame out of that port only — no flooding.`
          : `${f.dstMac} is on the same port the frame came in on, so the switch filters (drops) it.`;
    const agedText = aged.length ? ` (Aged out first: ${aged.join(', ')}.)` : '';
    push(ctx, {
      at: d.id, action: decision === 'flood' ? 'switch-flood' : decision === 'forward' ? 'switch-forward' : 'switch-filter', layer: 2,
      srcIp: f.srcIp, dstIp: f.dstIp, ttlIn: f.ttl, ttlOut: f.ttl, why,
      inIfaceName: inPort.name, outIfaceName: outPorts.map((p) => p.name).join(', ') || undefined,
      toDevice: nexts.length === 1 ? nexts[0].dev : undefined,
      copies: nexts.length > 1 ? nexts.map((n) => ({ from: d.id, to: n.dev })) : undefined,
      srcMac: f.srcMac, dstMac: f.dstMac,
      macDecision: { switch: d.id, learned: f.srcMac, port: inPort.name, decision, outPorts: outPorts.map((p) => p.name) },
      packet: f.view(d.id, nexts.length === 1 ? nexts[0].dev : undefined, [
        `${d.name} is an unmanaged Layer 2 switch: it reads only the Ethernet header (MAC addresses). It does not look at IP addresses, has no routing table and never changes the frame or the TTL.`,
        learnText, why,
      ]),
      message: `${d.name}: frame in on ${inPort.name}. ${learnText} ${why}${agedText}`,
    });
    queue.push(...nexts);
  }
  return arrivals;
}

/** Find the MAC address of `targetIp` on (dev, iface)'s network, using the ARP cache or an ARP exchange. */
function arpResolve(ctx: Ctx, dev: Device, ifc: Iface, targetIp: string, onFail: FailureCode, pkt: { srcIp: string; dstIp: string; ttl: number }): { endpoint: Endpoint | null; mac: string } | null {
  const cached = ctx.l2.arp[dev.id]?.[targetIp];
  const seg = segmentOf(ctx.topo, dev.id, ifc.id).endpoints;
  if (cached) return { endpoint: seg.find((e) => macOf(e.dev.id, e.iface) === cached.mac) ?? null, mac: cached.mac };
  const senderMac = macOf(dev.id, ifc);
  const first = firstHopDevice(ctx.topo, dev.id, ifc.id);
  const req = (at: string, next: string | undefined, notes: string[]) =>
    arpView({ op: 'request', origin: dev.id, at, next, outIface: at === dev.id ? ifc.name : undefined, frameSrc: senderMac, frameDst: BROADCAST_MAC, senderMac, senderIp: ifc.ip, targetMac: '00:00:00:00:00:00', targetIp, notes });
  push(ctx, {
    at: dev.id, action: 'arp-request', layer: 2, srcIp: pkt.srcIp, dstIp: pkt.dstIp, ttlIn: pkt.ttl, ttlOut: pkt.ttl,
    why: `${dev.name} knows the next hop's IP (${targetIp}) but needs its MAC address to build the Ethernet frame.`,
    outIfaceName: ifc.name, toDevice: first?.dev, linkId: first?.linkId, srcMac: senderMac, dstMac: BROADCAST_MAC,
    packet: req(dev.id, first?.dev, [
      `Layer 3 (IP) says WHERE the packet is going; Layer 2 (Ethernet) needs the MAC address of the NEXT device on this link. ARP finds that MAC.`,
      `The request is broadcast (${BROADCAST_MAC}) so every device on the network receives it; only the owner of ${targetIp} answers.`,
    ]),
    message: `${dev.name} has no ARP entry for ${targetIp}, so it broadcasts an ARP request out of ${ifc.name}: "Who has ${targetIp}? Tell ${ifc.ip}." The ping waits until ARP finishes.`,
  });
  const arrivals = transmit(ctx, dev, ifc, { srcMac: senderMac, dstMac: BROADCAST_MAC, view: req, ...pkt });
  const target = arrivals.find((e) => e.iface.ip === targetIp && !isLoopback(e.iface));
  const others = arrivals.filter((e) => e !== target);
  if (!target) {
    push(ctx, {
      at: dev.id, action: 'drop', layer: 2, srcIp: pkt.srcIp, dstIp: pkt.dstIp, ttlIn: pkt.ttl, ttlOut: pkt.ttl, failure: onFail,
      why: 'ARP got no reply.',
      packet: req(dev.id, undefined, ['No device on this network owns the requested address, so the frame cannot be addressed.']),
      message: `No device on ${dev.name}'s ${ifc.name} network answered the ARP request for ${targetIp}${others.length ? ` (${others.map((e) => e.dev.name).join(', ')} received it but ${targetIp} is not their address)` : ''}. Without a MAC address the packet cannot be sent, so it is dropped.`,
    });
    return null;
  }
  (ctx.l2.arp[target.dev.id] ??= {})[ifc.ip] = { mac: senderMac, learnedAt: ctx.time };
  const tMac = macOf(target.dev.id, target.iface);
  const tFirst = firstHopDevice(ctx.topo, target.dev.id, target.iface.id);
  const rep = (at: string, next: string | undefined, notes: string[]) =>
    arpView({ op: 'reply', origin: target.dev.id, target: dev.id, at, next, outIface: at === target.dev.id ? target.iface.name : undefined, frameSrc: tMac, frameDst: senderMac, senderMac: tMac, senderIp: targetIp, targetMac: senderMac, targetIp: ifc.ip, notes });
  push(ctx, {
    at: target.dev.id, action: 'arp-reply', layer: 2, srcIp: pkt.srcIp, dstIp: pkt.dstIp, ttlIn: pkt.ttl, ttlOut: pkt.ttl,
    why: `${targetIp} belongs to ${target.dev.name}.`, outIfaceName: target.iface.name, toDevice: tFirst?.dev, linkId: tFirst?.linkId, srcMac: tMac, dstMac: senderMac,
    packet: rep(target.dev.id, tFirst?.dev, ['The reply is unicast: it is addressed straight to the asker\'s MAC address.', `${target.dev.name} also saves ${ifc.ip} → ${senderMac} in its own ARP cache.`]),
    message: `${target.dev.name} owns ${targetIp}, so it sends a unicast ARP reply: "${targetIp} is at ${tMac}". It also remembers ${ifc.ip} → ${senderMac}.${others.length ? ` ${others.map((e) => e.dev.name).join(', ')} also received the broadcast but ignored it (not their address).` : ''}`,
  });
  const back = transmit(ctx, target.dev, target.iface, { srcMac: tMac, dstMac: senderMac, view: rep, ...pkt });
  if (!back.some((e) => e.dev.id === dev.id)) {
    push(ctx, { at: dev.id, action: 'drop', layer: 2, srcIp: pkt.srcIp, dstIp: pkt.dstIp, ttlIn: pkt.ttl, ttlOut: pkt.ttl, failure: 'frame-lost', why: 'The ARP reply did not arrive.', packet: rep(dev.id, undefined, []), message: `The ARP reply never reached ${dev.name}, so the packet cannot be sent.` });
    return null;
  }
  (ctx.l2.arp[dev.id] ??= {})[targetIp] = { mac: tMac, learnedAt: ctx.time };
  push(ctx, {
    at: dev.id, action: 'arp-learn', layer: 2, srcIp: pkt.srcIp, dstIp: pkt.dstIp, ttlIn: pkt.ttl, ttlOut: pkt.ttl,
    why: 'ARP reply received.', srcMac: tMac, dstMac: senderMac,
    packet: rep(dev.id, undefined, [`${dev.name} adds ${targetIp} → ${tMac} to its ARP cache. The next packets to ${targetIp} skip ARP.`]),
    message: `${dev.name} stores ${targetIp} → ${tMac} in its ARP cache. Now it can build the Ethernet frame.`,
  });
  return { endpoint: target, mac: tMac };
}

interface LegResult {
  delivered: boolean;
  receiver?: Device;
  path: string[];
  srcIp: string;
  failure?: { code: FailureCode; at: string; message: string };
}

function leg(ctx: Ctx, src: Device, dstIp: string, srcIpIn: string | undefined, kind: 'request' | 'reply'): LegResult {
  let srcIp = srcIpIn ?? '';
  const path = [src.id];
  const label = kind === 'request' ? 'echo request' : 'echo reply';
  const fail = (code: FailureCode, at: string, message: string, extra: Partial<NewStep> = {}): LegResult => {
    push(ctx, {
      at, action: 'drop', layer: 3, srcIp, dstIp, ttlIn: extra.ttlIn ?? ctx.ttl, ttlOut: extra.ttlOut ?? ctx.ttl, why: message, failure: code, message,
      packet: icmpView({ type: kind, seq: ctx.seq, origin: ctx.origin, target: ctx.target, at, srcIp, dstIp, ttl: extra.ttlOut ?? ctx.ttl, notes: [message] }),
      ...extra,
    });
    return { delivered: false, path, srcIp, failure: { code, at, message } };
  };
  let cur = src;
  let inIf: Iface | null = null;
  let ttlNow = ctx.ttl;
  let first = true;
  for (let n = 0; n < 60 && ctx.steps.length < MAX_STEPS; n++) {
    const own = cur.ifaces.find((i) => i.ip === dstIp && (isLoopback(i) || ifaceUp(ctx.topo, cur.id, i.id)));
    if (own && cur.kind !== 'switch') {
      if (!srcIp) srcIp = own.ip;
      push(ctx, {
        at: cur.id, action: 'receive', layer: 3, srcIp, dstIp, ttlIn: ttlNow, ttlOut: ttlNow, inIfaceName: ifName(inIf),
        why: `${dstIp} is ${cur.name}'s own address (${own.name}).`,
        packet: icmpView({ type: kind, seq: ctx.seq, origin: ctx.origin, target: ctx.target, at: cur.id, inIface: ifName(inIf), srcIp, dstIp, ttl: ttlNow, notes: [
          first ? `${cur.name} is pinging one of its own addresses, so the packet never leaves it.` : `The Ethernet destination MAC matched ${cur.name}'s ${inIf?.name} interface, and the IP destination ${dstIp} is its own ${own.name} address, so the packet is delivered to ${cur.name} itself.`,
        ] }),
        message: `${cur.name} receives the ICMP ${label}: ${dstIp} is its own ${own.name} address.`,
      });
      return { delivered: true, receiver: cur, path, srcIp };
    }
    if (cur.kind === 'pc' && !first)
      return fail('host-unreachable', cur.id, `${cur.name} received a packet for ${dstIp}, which is not its address. Hosts do not forward packets, so it is dropped.`, { ttlIn: ttlNow, ttlOut: ttlNow });

    let outIf: Iface | undefined;
    let target: string;
    let ttlOut = ttlNow;
    let why: string;
    let chosen: Route | null = null;
    let candidates: Route[] | undefined;
    let table: Route[] | undefined;
    let action: HopAction;
    let arpFail: FailureCode;
    const notes: string[] = [];
    let interfaceOnly = false;

    if (cur.kind === 'pc') {
      const i = cur.ifaces[0];
      if (!i || !i.ip) return fail('invalid-config', cur.id, `${cur.name} has no IP address, so it cannot send an ICMP ${label}.`);
      srcIp ||= i.ip;
      outIf = i;
      if (inSubnet(dstIp, i.ip, i.prefix)) {
        target = dstIp;
        why = `${dstIp} is in ${cur.name}'s own subnet ${cidr(networkOf(i.ip, i.prefix), i.prefix)}, so it is delivered directly (no router needed).`;
        arpFail = 'host-unreachable';
      } else {
        if (!cur.gateway) return fail('no-gateway', cur.id, `${dstIp} is not in ${cur.name}'s subnet, and ${cur.name} has no default gateway configured. A host needs a gateway to reach remote networks.`);
        if (!inSubnet(cur.gateway, i.ip, i.prefix)) return fail('gateway-unreachable', cur.id, `${cur.name}'s default gateway ${cur.gateway} is not in its own subnet, so ${cur.name} cannot reach it.`);
        target = cur.gateway;
        why = `${dstIp} is NOT in ${cur.name}'s subnet ${cidr(networkOf(i.ip, i.prefix), i.prefix)}, so ${cur.name} sends it to its default gateway ${cur.gateway}.`;
        notes.push(`Layer 2 vs Layer 3: the IP destination stays ${dstIp} (the final host), but the Ethernet destination is the GATEWAY's MAC address, because the gateway is the next device on this link.`);
        arpFail = 'gateway-unreachable';
      }
      if (!ifaceUp(ctx.topo, cur.id, i.id)) return fail('link-down', cur.id, `${cur.name}'s link is disabled, so the packet cannot leave ${cur.name}.`, { why });
      action = 'send';
    } else {
      if (!first) {
        ttlOut = ttlNow - 1;
        if (ttlOut <= 0) {
          const visits = path.filter((p) => p === cur.id).length;
          const loopText = visits > 1 ? ` The packet has visited ${cur.name} ${visits} times (${path.map((p) => nm(ctx, p)).slice(-8).join(' → ')}): the routers are forwarding it in a loop.` : '';
          return fail('ttl-expired', cur.id, `TTL reached 0 at ${cur.name}, so ${cur.name} drops the packet.${loopText}`, { ttlIn: ttlNow, ttlOut: 0, inIfaceName: ifName(inIf), why: 'TTL limits how many routers a packet may cross; it stops packets looping forever.' });
        }
      }
      table = ctx.tables[cur.id] ?? [];
      const res = lookup(table, dstIp);
      candidates = res.candidates;
      if (!res.match) {
        const code: FailureCode = kind === 'reply' ? 'missing-return-route' : 'no-route';
        const msg = kind === 'reply'
          ? `${cur.name} has no route back to ${dstIp}. The echo request arrived, but the reply cannot return: a missing return route. Routing must work in BOTH directions.`
          : `${cur.name} has no route that contains ${dstIp} and no default route, so it drops the packet.`;
        return fail(code, cur.id, msg, { ttlIn: ttlNow, ttlOut, table, candidates: [], chosen: null, inIfaceName: ifName(inIf), why: explainMatch(res, dstIp) });
      }
      chosen = res.match;
      why = explainMatch(res, dstIp);
      outIf = cur.ifaces.find((i) => i.id === chosen!.iface);
      if (!outIf || !ifaceUp(ctx.topo, cur.id, outIf.id))
        return fail('link-down', cur.id, `${cur.name} would send the packet out of ${outIf?.name ?? '?'}, but that interface's link is down.`, { ttlIn: ttlNow, ttlOut, table, candidates, chosen, why });
      interfaceOnly = chosen.source === 'static' && !chosen.nextHop;
      target = chosen.source === 'connected' || interfaceOnly ? dstIp : (chosen.resolvedVia ?? chosen.nextHop)!;
      if (first && !srcIp) srcIp = outIf.ip;
      action = first ? 'send' : chosen.source === 'connected' ? 'deliver' : 'forward';
      arpFail = chosen.source === 'connected' ? 'host-unreachable' : 'next-hop-unreachable';
      notes.push(`Routing table lookup for ${dstIp}: ${why}`);
      if (!first) {
        notes.push(`TTL: ${ttlNow} → ${ttlOut}. Every router subtracts 1; a packet reaching 0 is dropped.`);
        notes.push(`Layer 2 vs Layer 3: the frame arrived addressed to ${cur.name}'s ${inIf?.name} MAC. ${cur.name} removes that Ethernet header and builds a NEW one for the next link: source MAC = its ${outIf.name} MAC, destination MAC = the next hop (${target}). The IP addresses ${srcIp} → ${dstIp} do not change.`);
      } else notes.push(`${cur.name} creates the packet itself, using source address ${srcIp}${srcIpIn ? '' : ` (the address of its outgoing interface ${outIf.name})`}.`);
    }

    const firstDev = firstHopDevice(ctx.topo, cur.id, outIf.id);
    const cached = ctx.l2.arp[cur.id]?.[target];
    const srcMac = macOf(cur.id, outIf);
    const pktBase = { type: kind, seq: ctx.seq, origin: ctx.origin, target: ctx.target, srcIp, dstIp, ttl: ttlOut } as const;
    push(ctx, {
      at: cur.id, action, layer: 3, srcIp, dstIp, ttlIn: ttlNow, ttlOut, table, candidates, chosen, why,
      nextHopIp: target, outIface: outIf.id, outIfaceName: outIf.name, inIfaceName: ifName(inIf),
      toDevice: cached ? firstDev?.dev : undefined, linkId: firstDev?.linkId, srcMac: cached ? srcMac : undefined, dstMac: cached?.mac,
      packet: icmpView({ ...pktBase, at: cur.id, next: firstDev?.dev, inIface: ifName(inIf), outIface: outIf.name, srcMac: cached ? srcMac : undefined, dstMac: cached?.mac, notes: cached ? notes : [...notes, `${cur.name} does not know the MAC address of ${target} yet, so it must use ARP before sending.`] }),
      message:
        cur.kind === 'pc'
          ? `${cur.name} sends an ICMP ${label} to ${dstIp} (TTL ${ttlNow}). Next hop: ${target}. The destination IP stays ${dstIp}.`
          : first
            ? `${cur.name} creates an ICMP ${label} from ${srcIp} to ${dstIp}. Best match ${routeKey(chosen!)} → next hop ${target} out of ${outIf.name}.`
            : action === 'deliver'
              ? `${cur.name}: ${dstIp} is on directly connected network ${routeKey(chosen!)}. Decrease TTL ${ttlNow}→${ttlOut} and deliver it out of ${outIf.name}.`
              : `${cur.name}: best match ${routeKey(chosen!)}. Decrease TTL ${ttlNow}→${ttlOut} and forward to next hop ${target} out of ${outIf.name}. The destination IP is still ${dstIp}.`,
    });

    let resolved = arpResolve(ctx, cur, outIf, target, arpFail, { srcIp, dstIp, ttl: ttlOut });
    if (!resolved && interfaceOnly) {
      // Interface-only static route on a point-to-point link: the router at the far end answers (proxy ARP).
      const others = segmentOf(ctx.topo, cur.id, outIf.id).endpoints.filter((e) => e.dev.id !== cur.id);
      if (others.length === 1 && others[0].dev.kind === 'router') {
        ctx.steps.pop();
        const pm = macOf(others[0].dev.id, others[0].iface);
        (ctx.l2.arp[cur.id] ??= {})[target] = { mac: pm, learnedAt: ctx.time };
        resolved = { endpoint: others[0], mac: pm };
      }
    }
    if (!resolved) {
      const last = ctx.steps[ctx.steps.length - 1];
      return { delivered: false, path, srcIp, failure: { code: last.failure ?? arpFail, at: cur.id, message: last.message } };
    }
    if (!cached) {
      push(ctx, {
        at: cur.id, action: 'send', layer: 3, srcIp, dstIp, ttlIn: ttlNow, ttlOut, why: 'MAC address of the next hop is now known.',
        nextHopIp: target, outIface: outIf.id, outIfaceName: outIf.name, toDevice: firstDev?.dev, linkId: firstDev?.linkId, srcMac, dstMac: resolved.mac,
        packet: icmpView({ ...pktBase, at: cur.id, next: firstDev?.dev, outIface: outIf.name, srcMac, dstMac: resolved.mac, notes: [`ARP finished, so ${cur.name} can now build the Ethernet frame: source MAC ${srcMac}, destination MAC ${resolved.mac}.`] }),
        message: `${cur.name} sends the ${label} in an Ethernet frame to ${resolved.mac} (${target}) out of ${outIf.name}.`,
      });
    }
    const dstMac = resolved.mac;
    const arrivals = transmit(ctx, cur, outIf, {
      srcMac, dstMac, srcIp, dstIp, ttl: ttlOut,
      view: (at, next, ns) => icmpView({ ...pktBase, at, next, srcMac, dstMac, notes: ns }),
    });
    const recv = arrivals.find((e) => macOf(e.dev.id, e.iface) === dstMac);
    if (!recv)
      return fail('frame-lost', cur.id, `The frame for ${dstMac} did not reach its destination (the MAC address is stale or the path is broken), so the packet is lost.`, { ttlIn: ttlNow, ttlOut });
    const l2p = l2Path(ctx.topo, cur.id, outIf.id, recv.dev.id, recv.iface.id) ?? [cur.id, recv.dev.id];
    path.push(...l2p.slice(1));
    cur = recv.dev;
    inIf = recv.iface;
    ttlNow = ttlOut;
    first = false;
  }
  return fail('ttl-expired', cur.id, 'Too many steps.');
}

function outcomeOf(failure: PingResult['failure'], topo: Topology): { outcome: PingOutcome; text: string } {
  if (!failure) return { outcome: 'success', text: 'Reply received' };
  const where = deviceName(topo, failure.at);
  if (failure.phase === 'reply') return { outcome: 'timeout', text: `Request timed out — the echo request arrived, but the reply was lost at ${where}` };
  if (failure.code === 'ttl-expired') return { outcome: 'ttl-expired', text: `TTL expired in transit (at ${where})` };
  if (['frame-lost', 'link-down'].includes(failure.code)) return { outcome: 'timeout', text: `Request timed out — the packet was lost at ${where}` };
  return { outcome: 'unreachable', text: `Destination unreachable (at ${where})` };
}

/** Ping from any PC or router to any IP address. Only succeeds if the request AND the reply both arrive. */
export function runPing(topo: Topology, tables: Tables, l2In: L2State, req: PingRequest, ttl: number, time = 0): PingResult {
  const src = getDevice(topo, req.src);
  const l2 = cloneL2(l2In);
  const steps: HopStep[] = [];
  const target = topo.devices.find((d) => d.ifaces.some((i) => i.ip === req.dstIp))?.id;
  const base = { steps, requestPath: [] as string[], replyPath: [] as string[], srcIp: req.srcIp ?? '', dstIp: req.dstIp, l2 };
  if (!src || src.kind === 'switch') {
    const failure = { code: 'invalid-config' as const, at: req.src, phase: 'request' as const, message: 'Choose a PC or router as the source (an unmanaged switch has no IP address and cannot ping).' };
    return { ...base, success: false, outcome: 'unreachable', outcomeText: failure.message, failure };
  }
  const ctx: Ctx = { topo, tables, l2, time, ttl, seq: req.seq ?? 1, phase: 'request', steps, origin: src.id, target };
  const rq = leg(ctx, src, req.dstIp, req.srcIp, 'request');
  if (!rq.delivered) {
    const failure = { ...rq.failure!, phase: 'request' as const };
    const o = outcomeOf(failure, topo);
    return { ...base, srcIp: rq.srcIp, success: false, outcome: o.outcome, outcomeText: o.text, failure, requestPath: rq.path };
  }
  ctx.phase = 'reply';
  ctx.origin = rq.receiver!.id;
  ctx.target = src.id;
  const rp = leg(ctx, rq.receiver!, rq.srcIp, req.dstIp, 'reply');
  const failure = rp.failure ? { ...rp.failure, phase: 'reply' as const } : undefined;
  const o = outcomeOf(failure, topo);
  return { ...base, srcIp: rq.srcIp, success: rp.delivered, outcome: o.outcome, outcomeText: o.text, failure, requestPath: rq.path, replyPath: rp.path };
}

/** PC/router to PC/router ping using the destination's first address, with empty ARP caches. */
export function simulatePing(topo: Topology, tables: Tables, srcId: string, dstId: string, ttl: number): PingResult {
  const dst = getDevice(topo, dstId);
  const dstIp = dst?.ifaces.find((i) => i.ip)?.ip ?? '';
  if (!dst || !dstIp) {
    const failure = { code: 'invalid-config' as const, at: dstId, phase: 'request' as const, message: `${dst?.name ?? dstId} has no IP address, so it cannot be pinged.` };
    return { steps: [], success: false, outcome: 'unreachable', outcomeText: failure.message, failure, requestPath: [], replyPath: [], srcIp: '', dstIp: '', l2: emptyL2() };
  }
  return runPing(topo, tables, emptyL2(), { src: srcId, dstIp }, ttl);
}

export function ifaceLabel(topo: Topology, devId: string, ifaceId: string | null | undefined) {
  return ifaceName(topo, devId, ifaceId);
}

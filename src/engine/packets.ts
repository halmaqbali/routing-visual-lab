// Packet Inspector views: the protocol layers of each simulated packet.
// These are not real captures. Fields marked `simulated` are fixed/illustrative values; header checksums are not computed.
import { maskString } from '../model/ip';
import { deviceName, getDevice, getIface, isLoopback, macOf, routerNeighbors } from '../model/topology';
import type { Topology } from '../model/types';
import type { Advert, Lsa } from './types';
import { parseIp } from '../model/ip';

/** MAC address of a device interface (by ids). */
export function macFn(topo: Topology) {
  return (dev: string, iface: string) => {
    const i = getIface(topo, dev, iface);
    return i ? macOf(dev, i) : '';
  };
}

export type Proto = 'ICMP' | 'ARP' | 'RIPv2' | 'DV (teaching)' | 'OSPF Hello' | 'OSPF LSU';

export interface Field {
  name: string;
  value: string;
  simulated?: boolean;
}

export interface Layer {
  name: string;
  layer: 2 | 3 | 4 | 7;
  fields: Field[];
}

export interface PacketView {
  protocol: Proto;
  /** One-line summary, like Wireshark's Info column. */
  info: string;
  /** Device that created the packet. */
  origin: string;
  /** Final destination device (if known). */
  target?: string;
  /** Device the packet is at in this event, and where it goes next. */
  at: string;
  next?: string;
  inIface?: string;
  outIface?: string;
  srcMac?: string;
  dstMac?: string;
  srcIp?: string;
  dstIp?: string;
  ttl?: number;
  sizeBytes?: number;
  sizeNote: string;
  layers: Layer[];
  /** Plain-English notes for students (why forwarded/dropped, MAC changes, ...). */
  notes: string[];
}

const ETH = (dst: string, src: string, type: '0x0800 (IPv4)' | '0x0806 (ARP)'): Layer => ({
  name: 'Ethernet II',
  layer: 2,
  fields: [
    { name: 'Destination MAC', value: dst },
    { name: 'Source MAC', value: src },
    { name: 'EtherType', value: type },
  ],
});

const IPV4 = (src: string, dst: string, ttl: number, proto: string, totalLen: number, id?: number): Layer => ({
  name: 'Internet Protocol version 4',
  layer: 3,
  fields: [
    { name: 'Version', value: '4' },
    { name: 'Header length', value: '20 bytes' },
    { name: 'Total length', value: `${totalLen} bytes` },
    { name: 'Identification', value: id !== undefined ? `0x${id.toString(16).padStart(4, '0')}` : '0x0000', simulated: true },
    { name: 'Time to live (TTL)', value: String(ttl) },
    { name: 'Protocol', value: proto },
    { name: 'Header checksum', value: 'not computed', simulated: true },
    { name: 'Source address', value: src },
    { name: 'Destination address', value: dst },
  ],
});

export function icmpView(o: {
  type: 'request' | 'reply'; seq: number; origin: string; target?: string; at: string; next?: string; inIface?: string; outIface?: string;
  srcMac?: string; dstMac?: string; srcIp: string; dstIp: string; ttl: number; notes: string[];
}): PacketView {
  const payload = 32;
  const icmpLen = 8 + payload;
  const ipLen = 20 + icmpLen;
  const layers: Layer[] = [];
  if (o.srcMac && o.dstMac) layers.push(ETH(o.dstMac, o.srcMac, '0x0800 (IPv4)'));
  layers.push(IPV4(o.srcIp, o.dstIp, o.ttl, '1 (ICMP)', ipLen, o.seq));
  layers.push({
    name: 'Internet Control Message Protocol',
    layer: 3,
    fields: [
      { name: 'Type', value: o.type === 'request' ? '8 (Echo request)' : '0 (Echo reply)' },
      { name: 'Code', value: '0' },
      { name: 'Checksum', value: 'not computed', simulated: true },
      { name: 'Identifier', value: '0x0001', simulated: true },
      { name: 'Sequence number', value: String(o.seq) },
      { name: 'Data', value: `${payload} bytes`, simulated: true },
    ],
  });
  return {
    protocol: 'ICMP', info: `Echo (ping) ${o.type}  seq=${o.seq}, ttl=${o.ttl}`,
    origin: o.origin, target: o.target, at: o.at, next: o.next, inIface: o.inIface, outIface: o.outIface,
    srcMac: o.srcMac, dstMac: o.dstMac, srcIp: o.srcIp, dstIp: o.dstIp, ttl: o.ttl,
    sizeBytes: 14 + ipLen, sizeNote: `14 (Ethernet) + 20 (IPv4) + 8 (ICMP) + ${payload} (data) = ${14 + ipLen} bytes; the 4-byte Ethernet FCS is not shown.`,
    layers, notes: o.notes,
  };
}

export function arpView(o: {
  op: 'request' | 'reply'; origin: string; target?: string; at: string; next?: string; outIface?: string; inIface?: string;
  frameSrc: string; frameDst: string; senderMac: string; senderIp: string; targetMac: string; targetIp: string; notes: string[];
}): PacketView {
  return {
    protocol: 'ARP',
    info: o.op === 'request' ? `Who has ${o.targetIp}? Tell ${o.senderIp}` : `${o.senderIp} is at ${o.senderMac}`,
    origin: o.origin, target: o.target, at: o.at, next: o.next, inIface: o.inIface, outIface: o.outIface,
    srcMac: o.frameSrc, dstMac: o.frameDst,
    sizeBytes: 42, sizeNote: '14 (Ethernet) + 28 (ARP) = 42 bytes, padded to the 60-byte Ethernet minimum on the wire.',
    layers: [
      ETH(o.frameDst, o.frameSrc, '0x0806 (ARP)'),
      {
        name: 'Address Resolution Protocol',
        layer: 2,
        fields: [
          { name: 'Hardware type', value: '1 (Ethernet)' },
          { name: 'Protocol type', value: '0x0800 (IPv4)' },
          { name: 'Hardware size / Protocol size', value: '6 / 4' },
          { name: 'Opcode', value: o.op === 'request' ? '1 (request)' : '2 (reply)' },
          { name: 'Sender MAC address', value: o.senderMac },
          { name: 'Sender IP address', value: o.senderIp },
          { name: 'Target MAC address', value: o.targetMac },
          { name: 'Target IP address', value: o.targetIp },
        ],
      },
    ],
    notes: o.notes,
  };
}

/** Router ID like OSPF: the highest loopback address, else the highest interface address. */
export function routerId(topo: Topology, router: string): string {
  const d = getDevice(topo, router);
  const ips = (pick: boolean) => (d?.ifaces ?? []).filter((i) => i.ip && isLoopback(i) === pick).map((i) => i.ip);
  const pool = ips(true).length ? ips(true) : ips(false);
  return pool.sort((a, b) => (parseIp(b) ?? 0) - (parseIp(a) ?? 0))[0] ?? '0.0.0.0';
}

function adjacency(topo: Topology, from: string, to: string, key: string) {
  const nb = routerNeighbors(topo, from).find((n) => n.key === key && n.router === to);
  return nb;
}

/** A distance-vector update (RIPv2 response for the RIP profile; a teaching message for the generic profile). */
export function dvView(topo: Topology, from: string, to: string, key: string, adverts: Advert[], rip: boolean, inf: number, triggered: boolean, macOfIface: (dev: string, iface: string) => string): PacketView {
  const nb = adjacency(topo, from, to, key);
  const back = nb ? routerNeighbors(topo, to).find((n) => n.key === key && n.router === from) : undefined;
  const srcIp = nb?.localIface.ip ?? '';
  const srcMac = nb ? macOfIface(from, nb.localIface.id) : '';
  const notes = [
    'This is a control-plane (routing) message, not user data. It changes routing tables; it does not carry anyone\'s traffic.',
    rip
      ? 'RIPv2 sends its whole routing table (a list of network + hop count) every 30 s to multicast 224.0.0.9 using UDP port 520. Each router only tells its direct neighbours.'
      : 'Generic distance-vector teaching model: same idea as RIP (network + cost pairs to neighbours) but with weighted costs. It is not a real protocol, so no real packet format exists.',
  ];
  if (!rip)
    return {
      protocol: 'DV (teaching)', info: `${deviceName(topo, from)} → ${deviceName(topo, to)}: ${adverts.length} routes${triggered ? ' (triggered)' : ''}`,
      origin: from, target: to, at: from, next: to, outIface: nb?.localIface.name, inIface: back?.localIface.name, srcIp, srcMac,
      sizeNote: 'Not modelled: the generic distance-vector protocol is a teaching abstraction.',
      layers: [
        { name: 'Distance-vector update (teaching model)', layer: 7, fields: [
          { name: 'Sender', value: deviceName(topo, from) },
          { name: 'Update type', value: triggered ? 'Triggered (changed routes only)' : 'Periodic (full table)' },
          ...adverts.map((a) => ({ name: `${a.network}/${a.prefix}`, value: `cost ${a.metric >= inf ? `∞ (${inf})` : a.metric}${a.poisoned ? ' — poison reverse' : ''}` })),
        ] },
      ],
      notes,
    };
  const ripLen = 4 + 20 * adverts.length;
  return {
    protocol: 'RIPv2', info: `Response (${adverts.length} route${adverts.length === 1 ? '' : 's'})${triggered ? ', triggered' : ''}`,
    origin: from, target: to, at: from, next: to, outIface: nb?.localIface.name, inIface: back?.localIface.name,
    srcMac, dstMac: '01:00:5e:00:00:09', srcIp, dstIp: '224.0.0.9', ttl: 1,
    sizeBytes: 14 + 20 + 8 + ripLen, sizeNote: `14 (Ethernet) + 20 (IPv4) + 8 (UDP) + 4 (RIP header) + 20 × ${adverts.length} route entries.`,
    layers: [
      ETH('01:00:5e:00:00:09', srcMac, '0x0800 (IPv4)'),
      IPV4(srcIp, '224.0.0.9', 1, '17 (UDP)', 20 + 8 + ripLen),
      { name: 'User Datagram Protocol', layer: 4, fields: [
        { name: 'Source port', value: '520' }, { name: 'Destination port', value: '520' }, { name: 'Length', value: String(8 + ripLen) }, { name: 'Checksum', value: 'not computed', simulated: true },
      ] },
      { name: 'Routing Information Protocol', layer: 7, fields: [
        { name: 'Command', value: '2 (Response)' }, { name: 'Version', value: '2' },
        ...adverts.map((a) => ({ name: `Route ${a.network}`, value: `mask ${maskString(a.prefix)}, next hop 0.0.0.0, metric ${a.metric}${a.metric >= 16 ? ' (unreachable)' : ''}${a.poisoned ? ' — poison reverse' : ''}` })),
      ] },
    ],
    notes,
  };
}

export function ospfHelloView(topo: Topology, a: string, b: string, key: string, macOfIface: (dev: string, iface: string) => string): PacketView {
  const nb = adjacency(topo, a, b, key);
  const srcIp = nb?.localIface.ip ?? '';
  const srcMac = nb ? macOfIface(a, nb.localIface.id) : '';
  return {
    protocol: 'OSPF Hello', info: `Hello from ${routerId(topo, a)} (router ID)`, origin: a, target: b, at: a, next: b,
    outIface: nb?.localIface.name, srcMac, dstMac: '01:00:5e:00:00:05', srcIp, dstIp: '224.0.0.5', ttl: 1,
    sizeNote: 'Approximate: the simulator models the Hello exchange, not the exact OSPF byte layout.',
    layers: [
      ETH('01:00:5e:00:00:05', srcMac, '0x0800 (IPv4)'),
      IPV4(srcIp, '224.0.0.5', 1, '89 (OSPF)', 64),
      { name: 'OSPF (simplified teaching model)', layer: 7, fields: [
        { name: 'Version', value: '2' }, { name: 'Message type', value: '1 (Hello)' },
        { name: 'Router ID', value: routerId(topo, a) }, { name: 'Area ID', value: '0.0.0.0', simulated: true },
        { name: 'Hello / Dead interval', value: '10 s / 40 s (timers not modelled)', simulated: true },
        { name: 'Neighbour seen', value: routerId(topo, b) },
      ] },
    ],
    notes: [
      'Hello messages discover neighbours. Two routers become neighbours when each sees the other in its Hellos (two-way).',
      'Simplified: no DR/BDR election, no timers, single area. This is OSPF-inspired, not a full OSPF implementation.',
    ],
  };
}

export function lsuView(topo: Topology, from: string, to: string, key: string, lsa: Lsa, macOfIface: (dev: string, iface: string) => string): PacketView {
  const nb = adjacency(topo, from, to, key);
  const back = nb ? routerNeighbors(topo, to).find((n) => n.key === key && n.router === from) : undefined;
  const srcIp = nb?.localIface.ip ?? '';
  const srcMac = nb ? macOfIface(from, nb.localIface.id) : '';
  return {
    protocol: 'OSPF LSU', info: `LS Update: Router-LSA of ${routerId(topo, lsa.origin)}, seq #${lsa.seq}`, origin: lsa.origin, at: from, next: to,
    outIface: nb?.localIface.name, inIface: back?.localIface.name, srcMac, dstMac: '01:00:5e:00:00:05', srcIp, dstIp: '224.0.0.5', ttl: 1,
    sizeNote: 'Approximate: LSA encoding is simplified.',
    layers: [
      ETH('01:00:5e:00:00:05', srcMac, '0x0800 (IPv4)'),
      IPV4(srcIp, '224.0.0.5', 1, '89 (OSPF)', 64 + 12 * (lsa.links.length + lsa.stubs.length)),
      { name: 'OSPF Link State Update (simplified)', layer: 7, fields: [
        { name: 'Message type', value: '4 (Link State Update)' },
        { name: 'Sent by (router ID)', value: routerId(topo, from) },
        { name: 'LSA type', value: '1 (Router-LSA)' },
        { name: 'Advertising router', value: `${routerId(topo, lsa.origin)} (${deviceName(topo, lsa.origin)})` },
        { name: 'Sequence number', value: String(lsa.seq) },
        { name: 'LS age / checksum', value: 'not modelled', simulated: true },
        ...lsa.links.map((l) => ({ name: 'Link to router', value: `${routerId(topo, l.to)} (${deviceName(topo, l.to)}), cost ${l.cost}` })),
        ...lsa.stubs.map((st) => ({ name: 'Stub network', value: `${st.network}/${st.prefix}` })),
      ] },
    ],
    notes: [
      `This LSA was created by ${deviceName(topo, lsa.origin)}. Flooding passes it on unchanged, so every router builds the same map.`,
      'Simplified: no LSA age, acknowledgements or retransmission.',
    ],
  };
}

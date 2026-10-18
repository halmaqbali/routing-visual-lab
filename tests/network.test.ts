import { describe, expect, it } from 'vitest';
import { addStatic, loopbackLine, staticRoute, switchedLan, threeRouter } from '../src/model/samples';
import { addDevice, addLink, getIface, macOf, routerNeighbors } from '../src/model/topology';
import { validateTopology } from '../src/model/validate';
import { buildStaticTables } from '../src/engine/static';
import { runPing, type HopStep } from '../src/engine/ping';
import { emptyL2 } from '../src/engine/l2';
import { applyLinkChange, converge, createTimeline } from '../src/engine/simulation';
import { opts, route, setLink } from './helpers';

const errs = (t: Parameters<typeof validateTopology>[0]) => validateTopology(t).filter((i) => i.severity === 'error').map((i) => i.message).join('\n');
const mac = (t: ReturnType<typeof switchedLan>, dev: string, iface: string) => macOf(dev, getIface(t, dev, iface)!);

/** Loopback line with full static routing between all loopbacks. */
function loopbackStatic(withR3Return = true) {
  let t = loopbackLine();
  t = addStatic(t, 'R1', staticRoute('10.0.3.0', 24, '10.0.12.2'), staticRoute('10.0.23.0', 24, '10.0.12.2'), staticRoute('10.0.2.0', 24, '10.0.12.2'));
  t = addStatic(t, 'R2', staticRoute('10.0.1.0', 24, '10.0.12.1'), staticRoute('10.0.3.0', 24, '10.0.23.3'));
  const r3 = [staticRoute('10.0.12.0', 24, '10.0.23.2'), staticRoute('10.0.2.0', 24, '10.0.23.2')];
  if (withR3Return) r3.push(staticRoute('10.0.1.0', 24, '10.0.23.2'));
  return addStatic(t, 'R3', ...r3);
}

describe('unmanaged switch', () => {
  it('the sample LAN is valid and the switch has no IP configuration', () => {
    const t = switchedLan();
    expect(errs(t)).toBe('');
    expect(t.devices.find((d) => d.id === 'sw1')!.ifaces.every((i) => i.ip === '')).toBe(true);
  });

  it('floods the broadcast ARP request, learns MACs, then forwards known unicast to one port', () => {
    const t = switchedLan();
    const p = runPing(t, buildStaticTables(t).tables, emptyL2(), { src: 'pc1', dstIp: '192.168.1.11' }, 16);
    expect(p.success).toBe(true);
    const sw = p.steps.filter((s) => s.at === 'sw1');
    // 1) ARP request from PC1: broadcast → flood to R1 and PC2
    expect(sw[0].action).toBe('switch-flood');
    expect(sw[0].dstMac).toBe('ff:ff:ff:ff:ff:ff');
    expect(sw[0].copies!.map((c) => c.to).sort()).toEqual(['pc2', 'r1']);
    expect(sw[0].macDecision!.learned).toBe(mac(t, 'pc1', 'pc1-eth0'));
    // 2) ARP reply PC2 → PC1: PC1 is already learned → forwarded out one port only
    expect(sw[1].action).toBe('switch-forward');
    expect(sw[1].toDevice).toBe('pc1');
    // 3) The echo request is now known unicast → forwarded, not flooded
    expect(sw.slice(2).every((s) => s.action === 'switch-forward')).toBe(true);
    const table = p.l2.mac.sw1.map((e) => e.mac).sort();
    expect(table).toEqual([mac(t, 'pc1', 'pc1-eth0'), mac(t, 'pc2', 'pc2-eth0')].sort());
  });

  it('floods unknown unicast when the destination MAC is not in the table', () => {
    const t = switchedLan();
    const l2 = emptyL2();
    // PC1 already knows PC2 in its ARP cache, but the switch has never seen PC2.
    l2.arp.pc1 = { '192.168.1.11': { mac: mac(t, 'pc2', 'pc2-eth0'), learnedAt: 0 } };
    const p = runPing(t, buildStaticTables(t).tables, l2, { src: 'pc1', dstIp: '192.168.1.11' }, 16);
    const first = p.steps.find((s) => s.at === 'sw1')!;
    expect(first.action).toBe('switch-flood');
    expect(first.message).toMatch(/unknown unicast/);
  });

  it('resolves ARP across the switch and remembers the answer (no ARP on the next ping)', () => {
    const t = switchedLan();
    const tables = buildStaticTables(t).tables;
    const p1 = runPing(t, tables, emptyL2(), { src: 'pc1', dstIp: '192.168.1.11' }, 16);
    expect(p1.l2.arp.pc1['192.168.1.11'].mac).toBe(mac(t, 'pc2', 'pc2-eth0'));
    expect(p1.l2.arp.pc2['192.168.1.10'].mac).toBe(mac(t, 'pc1', 'pc1-eth0')); // the target learns the asker too
    const p2 = runPing(t, tables, p1.l2, { src: 'pc1', dstIp: '192.168.1.11', seq: 2 }, 16);
    expect(p2.steps.some((s) => s.action === 'arp-request')).toBe(false);
  });

  it('ages MAC entries and relearns them', () => {
    const t = switchedLan();
    const tables = buildStaticTables(t).tables;
    const p1 = runPing(t, tables, emptyL2(), { src: 'pc1', dstIp: '192.168.1.11' }, 16, 0);
    const p2 = runPing(t, tables, p1.l2, { src: 'pc1', dstIp: '192.168.1.11', seq: 2 }, 16, 1000);
    const first = p2.steps.find((s) => s.at === 'sw1')!;
    expect(first.message).toMatch(/Aged out first/);
    expect(first.action).toBe('switch-flood'); // PC2 forgotten → unknown unicast
    expect(p2.success).toBe(true);
  });

  it('reaches a remote network through the switch and the routers', () => {
    let t = switchedLan();
    t = addStatic(t, 'R1', staticRoute('192.168.2.0', 24, '10.0.12.2'));
    t = addStatic(t, 'R2', staticRoute('192.168.1.0', 24, '10.0.12.1'));
    const p = runPing(t, buildStaticTables(t).tables, emptyL2(), { src: 'pc2', dstIp: '192.168.2.10' }, 16);
    expect(p.success).toBe(true);
    expect(p.requestPath).toEqual(['pc2', 'sw1', 'r1', 'r2', 'pc3']);
  });

  it('auto-addresses devices connected to a switch and sets PC gateways', () => {
    let t = threeRouter();
    let r = addDevice(t, 'switch', 0, 0);
    t = r.topo;
    const sw = r.id;
    t = addLink(t, 'r2', sw).topo;
    r = addDevice(t, 'pc', 0, 0);
    t = addLink(r.topo, sw, r.id).topo;
    const pc = t.devices.find((d) => d.id === r.id)!;
    const r2If = t.devices.find((d) => d.id === 'r2')!.ifaces.at(-1)!;
    expect(r2If.ip).toBe('192.168.2.1');
    expect(pc.ifaces[0].ip).toBe('192.168.2.10');
    expect(pc.gateway).toBe('192.168.2.1');
    expect(errs(t)).toBe('');
  });

  it('rejects switch loops, IPs on switch ports and mixed subnets on one segment', () => {
    let t = switchedLan();
    const a = addDevice(t, 'switch', 0, 0);
    t = addLink(a.topo, 'sw1', a.id).topo;
    const b = addDevice(t, 'switch', 0, 0);
    t = addLink(b.topo, a.id, b.id).topo;
    t = addLink(t, b.id, 'sw1').topo;
    expect(errs(t)).toMatch(/Switch loop/);
    const u = switchedLan();
    u.devices.find((d) => d.id === 'sw1')!.ifaces[0].ip = '192.168.1.2';
    expect(errs(u)).toMatch(/switch port has no IP address/);
    const v = switchedLan();
    v.devices.find((d) => d.id === 'pc2')!.ifaces[0].ip = '192.168.9.11';
    expect(errs(v)).toMatch(/not in the same subnet/);
  });
});

describe('router ping and loopbacks', () => {
  it('R1 pings R3\'s loopback through R2 and the reply returns', () => {
    const t = loopbackStatic();
    const p = runPing(t, buildStaticTables(t).tables, emptyL2(), { src: 'r1', dstIp: '10.0.3.3' }, 16);
    expect(p.success).toBe(true);
    expect(p.outcome).toBe('success');
    expect(p.srcIp).toBe('10.0.12.1'); // outgoing interface address
    expect(p.requestPath).toEqual(['r1', 'r2', 'r3']);
    expect(p.replyPath).toEqual(['r3', 'r2', 'r1']);
    const r2 = p.steps.find((s) => s.at === 'r2' && s.layer === 3 && s.phase === 'request')!;
    expect([r2.ttlIn, r2.ttlOut]).toEqual([16, 15]); // R1 originates with TTL 16; R2 is the first hop to decrement
  });

  it('loopback-to-loopback ping uses the chosen source address', () => {
    const t = loopbackStatic();
    const p = runPing(t, buildStaticTables(t).tables, emptyL2(), { src: 'r1', srcIp: '10.0.1.1', dstIp: '10.0.3.3' }, 16);
    expect(p.success).toBe(true);
    const reply = p.steps.find((s) => s.phase === 'reply' && s.layer === 3)!;
    expect(reply.srcIp).toBe('10.0.3.3');
    expect(reply.dstIp).toBe('10.0.1.1');
  });

  it('fails with a precise diagnosis when the return route is missing', () => {
    const t = loopbackStatic(false);
    const tables = buildStaticTables(t).tables;
    // From R1's interface address the reply works (R3 knows 10.0.12.0/24) ...
    expect(runPing(t, tables, emptyL2(), { src: 'r1', dstIp: '10.0.3.3' }, 16).success).toBe(true);
    // ... but from R1's loopback, R3 has no route back to 10.0.1.0/24.
    const p = runPing(t, tables, emptyL2(), { src: 'r1', srcIp: '10.0.1.1', dstIp: '10.0.3.3' }, 16);
    expect(p.success).toBe(false);
    expect(p.outcome).toBe('timeout');
    expect(p.failure).toMatchObject({ code: 'missing-return-route', at: 'r3', phase: 'reply' });
    expect(p.requestPath.at(-1)).toBe('r3');
  });

  it('reports destination unreachable when a router has no route', () => {
    const t = loopbackLine();
    const p = runPing(t, buildStaticTables(t).tables, emptyL2(), { src: 'r1', dstIp: '10.0.3.3' }, 16);
    expect(p.outcome).toBe('unreachable');
    expect(p.failure).toMatchObject({ code: 'no-route', at: 'r1' });
  });

  it('reports TTL expired in transit for a routing loop', () => {
    let t = loopbackLine();
    t = addStatic(t, 'R1', staticRoute('0.0.0.0', 0, '10.0.12.2'));
    t = addStatic(t, 'R2', staticRoute('0.0.0.0', 0, '10.0.12.1'));
    const p = runPing(t, buildStaticTables(t).tables, emptyL2(), { src: 'r1', dstIp: '172.16.0.1' }, 6);
    expect(p.outcome).toBe('ttl-expired');
    expect(p.failure?.message).toMatch(/loop/);
  });

  it('pinging one of its own addresses succeeds locally', () => {
    const t = loopbackLine();
    expect(runPing(t, buildStaticTables(t).tables, emptyL2(), { src: 'r2', dstIp: '10.0.2.2' }, 16).success).toBe(true);
  });
});

describe('packet inspector accuracy', () => {
  const full = () => {
    let t = threeRouter();
    t = addStatic(t, 'R1', staticRoute('192.168.3.0', 24, '10.0.12.2'));
    t = addStatic(t, 'R2', staticRoute('192.168.3.0', 24, '10.0.23.3'), staticRoute('192.168.1.0', 24, '10.0.12.1'));
    return addStatic(t, 'R3', staticRoute('192.168.1.0', 24, '10.0.23.2'));
  };
  const frames = (steps: HopStep[]) => steps.filter((s) => s.packet.protocol === 'ICMP' && s.toDevice && s.phase === 'request');

  it('MAC addresses change at every router while IP addresses stay the same and TTL decreases', () => {
    const t = full();
    const p = runPing(t, buildStaticTables(t).tables, emptyL2(), { src: 'pc1', dstIp: '192.168.3.10' }, 16);
    expect(p.success).toBe(true);
    const sent = frames(p.steps);
    const byAt = (d: string) => sent.filter((s) => s.at === d).at(-1)!.packet;
    const atPc1 = byAt('pc1');
    const atR1 = byAt('r1');
    const atR2 = byAt('r2');
    expect(atPc1.dstMac).toBe(macOf('r1', getIface(t, 'r1', 'r1-g1')!)); // gateway MAC
    expect(atR1.srcMac).toBe(macOf('r1', getIface(t, 'r1', 'r1-g0')!));
    expect(atR1.dstMac).toBe(macOf('r2', getIface(t, 'r2', 'r2-g0')!));
    expect(atR2.dstMac).toBe(macOf('r3', getIface(t, 'r3', 'r3-g0')!));
    for (const v of [atPc1, atR1, atR2]) {
      expect(v.srcIp).toBe('192.168.1.10');
      expect(v.dstIp).toBe('192.168.3.10');
    }
    expect([atPc1.ttl, atR1.ttl, atR2.ttl]).toEqual([16, 15, 14]);
    const icmp = atR1.layers.find((l) => l.name.startsWith('Internet Control'))!;
    expect(icmp.fields.find((f) => f.name === 'Type')!.value).toBe('8 (Echo request)');
    expect(atR1.sizeBytes).toBe(74);
  });

  it('ARP packets carry the right opcode, sender and target', () => {
    const t = full();
    const p = runPing(t, buildStaticTables(t).tables, emptyL2(), { src: 'pc1', dstIp: '192.168.3.10' }, 16);
    const req = p.steps.find((s) => s.action === 'arp-request')!.packet;
    expect(req.protocol).toBe('ARP');
    expect(req.dstMac).toBe('ff:ff:ff:ff:ff:ff');
    const arp = req.layers.find((l) => l.name === 'Address Resolution Protocol')!;
    expect(arp.fields.find((f) => f.name === 'Opcode')!.value).toBe('1 (request)');
    expect(arp.fields.find((f) => f.name === 'Target IP address')!.value).toBe('192.168.1.1');
    const rep = p.steps.find((s) => s.action === 'arp-reply')!.packet;
    expect(rep.layers[1].fields.find((f) => f.name === 'Opcode')!.value).toBe('2 (reply)');
  });

  it('routing messages are inspectable: RIPv2 and OSPF', () => {
    const rip = createTimeline(threeRouter(), 'dv', opts({ profile: 'rip' })).find((f) => f.ev.kind === 'dv-update')!.ev.packet!;
    expect(rip.protocol).toBe('RIPv2');
    expect(rip.dstIp).toBe('224.0.0.9');
    expect(rip.layers.find((l) => l.name === 'User Datagram Protocol')!.fields[0].value).toBe('520');
    const hello = createTimeline(threeRouter(), 'ls', opts()).find((f) => f.ev.kind === 'ls-hello')!.ev.packet!;
    expect(hello.protocol).toBe('OSPF Hello');
    expect(hello.dstIp).toBe('224.0.0.5');
  });
});

describe('routing protocols across a switch', () => {
  /** R1 and R2 meet on a switched LAN (10.0.0.0/24); each has its own PC LAN. */
  function lanRouters() {
    let t = switchedLan();
    // move the R1–R2 link onto the switch
    t = structuredClone(t);
    t.links = t.links.filter((l) => l.id !== 'l1');
    t.devices.find((d) => d.id === 'r1')!.ifaces = t.devices.find((d) => d.id === 'r1')!.ifaces.filter((i) => i.id !== 'r1-g0');
    t.devices.find((d) => d.id === 'r2')!.ifaces = t.devices.find((d) => d.id === 'r2')!.ifaces.filter((i) => i.id !== 'r2-g0');
    // R2 joins R1's LAN through the switch
    t.devices.find((d) => d.id === 'sw1')!.ifaces.push({ id: 'sw1-p9', name: 'Port 9', ip: '', prefix: 24 });
    t.devices.find((d) => d.id === 'r2')!.ifaces.push({ id: 'r2-g9', name: 'G0/0/9', ip: '192.168.1.2', prefix: 24 });
    t.links.push({ id: 'l9', a: { dev: 'sw1', iface: 'sw1-p9' }, b: { dev: 'r2', iface: 'r2-g9' }, cost: 1, up: true });
    return t;
  }

  it('routers on the same switch become neighbours', () => {
    const t = lanRouters();
    expect(errs(t)).toBe('');
    const nb = routerNeighbors(t, 'r1');
    expect(nb.map((n) => n.router)).toEqual(['r2']);
    expect(nb[0].path).toEqual(['r1', 'sw1', 'r2']);
  });

  it('distance vector and link state learn routes through the switch', () => {
    const t = lanRouters();
    const dv = converge(t, 'dv', opts()).state;
    expect(route(dv.tables, 'r1', '192.168.2.0/24')).toMatchObject({ learnedFrom: 'r2', nextHop: '192.168.1.2' });
    const ls = converge(t, 'ls', opts()).state;
    expect(route(ls.tables, 'r1', '192.168.2.0/24')).toMatchObject({ learnedFrom: 'r2', nextHop: '192.168.1.2' });
    const p = runPing(t, ls.tables, emptyL2(), { src: 'pc1', dstIp: '192.168.2.10' }, 16);
    expect(p.success).toBe(true);
  });

  it('a neighbour lost behind the switch times out after 180 time units (RIP-style)', () => {
    const t = lanRouters();
    const { frames } = converge(t, 'dv', opts({ triggeredUpdates: false }));
    const { topo, id } = setLink(t, 'sw1', 'r2', { up: false });
    const after = applyLinkChange(frames, frames.length - 1, topo, [id], 'SW1–R2 down');
    const timeout = after.find((f) => f.ev.kind === 'dv-timeout' && f.ev.routers?.includes('r1'));
    expect(timeout).toBeTruthy();
    expect(timeout!.ev.time - frames.at(-1)!.ev.time).toBeGreaterThanOrEqual(180);
    expect(route(after.at(-1)!.state.tables, 'r1', '192.168.2.0/24')?.unreachable).toBe(true);
  });
});

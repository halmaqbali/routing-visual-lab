import { describe, expect, it } from 'vitest';
import { buildTopology, loopbackLine, threeRouter } from '../src/model/samples';
import { applyLinkChange, converge, createTimeline } from '../src/engine/simulation';
import { runPing } from '../src/engine/ping';
import { emptyL2 } from '../src/engine/l2';
import { validateTopology } from '../src/model/validate';
import { opts, route, setLink } from './helpers';

/** Three routers on one switched LAN (10.0.0.0/24), each with its own PC LAN. Highest router ID: R3. */
function lan() {
  const t = buildTopology({
    routers: [['R1', 150, 120], ['R2', 420, 120], ['R3', 690, 120]],
    switches: [['SW1', 420, 280]],
    pcs: [['PC1', 150, 420], ['PC2', 420, 420], ['PC3', 690, 420]],
    links: [
      ['R1', '10.0.0.1', 'SW1', '', 24],
      ['R2', '10.0.0.2', 'SW1', '', 24],
      ['R3', '10.0.0.3', 'SW1', '', 24],
      ['R1', '192.168.1.1', 'PC1', '192.168.1.10', 24],
      ['R2', '192.168.2.1', 'PC2', '192.168.2.10', 24],
      ['R3', '192.168.3.1', 'PC3', '192.168.3.10', 24],
    ],
  });
  return t;
}

describe('OSPF neighbour states', () => {
  it('neighbours go Init → 2-Way → ExStart/Exchange → Loading → Full on a point-to-point link', () => {
    const frames = createTimeline(threeRouter(), 'ls', opts());
    const titles = frames.map((f) => f.ev.title);
    const idx = (re: RegExp) => titles.findIndex((t) => re.test(t));
    expect(idx(/sends a Hello/)).toBeGreaterThanOrEqual(0);
    expect(idx(/hears .*: Init/)).toBeLessThan(idx(/: 2-Way/));
    expect(idx(/: 2-Way/)).toBeLessThan(idx(/ExStart → Exchange/));
    expect(idx(/ExStart → Exchange/)).toBeLessThan(idx(/Loading → FULL/));
    expect(idx(/Link State Request/)).toBeLessThan(idx(/Loading → FULL/));
    expect(idx(/Loading → FULL/)).toBeLessThan(idx(/originates Router-LSA #2/));
    const last = frames.at(-1)!.state;
    for (const r of ['r1', 'r2', 'r3']) expect(last.ls!.routers[r].neighbors.every((n) => n.state === 'Full')).toBe(true);
  });

  it('Router-LSAs list only FULL neighbours, and loopbacks are advertised as /32', () => {
    const { state } = converge(loopbackLine(), 'ls', opts());
    const r1 = state.ls!.routers.r1.lsdb.r1;
    expect(r1.links.map((l) => l.to)).toEqual(['r2']);
    expect(r1.stubs).toContainEqual({ network: '10.0.1.1', prefix: 32 });
    expect(route(state.tables, 'r1', '10.0.3.3/32')).toMatchObject({ source: 'ls', metric: 2, nextHop: '10.0.12.2' });
    expect(runPing(state.topo, state.tables, emptyL2(), { src: 'r1', srcIp: '10.0.1.1', dstIp: '10.0.3.3' }, 16).success).toBe(true);
  });
});

describe('OSPF on a switched LAN', () => {
  it('elects the highest router ID as DR and the next as BDR', () => {
    const t = lan();
    expect(validateTopology(t).filter((i) => i.severity === 'error')).toEqual([]);
    const { state, frames } = converge(t, 'ls', opts());
    expect(frames.some((f) => f.ev.kind === 'ls-elect' && /DR R3, BDR R2/.test(f.ev.title))).toBe(true);
    const ifc = Object.values(state.ls!.routers.r1.ifaces!).find((i) => i.multiAccess)!;
    expect(ifc).toMatchObject({ dr: 'r3', bdr: 'r2', drIp: '10.0.0.3' });
  });

  it('DROTHERs stay 2-Way with each other and become FULL only with the DR and BDR', () => {
    const { state } = converge(lan(), 'ls', opts());
    const st = (a: string, b: string) => state.ls!.routers[a].neighbors.find((n) => n.router === b)!.state;
    expect(st('r1', 'r3')).toBe('Full');
    expect(st('r1', 'r2')).toBe('Full'); // R2 is BDR
    expect(st('r2', 'r3')).toBe('Full');
    // add a fourth router: R4 (lowest router ID) is a DROTHER, like R1
    const t = lan();
    t.devices.push({ id: 'r4', kind: 'router', name: 'R4', x: 0, y: 0, ifaces: [{ id: 'r4-g0', name: 'G0/0/0', ip: '10.0.0.4', prefix: 24 }], staticRoutes: [] });
    t.devices.find((d) => d.id === 'sw1')!.ifaces.push({ id: 'sw1-p9', name: 'Port 9', ip: '', prefix: 24 });
    t.links.push({ id: 'l9', a: { dev: 'r4', iface: 'r4-g0' }, b: { dev: 'sw1', iface: 'sw1-p9' }, cost: 1, up: true });
    const s4 = converge(t, 'ls', opts()).state;
    const st4 = (a: string, b: string) => s4.ls!.routers[a].neighbors.find((n) => n.router === b)!.state;
    expect(st4('r1', 'r4')).toBe('2-Way'); // two DROTHERs
    expect(st4('r4', 'r3')).toBe('Full');
  });

  it('the DR originates a Network-LSA and SPF crosses the LAN as its own node', () => {
    const { state } = converge(lan(), 'ls', opts());
    const net = state.ls!.routers.r1.lsdb['net:10.0.0.3'];
    expect(net).toMatchObject({ kind: 'network', origin: 'r3', attached: ['r1', 'r2', 'r3'], net: { network: '10.0.0.0', prefix: 24 } });
    expect(state.ls!.routers.r1.lsdb.r1.links).toEqual([{ to: 'net:10.0.0.3', linkId: 'net:10.0.0.3', cost: 1, transit: true }]);
    expect(route(state.tables, 'r1', '192.168.2.0/24')).toMatchObject({ metric: 1, nextHop: '10.0.0.2', learnedFrom: 'r2' });
    expect(runPing(state.topo, state.tables, emptyL2(), { src: 'pc1', dstIp: '192.168.2.10' }, 16).success).toBe(true);
  });

  it('a router that disappears behind the switch is declared down after the Dead interval', () => {
    const t = lan();
    const { frames } = converge(t, 'ls', opts());
    const { topo, id } = setLink(t, 'r2', 'sw1', { up: false });
    const after = applyLinkChange(frames, frames.length - 1, topo, [id], 'R2 unplugged');
    const start = frames.at(-1)!.ev.time;
    const dead = after.find((f) => f.ev.kind === 'ls-dead' && f.ev.routers?.includes('r1'))!;
    expect(dead).toBeTruthy();
    expect(dead.ev.time - start).toBeGreaterThanOrEqual(40);
    expect(route(after.at(-1)!.state.tables, 'r1', '192.168.2.0/24')).toBeUndefined();
  });

  it('when the DR fails, the BDR takes over and routing still works', () => {
    const t = lan();
    const { frames } = converge(t, 'ls', opts());
    const { topo, id } = setLink(t, 'r3', 'sw1', { up: false });
    const after = applyLinkChange(frames, frames.length - 1, topo, [id], 'DR unplugged');
    expect(after.some((f) => f.ev.kind === 'ls-elect' && /DR R2/.test(f.ev.title))).toBe(true);
    const s = after.at(-1)!.state;
    expect(Object.values(s.ls!.routers.r1.ifaces!).find((i) => i.multiAccess)).toMatchObject({ dr: 'r2' });
    expect(route(s.tables, 'r1', '192.168.2.0/24')).toMatchObject({ nextHop: '10.0.0.2' });
    expect(runPing(s.topo, s.tables, emptyL2(), { src: 'pc1', dstIp: '192.168.2.10' }, 16).success).toBe(true);
  });

  it('a link that comes back forms a new adjacency with DBD/LSR database synchronisation', () => {
    const { frames } = converge(threeRouter(), 'ls', opts());
    const down = setLink(threeRouter(), 'r2', 'r3', { up: false });
    const f2 = applyLinkChange(frames, frames.length - 1, down.topo, [down.id], 'down');
    const up = setLink(down.topo, 'r2', 'r3', { up: true });
    const f3 = applyLinkChange(f2, f2.length - 1, up.topo, [up.id], 'up');
    const kinds = f3.slice(f2.length).map((f) => f.ev.title);
    expect(kinds.some((t) => /ExStart → Exchange/.test(t))).toBe(true);
    expect(kinds.some((t) => /Loading → FULL/.test(t))).toBe(true);
    const lsr = kinds.findIndex((t) => /Link State Request \(LSR\)/.test(t));
    const lsu = kinds.findIndex((t) => /Link State Update \(LSU\)/.test(t));
    const ack = kinds.findIndex((t) => /Link State Acknowledgment \(LSAck\)/.test(t));
    expect(lsr).toBeGreaterThanOrEqual(0);
    expect(lsr).toBeLessThan(lsu);
    expect(lsu).toBeLessThan(ack);
    const msgs = new Set(f3.map((f) => (f.ev.anim?.style === 'ospf' ? f.ev.anim.label : null)).filter(Boolean));
    for (const m of ['Hello', 'DBD', 'LSR', 'LSU', 'LSAck']) expect(msgs.has(m)).toBe(true);
    expect(route(f3.at(-1)!.state.tables, 'r1', '192.168.3.0/24')).toMatchObject({ metric: 2, nextHop: '10.0.12.2' });
  });
});

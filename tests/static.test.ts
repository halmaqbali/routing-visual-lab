import { describe, expect, it } from 'vitest';
import { addStatic, fiveRouter, staticRoute, threeRouter } from '../src/model/samples';
import { buildStaticTables } from '../src/engine/static';
import { lookup, routeKey, type Route } from '../src/engine/rib';
import { simulatePing } from '../src/engine/ping';
import { setLink } from './helpers';

const fullStatic = () => {
  let t = threeRouter();
  t = addStatic(t, 'R1', staticRoute('192.168.3.0', 24, '10.0.12.2'), staticRoute('10.0.23.0', 24, '10.0.12.2'));
  t = addStatic(t, 'R2', staticRoute('192.168.1.0', 24, '10.0.12.1'), staticRoute('192.168.3.0', 24, '10.0.23.3'));
  t = addStatic(t, 'R3', staticRoute('192.168.1.0', 24, '10.0.23.2'), staticRoute('10.0.12.0', 24, '10.0.23.2'));
  return t;
};

const r = (network: string, prefix: number, nextHop: string): Route => ({ network, prefix, source: 'static', nextHop, iface: 'x', metric: 0, ad: 1 });

describe('longest-prefix matching', () => {
  const table = [r('0.0.0.0', 0, 'a'), r('10.0.0.0', 8, 'b'), r('10.1.0.0', 16, 'c'), r('10.1.2.0', 24, 'd')];
  it('chooses the most specific matching route', () => {
    expect(lookup(table, '10.1.2.9').match?.nextHop).toBe('d');
    expect(lookup(table, '10.1.9.9').match?.nextHop).toBe('c');
    expect(lookup(table, '10.9.9.9').match?.nextHop).toBe('b');
    expect(lookup(table, '8.8.8.8').match?.nextHop).toBe('a');
    expect(lookup(table, '10.1.2.9').candidates).toHaveLength(4);
  });
  it('returns no match without a default route', () => {
    expect(lookup(table.slice(1), '8.8.8.8').match).toBeNull();
  });
  it('ignores unreachable routes', () => {
    expect(lookup([{ ...r('10.1.2.0', 24, 'd'), unreachable: true }, r('10.0.0.0', 8, 'b')], '10.1.2.1').match?.nextHop).toBe('b');
  });
});

describe('static routing and ping', () => {
  it('connected routes only: remote ping fails at the first router', () => {
    const { tables } = buildStaticTables(threeRouter());
    expect(tables.r1.map(routeKey)).toEqual(['10.0.12.0/24', '192.168.1.0/24']);
    const p = simulatePing(threeRouter(), tables, 'pc1', 'pc2', 16);
    expect(p.success).toBe(false);
    expect(p.failure).toMatchObject({ code: 'no-route', at: 'r1', phase: 'request' });
  });
  it('complete static routes: request and reply both succeed, TTL decreases per router', () => {
    const t = fullStatic();
    const { tables } = buildStaticTables(t);
    const p = simulatePing(t, tables, 'pc1', 'pc2', 16);
    expect(p.success).toBe(true);
    expect(p.requestPath).toEqual(['pc1', 'r1', 'r2', 'r3', 'pc2']);
    expect(p.replyPath).toEqual(['pc2', 'r3', 'r2', 'r1', 'pc1']);
    const r2 = p.steps.find((s) => s.at === 'r2' && s.phase === 'request')!;
    expect(r2.ttlIn).toBe(15);
    expect(r2.ttlOut).toBe(14);
    expect(r2.nextHopIp).toBe('10.0.23.3');
    expect(r2.dstIp).toBe('192.168.3.10'); // next hop never replaces the destination
  });
  it('missing return route: request arrives, reply is dropped', () => {
    let t = threeRouter();
    t = addStatic(t, 'R1', staticRoute('192.168.3.0', 24, '10.0.12.2'));
    t = addStatic(t, 'R2', staticRoute('192.168.3.0', 24, '10.0.23.3'));
    const { tables } = buildStaticTables(t);
    const p = simulatePing(t, tables, 'pc1', 'pc2', 16);
    expect(p.success).toBe(false);
    expect(p.requestPath.at(-1)).toBe('pc2');
    expect(p.failure).toMatchObject({ code: 'missing-return-route', at: 'r3', phase: 'reply' });
  });
  it('missing default gateway is reported at the PC', () => {
    const t = fullStatic();
    t.devices.find((d) => d.id === 'pc1')!.gateway = '';
    const p = simulatePing(t, buildStaticTables(t).tables, 'pc1', 'pc2', 16);
    expect(p.failure).toMatchObject({ code: 'no-gateway', at: 'pc1' });
  });
  it('default route versus a more specific route', () => {
    let t = fullStatic();
    // R1: a default route to R2 and a more specific (wrong) /25 pointing nowhere useful
    t = addStatic(t, 'R1', staticRoute('0.0.0.0', 0, '10.0.12.2'));
    const tables = buildStaticTables(t).tables;
    expect(lookup(tables.r1, '192.168.3.10').match?.prefix).toBe(24);
    expect(lookup(tables.r1, '172.16.0.1').match?.prefix).toBe(0);
  });
  it('resolves next hops recursively', () => {
    let t = fullStatic();
    // R1 reaches 172.16.0.0/16 via R3's far address 10.0.23.3, which R1 only knows through a static route
    t = addStatic(t, 'R1', staticRoute('172.16.0.0', 16, '10.0.23.3'));
    const tables = buildStaticTables(t).tables;
    const rr = tables.r1.find((x) => x.network === '172.16.0.0')!;
    expect(rr.resolvedVia).toBe('10.0.12.2');
    expect(rr.iface).toBe('r1-g0');
  });
  it('rejects a static route whose next hop cannot be resolved', () => {
    const t = addStatic(threeRouter(), 'R1', staticRoute('192.168.3.0', 24, '10.9.9.9'));
    const b = buildStaticTables(t);
    expect(b.tables.r1.some((x) => x.network === '192.168.3.0')).toBe(false);
    expect(b.status.r1[0].installed).toBe(false);
  });
  it('floating static route takes over after a link failure', () => {
    let t = fiveRouter();
    t = addStatic(t, 'R1', staticRoute('192.168.3.0', 24, '10.0.12.2', 1), staticRoute('192.168.3.0', 24, '10.0.14.4', 5));
    let b = buildStaticTables(t);
    expect(b.tables.r1.find((x) => x.network === '192.168.3.0')!.nextHop).toBe('10.0.12.2');
    expect(b.status.r1[1].installed).toBe(false);
    const failed = setLink(t, 'r1', 'r2', { up: false }).topo;
    b = buildStaticTables(failed);
    expect(b.tables.r1.find((x) => x.network === '192.168.3.0')!.nextHop).toBe('10.0.14.4');
    expect(b.status.r1[1].installed).toBe(true);
  });
  it('detects a routing loop through TTL expiry', () => {
    let t = threeRouter();
    t = addStatic(t, 'R1', staticRoute('0.0.0.0', 0, '10.0.12.2'));
    t = addStatic(t, 'R2', staticRoute('0.0.0.0', 0, '10.0.12.1'));
    const p = simulatePing(t, buildStaticTables(t).tables, 'pc1', 'pc2', 8);
    expect(p.failure?.code).toBe('ttl-expired');
    expect(p.failure?.message).toMatch(/loop/);
    const routerHops = p.steps.filter((s) => s.action === 'forward');
    expect(routerHops).toHaveLength(7);
  });
  it('reports a failed link on the forwarding path', () => {
    const t = fullStatic();
    // disable R2-R3: R2 loses its connected route and its static route to 192.168.3.0 cannot resolve
    const failed = setLink(t, 'r2', 'r3', { up: false }).topo;
    const p = simulatePing(failed, buildStaticTables(failed).tables, 'pc1', 'pc2', 16);
    expect(p.failure).toMatchObject({ code: 'no-route', at: 'r2' });
  });
});

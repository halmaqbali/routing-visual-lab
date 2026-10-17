import { describe, expect, it } from 'vitest';
import { fiveRouter, threeRouter, triangle } from '../src/model/samples';
import { applyLinkChange, converge, createTimeline } from '../src/engine/simulation';
import { simulatePing } from '../src/engine/ping';
import { opts, route, setLink } from './helpers';

describe('distance vector', () => {
  it('starts with connected networks only', () => {
    const f = createTimeline(threeRouter(), 'dv', opts());
    expect(f[0].state.tables.r1.every((r) => r.source === 'connected')).toBe(true);
  });

  it('learns remote networks through neighbours and converges', () => {
    const { state, frames } = converge(threeRouter(), 'dv', opts());
    expect(state.dv!.converged).toBe(true);
    expect(frames.at(-1)!.ev.kind).toBe('dv-converged');
    const r = route(state.tables, 'r1', '192.168.3.0/24')!;
    expect(r).toMatchObject({ source: 'dv', metric: 2, nextHop: '10.0.12.2', learnedFrom: 'r2' });
    expect(simulatePing(state.topo, state.tables, 'pc1', 'pc2', 16).success).toBe(true);
  });

  it('shows the candidate calculation: link cost + advertised cost', () => {
    const { frames } = converge(triangle(), 'dv', opts());
    const ev = frames.find((f) => f.ev.dv && f.ev.dv.to === 'r1' && f.ev.dv.from === 'r3')!.ev.dv!;
    const row = ev.rows.find((x) => x.key === '192.168.3.0/24')!;
    expect(row.linkCost).toBe(5);
    expect(row.advertised).toBe(0);
    expect(row.candidate).toBe(5);
  });

  it('selects the better path in a weighted triangle (R1→R3 via R2 = 2, direct = 5)', () => {
    const { state, frames } = converge(triangle(), 'dv', opts());
    expect(route(state.tables, 'r1', '192.168.3.0/24')).toMatchObject({ metric: 2, learnedFrom: 'r2' });
    // At some event R1 switched from the direct path to the better path via R2
    expect(frames.some((f) => f.ev.dv?.rows.some((x) => x.key === '192.168.3.0/24' && x.decision === 'better'))).toBe(true);
  });

  it('finds least-cost paths in the five-router network', () => {
    const { state } = converge(fiveRouter(), 'dv', opts());
    expect(route(state.tables, 'r1', '192.168.3.0/24')).toMatchObject({ metric: 3, learnedFrom: 'r4' });
    expect(route(state.tables, 'r2', '192.168.3.0/24')).toMatchObject({ metric: 4, learnedFrom: 'r5' });
  });

  it('RIP profile uses hop counts, ignoring weighted costs', () => {
    const { state } = converge(fiveRouter(), 'dv', opts({ profile: 'rip' }));
    expect(state.dv!.infinity).toBe(16);
    const r = route(state.tables, 'r1', '192.168.3.0/24')!;
    expect(r.metric).toBe(2); // R1-R2-R3 is 2 hops
    expect(r.learnedFrom).toBe('r2');
  });

  it('propagates unreachable routes after a failure (poison reverse + triggered updates)', () => {
    const o = opts({ splitHorizon: true, poisonReverse: true, triggeredUpdates: true });
    const { frames } = converge(threeRouter(), 'dv', o);
    const { topo, id } = setLink(threeRouter(), 'r2', 'r3', { up: false });
    const after = applyLinkChange(frames, frames.length - 1, topo, [id], 'R2–R3 disabled');
    const s = after.at(-1)!.state;
    expect(s.dv!.converged).toBe(true);
    expect(route(s.tables, 'r1', '192.168.3.0/24')?.unreachable).toBe(true);
    expect(route(s.tables, 'r2', '192.168.3.0/24')?.unreachable).toBe(true);
    // nobody counts above the first unreachable notice
    const maxMetric = Math.max(...after.slice(frames.length).flatMap((f) => (f.state.tables.r1 ?? []).filter((r) => r.network === '192.168.3.0' && !r.unreachable).map((r) => r.metric)), 0);
    expect(maxMetric).toBeLessThanOrEqual(2);
  });

  it('counts to infinity without split horizon, poison reverse or triggered updates (RIP: 16)', () => {
    const o = opts({ profile: 'rip', splitHorizon: false, poisonReverse: false, triggeredUpdates: false });
    const { frames } = converge(threeRouter(), 'dv', o);
    const { topo, id } = setLink(threeRouter(), 'r2', 'r3', { up: false });
    const after = applyLinkChange(frames, frames.length - 1, topo, [id], 'R2–R3 disabled');
    const metrics = after.slice(frames.length).map((f) => route(f.state.tables, 'r2', '192.168.3.0/24')).filter((r) => r && !r.unreachable).map((r) => r!.metric);
    expect(Math.max(...metrics)).toBeGreaterThanOrEqual(14); // counted up close to 16
    const s = after.at(-1)!.state;
    expect(route(s.tables, 'r1', '192.168.3.0/24')?.unreachable).toBe(true);
    expect(route(s.tables, 'r2', '192.168.3.0/24')?.unreachable).toBe(true);
    // During counting, a ping loops between R1 and R2 until TTL expires
    const mid = after.slice(frames.length).find((f) => route(f.state.tables, 'r2', '192.168.3.0/24')?.learnedFrom === 'r1' && !route(f.state.tables, 'r1', '192.168.3.0/24')?.unreachable)!;
    expect(mid).toBeTruthy();
    const ping = simulatePing(mid.state.topo, mid.state.tables, 'pc1', 'pc2', 16);
    expect(ping.failure?.code).toBe('ttl-expired');
  });

  it('split horizon prevents the two-router loop in a line topology', () => {
    const o = opts({ profile: 'rip', splitHorizon: true, poisonReverse: false, triggeredUpdates: false });
    const { frames } = converge(threeRouter(), 'dv', o);
    const { topo, id } = setLink(threeRouter(), 'r2', 'r3', { up: false });
    const after = applyLinkChange(frames, frames.length - 1, topo, [id], 'R2–R3 disabled');
    const r2 = after.slice(frames.length).map((f) => route(f.state.tables, 'r2', '192.168.3.0/24'));
    expect(r2.every((r) => !r || r.unreachable || r.learnedFrom !== 'r1')).toBe(true);
  });

  it('is deterministic', () => {
    const a = createTimeline(fiveRouter(), 'dv', opts());
    const b = createTimeline(fiveRouter(), 'dv', opts());
    expect(a.map((f) => f.ev.title)).toEqual(b.map((f) => f.ev.title));
  });

  it('recovers when the link comes back', () => {
    const o = opts();
    const { frames } = converge(threeRouter(), 'dv', o);
    const down = setLink(threeRouter(), 'r2', 'r3', { up: false });
    const f2 = applyLinkChange(frames, frames.length - 1, down.topo, [down.id], 'down');
    const up = setLink(down.topo, 'r2', 'r3', { up: true });
    const f3 = applyLinkChange(f2, f2.length - 1, up.topo, [up.id], 'up');
    const s = f3.at(-1)!.state;
    expect(route(s.tables, 'r1', '192.168.3.0/24')).toMatchObject({ metric: 2, learnedFrom: 'r2' });
    expect(route(s.tables, 'r1', '192.168.3.0/24')?.unreachable).toBeFalsy();
  });
});

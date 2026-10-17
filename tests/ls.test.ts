import { describe, expect, it } from 'vitest';
import { fiveRouter, threeRouter } from '../src/model/samples';
import { dijkstra } from '../src/engine/ls';
import { applyLinkChange, converge, createTimeline } from '../src/engine/simulation';
import { simulatePing } from '../src/engine/ping';
import type { Lsa } from '../src/engine/types';
import { opts, route, setLink } from './helpers';

const lsa = (origin: string, links: [string, number, string][]): Lsa => ({ origin, seq: 1, links: links.map(([to, cost, linkId]) => ({ to, cost, linkId })), stubs: [] });

describe('Dijkstra', () => {
  // A-B 1, B-C 1, A-C 5, C-D 1
  const db: Record<string, Lsa> = {
    A: lsa('A', [['B', 1, 'ab'], ['C', 5, 'ac']]),
    B: lsa('B', [['A', 1, 'ab'], ['C', 1, 'bc']]),
    C: lsa('C', [['A', 5, 'ac'], ['B', 1, 'bc'], ['D', 1, 'cd']]),
    D: lsa('D', [['C', 1, 'cd']]),
  };
  it('computes shortest distances and predecessors', () => {
    const r = dijkstra('A', db);
    expect(r.dist).toEqual({ A: 0, B: 1, C: 2, D: 3 });
    expect(r.pred.C).toEqual({ node: 'B', linkId: 'bc' });
    expect(r.steps.map((s) => s.selected)).toEqual(['A', 'B', 'C', 'D']);
  });
  it('records the improvement of a tentative distance', () => {
    const r = dijkstra('A', db);
    const imp = r.steps[1].relax.find((x) => x.node === 'C')!;
    expect(imp).toMatchObject({ oldDist: 5, newDist: 2, outcome: 'improved' });
  });
  it('derives the next hop from the first router on the path', () => {
    const r = dijkstra('A', db);
    expect(r.firstHop.D.router).toBe('B');
    expect(r.firstHop.B.router).toBe('B');
  });
  it('each router uses itself as the root', () => {
    const r = dijkstra('D', db);
    expect(r.steps[0].selected).toBe('D');
    expect(r.firstHop.A.router).toBe('C');
    expect(r.dist.A).toBe(3);
  });
  it('ignores links that are not reported by both ends (two-way check)', () => {
    const one: Record<string, Lsa> = { ...db, B: lsa('B', [['A', 1, 'ab']]) };
    const r = dijkstra('A', one);
    expect(r.dist.C).toBe(5);
  });
});

describe('link state simulation', () => {
  it('floods every LSA so all routers have the same database', () => {
    const { state } = converge(fiveRouter(), 'ls', opts());
    for (const r of ['r1', 'r2', 'r3', 'r4', 'r5']) expect(Object.keys(state.ls!.routers[r].lsdb).sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
  });
  it('separates the stages in order: hello, describe, originate, flood, SPF, install', () => {
    const kinds = createTimeline(threeRouter(), 'ls', opts()).map((f) => f.ev.kind);
    const first = (k: string) => kinds.indexOf(k);
    expect(first('ls-hello')).toBeLessThan(first('ls-describe'));
    expect(first('ls-describe')).toBeLessThan(first('ls-originate'));
    expect(first('ls-originate')).toBeLessThan(first('ls-flood'));
    expect(first('ls-flood')).toBeLessThan(first('spf-start'));
    expect(first('spf-step')).toBeLessThan(first('ls-install'));
    expect(kinds.includes('ls-dup')).toBe(false); // line topology: no duplicates
  });
  it('installs shortest-path routes with the correct next hop', () => {
    const { state } = converge(fiveRouter(), 'ls', opts());
    expect(route(state.tables, 'r1', '192.168.3.0/24')).toMatchObject({ source: 'ls', metric: 3, nextHop: '10.0.14.4' });
    expect(route(state.tables, 'r2', '192.168.3.0/24')).toMatchObject({ metric: 4, nextHop: '10.0.25.5' });
    expect(simulatePing(state.topo, state.tables, 'pc1', 'pc2', 16).success).toBe(true);
  });
  it('reacts to a link failure: new LSA, flooding, recalculation', () => {
    const { frames } = converge(fiveRouter(), 'ls', opts());
    const { topo, id } = setLink(fiveRouter(), 'r4', 'r5', { up: false });
    const after = applyLinkChange(frames, frames.length - 1, topo, [id], 'R4–R5 disabled');
    const s = after.at(-1)!.state;
    expect(s.ls!.routers.r1.lsdb.r4.seq).toBe(2);
    expect(route(s.tables, 'r1', '192.168.3.0/24')).toMatchObject({ metric: 6, nextHop: '10.0.12.2' }) // R1-R2-R5-R3 = 2+3+1;
    const newKinds = after.slice(frames.length).map((f) => f.ev.kind);
    expect(newKinds).toContain('ls-detect');
    expect(newKinds).toContain('ls-originate');
    expect(newKinds).toContain('ls-flood');
    expect(newKinds).toContain('spf-step');
    // and recovery
    const up = setLink(topo, 'r4', 'r5', { up: true });
    const again = applyLinkChange(after, after.length - 1, up.topo, [up.id], 'R4–R5 enabled');
    expect(route(again.at(-1)!.state.tables, 'r1', '192.168.3.0/24')).toMatchObject({ metric: 3, nextHop: '10.0.14.4' });
  });
  it('reacts to a cost change', () => {
    const { frames } = converge(fiveRouter(), 'ls', opts());
    const { topo, id } = setLink(fiveRouter(), 'r1', 'r4', { cost: 10 });
    const after = applyLinkChange(frames, frames.length - 1, topo, [id], 'cost');
    expect(route(after.at(-1)!.state.tables, 'r1', '192.168.3.0/24')).toMatchObject({ metric: 6, nextHop: '10.0.12.2' });
  });
});

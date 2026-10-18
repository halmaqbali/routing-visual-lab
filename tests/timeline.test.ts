import { describe, expect, it } from 'vitest';
import { threeRouter } from '../src/model/samples';
import { applyLinkChange, createTimeline, insertPing } from '../src/engine/simulation';
import { opts, route, setLink } from './helpers';

describe('timeline state restoration', () => {
  it('each frame keeps its own state, so Previous restores the earlier tables', () => {
    const f = createTimeline(threeRouter(), 'dv', opts());
    const learnedAt = f.findIndex((x) => route(x.state.tables, 'r1', '192.168.3.0/24'));
    expect(learnedAt).toBeGreaterThan(0);
    expect(route(f[learnedAt - 1].state.tables, 'r1', '192.168.3.0/24')).toBeUndefined();
    expect(route(f[learnedAt].state.tables, 'r1', '192.168.3.0/24')).toBeDefined();
  });
  it('a change mid-run discards stale future events and keeps the past intact', () => {
    const f = createTimeline(threeRouter(), 'dv', opts());
    const cursor = 3;
    const snapshot = JSON.stringify(f[cursor].state.tables);
    const { topo, id } = setLink(threeRouter(), 'r1', 'r2', { up: false });
    const g = applyLinkChange(f, cursor, topo, [id], 'R1–R2 disabled');
    expect(JSON.stringify(g[cursor].state.tables)).toBe(snapshot);
    expect(g[cursor + 1].ev.kind).toBe('config-change');
    expect(g.slice(cursor + 1).every((x) => x.state.topo === topo)).toBe(true);
  });
  it('ping frames do not change routing state', () => {
    const f = createTimeline(threeRouter(), 'ls', opts());
    const last = f.length - 1;
    const { frames, result } = insertPing(f, last, 'pc1', 'pc2');
    expect(result.success).toBe(true);
    expect(frames.slice(last + 1).every((x) => x.state.tables === f[last].state.tables && x.state.ls === f[last].state.ls)).toBe(true);
    expect(frames.slice(last + 1).every((x) => x.ev.category === 'data')).toBe(true);
  });
});

describe('ping runs', () => {
  it('labels each ping and summarises the run like the ping command', async () => {
    const { buildPingFrames, pingStatsFrame } = await import('../src/engine/simulation');
    const f = createTimeline(threeRouter(), 'static', opts());
    const at = f.at(-1)!.state;
    const p = buildPingFrames(at, { src: 'pc1', dstIp: '192.168.3.10' }, 'Ping 2 of 3');
    expect(p.frames[0].ev.title).toBe('Ping 2 of 3: PC1 → PC2 (192.168.3.10)');
    expect(p.result.success).toBe(false); // no static routes configured
    expect(p.frames.at(-1)!.ev.kind).toBe('ping-result');
    const s = pingStatsFrame(at, 'PC1', 'PC2', 3, 1);
    expect(s.ev.title).toBe('Ping statistics: 3 sent, 1 received, 67% loss');
    expect(s.state).toBe(at);
  });
  it('pings sent at different points of a DV run see different routing tables', async () => {
    const { buildPingFrames } = await import('../src/engine/simulation');
    const f = createTimeline(threeRouter(), 'dv', opts());
    expect(buildPingFrames(f[0].state, { src: 'pc1', dstIp: '192.168.3.10' }).result.success).toBe(false);
    expect(buildPingFrames(f.at(-1)!.state, { src: 'pc1', dstIp: '192.168.3.10' }).result.success).toBe(true);
  });
});

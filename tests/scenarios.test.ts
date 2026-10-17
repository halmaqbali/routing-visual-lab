import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../src/scenarios';
import { createTimeline, applyLinkChange } from '../src/engine/simulation';
import { validateTopology } from '../src/model/validate';
import { DEFAULT_OPTIONS } from '../src/model/types';
import { simulatePing } from '../src/engine/ping';

const optsFor = (dv = {}) => ({ ...DEFAULT_OPTIONS, dv: { ...DEFAULT_OPTIONS.dv, ...dv } });

describe('guided scenarios', () => {
  it('there are at least 13 scenarios with complete teaching content', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(13);
    for (const s of SCENARIOS) {
      expect(s.objective).toBeTruthy();
      expect(s.prediction.question).toBeTruthy();
      expect(s.prediction.choices.length).toBeGreaterThan(1);
      expect(s.actions.length).toBeGreaterThan(0);
    }
  });
  it('every scenario starts from a valid configuration and explains itself at start and end', () => {
    for (const s of SCENARIOS) {
      const topo = s.topology();
      expect(validateTopology(topo).filter((i) => i.severity === 'error'), s.id).toEqual([]);
      const frames = createTimeline(topo, s.mode === 'compare' ? 'static' : s.mode, optsFor(s.dv));
      for (const cursor of [0, frames.length - 1]) {
        const text = s.explain({ frames, cursor, state: frames[cursor].state, topo, selected: s.select ?? null });
        expect(text.length, s.id).toBeGreaterThan(20);
      }
    }
  });
  it('explanations follow the actual result, not a hard-coded outcome', () => {
    const s = SCENARIOS.find((x) => x.id === 'missing-return')!;
    const topo = s.topology();
    let frames = createTimeline(topo, 'static', optsFor());
    const before = s.explain({ frames, cursor: frames.length - 1, state: frames.at(-1)!.state, topo, selected: null });
    expect(before).toMatch(/FAILS during the echo reply/);
    // Student adds the missing return routes
    const fixed = structuredClone(topo);
    fixed.devices.find((d) => d.id === 'r3')!.staticRoutes.push({ id: 'x1', network: '192.168.1.0', prefix: 24, nextHop: '10.0.23.2', ad: 1, enabled: true });
    fixed.devices.find((d) => d.id === 'r2')!.staticRoutes.push({ id: 'x2', network: '192.168.1.0', prefix: 24, nextHop: '10.0.12.1', ad: 1, enabled: true });
    frames = createTimeline(fixed, 'static', optsFor());
    const after = s.explain({ frames, cursor: frames.length - 1, state: frames.at(-1)!.state, topo: fixed, selected: null });
    expect(after).toMatch(/SUCCEEDS/);
  });
  it('backup static scenario: R1–R2 failure is survived, R2–R3 failure is not', () => {
    const s = SCENARIOS.find((x) => x.id === 'backup-static')!;
    const topo = s.topology();
    const frames = createTimeline(topo, 'static', optsFor());
    const fail = (a: string, b: string) => {
      const t = structuredClone(topo);
      const l = t.links.find((x) => (x.a.dev === a && x.b.dev === b) || (x.a.dev === b && x.b.dev === a))!;
      l.up = false;
      const st = applyLinkChange(frames, frames.length - 1, t, [l.id], 'fail').at(-1)!.state;
      return simulatePing(st.topo, st.tables, 'pc1', 'pc2', 16);
    };
    expect(fail('r1', 'r2').success).toBe(true);
    expect(fail('r2', 'r3').failure?.at).toBe('r2');
  });
});

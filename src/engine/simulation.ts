// Simulation timeline: an array of frames, each holding the full state AFTER its event.
// Previous Event simply shows an earlier frame, so it always restores the real earlier state.
import type { Mode, SimOptions, Topology } from '../model/types';
import { deviceName, getDevice, routers } from '../model/topology';
import { cloneState, frame } from './core';
import { dvInit, dvLinkChange, dvStep } from './dv';
import { lsInit, lsLinkChange, lsStep } from './ls';
import { simulatePing, type PingResult } from './ping';
import { diffTables } from './rib';
import { buildStaticTables, connectedOnlyTables } from './static';
import type { Frame, SimState } from './types';

export const FRAME_LIMIT = 3000;

export function baseState(topo: Topology, mode: Mode, options: SimOptions): SimState {
  return { time: 0, topo, mode, options, tables: {}, staticStatus: {}, dv: null, ls: null, queue: [], seq: 0, done: false, spfView: null };
}

function staticInit(base: SimState): Frame[] {
  const s1 = cloneState(base);
  s1.tables = connectedOnlyTables(s1.topo);
  const c1 = diffTables(s1.topo, {}, s1.tables);
  const f1 = frame(s1, {
    kind: 'static-connected', category: 'config', title: 'Interfaces up: connected routes installed',
    explain: 'Every router automatically knows the networks on its own active interfaces (connected routes, AD 0). Nothing else is known yet: remote networks must be added by hand as static routes.',
    changes: c1,
  });
  const s2 = cloneState(s1);
  const built = buildStaticTables(s2.topo);
  s2.tables = built.tables;
  s2.staticStatus = built.status;
  s2.done = true;
  const c2 = diffTables(s2.topo, s1.tables, s2.tables);
  const count = routers(s2.topo).reduce((n, r) => n + (getDevice(s2.topo, r.id)?.staticRoutes.length ?? 0), 0);
  const f2 = frame(s2, {
    kind: 'static-install', category: 'config', title: count ? 'Static routes installed' : 'No static routes configured',
    explain: count
      ? `The routers check each configured static route. A route is installed only if its next hop can be reached; if two routes cover the same network the lower administrative distance wins. ${c2.length} route${c2.length === 1 ? '' : 's'} added. Static routes never change by themselves.`
      : 'No static routes are configured, so each router only knows its connected networks. Try pinging between PCs: what happens?',
    changes: c2,
  });
  return [f1, f2];
}

function step(s: SimState): Frame[] {
  if (s.done) return [];
  if (s.mode === 'dv') return dvStep(s);
  if (s.mode === 'ls') return lsStep(s);
  return [];
}

/** Run until the protocol is quiet or the frame limit is reached. */
export function extend(frames: Frame[], limit = FRAME_LIMIT): Frame[] {
  const out = [...frames];
  while (out.length < limit) {
    const last = out[out.length - 1].state;
    if (last.done) return out;
    const next = step(last);
    if (next.length === 0) {
      const s = cloneState(last);
      s.done = true;
      out[out.length - 1] = { ...out[out.length - 1], state: s };
      return out;
    }
    out.push(...next);
  }
  const last = cloneState(out[out.length - 1].state);
  last.done = true;
  out.push(frame(last, { kind: 'limit', category: 'info', title: 'Event limit reached', explain: `The simulation stopped after ${limit} events. This usually means routers are still counting to infinity. Try a lower infinity value or turn on split horizon / poison reverse.` }));
  return out;
}

export function createTimeline(topo: Topology, mode: Mode, options: SimOptions): Frame[] {
  const base = baseState(topo, mode, options);
  const initial = mode === 'static' ? staticInit(base) : mode === 'dv' ? dvInit(base) : lsInit(base);
  return extend(initial);
}

/**
 * The user changed links (enable/disable/cost) at frame `cursor`. Later frames are discarded and a new
 * event sequence is generated from the state at the cursor, so stale future events are never replayed.
 */
export function applyLinkChange(frames: Frame[], cursor: number, newTopo: Topology, linkIds: string[], description: string): Frame[] {
  const kept = frames.slice(0, cursor + 1);
  const at = kept[kept.length - 1].state;
  const s = cloneState(at);
  s.topo = newTopo;
  const cfg = frame(s, { kind: 'config-change', category: 'config', title: description, explain: `You changed the network: ${description}. Events that were planned after this point have been discarded and a new event sequence starts here from the current routing state.` });
  let reaction: Frame[];
  if (at.mode === 'static') {
    const s2 = cloneState(s);
    const built = buildStaticTables(newTopo);
    s2.tables = built.tables;
    s2.staticStatus = built.status;
    s2.done = true;
    const changes = diffTables(newTopo, at.tables, s2.tables);
    reaction = [frame(s2, {
      kind: 'static-recalc', category: 'config', title: 'Routers re-check connected and static routes',
      explain: changes.length
        ? `Connected routes on failed interfaces are removed, and static routes whose next hop can no longer be reached are withdrawn. Backup (floating) static routes with a higher AD are installed if the main route disappears. ${changes.length} change${changes.length > 1 ? 's' : ''}. Routers further away are NOT told anything — static routing has no updates.`
        : 'No routing table changed. Static routes do not react to failures elsewhere in the network: routers only notice their OWN interfaces.',
      changes,
    })];
  } else if (at.mode === 'dv') reaction = dvLinkChange(s, newTopo, linkIds);
  else reaction = lsLinkChange(s, newTopo, linkIds);
  return extend([...kept, cfg, ...reaction]);
}

/** Static-route configuration changed (static mode): recompute tables as a new config event. */
export function applyStaticConfigChange(frames: Frame[], cursor: number, newTopo: Topology, description: string): Frame[] {
  const kept = frames.slice(0, cursor + 1);
  const at = kept[kept.length - 1].state;
  const s = cloneState(at);
  s.topo = newTopo;
  const built = buildStaticTables(newTopo);
  s.tables = built.tables;
  s.staticStatus = built.status;
  s.done = true;
  const changes = diffTables(newTopo, at.tables, s.tables);
  return [...kept, frame(s, { kind: 'config-change', category: 'config', title: description, explain: `${description}. ${changes.length ? `${changes.length} routing table entr${changes.length > 1 ? 'ies' : 'y'} changed.` : 'No routing table changed (check the route status for the reason).'}`, changes })];
}

/** Insert a ping trace after `cursor`. Data packets never change routing state. */
export function insertPing(frames: Frame[], cursor: number, srcId: string, dstId: string): { frames: Frame[]; result: PingResult; start: number } {
  const at = frames[cursor].state;
  const result = simulatePing(at.topo, at.tables, srcId, dstId, at.options.ttl);
  const t = at.topo;
  const pingFrames: Frame[] = [];
  pingFrames.push(frame(at, {
    kind: 'ping-start', category: 'data', title: `Ping ${deviceName(t, srcId)} → ${deviceName(t, dstId)}`,
    explain: `${deviceName(t, srcId)} pings ${deviceName(t, dstId)}. A successful ping needs TWO journeys: the echo request there AND the echo reply back. Each router uses only its own routing table, as it is right now.`,
  }));
  for (const st of result.steps) {
    const who = deviceName(t, st.at);
    const ph = st.phase === 'request' ? 'Echo request' : 'Echo reply';
    pingFrames.push(frame(at, {
      kind: 'ping-hop', category: 'data',
      title: `${ph} at ${who}: ${st.action === 'drop' ? 'DROPPED' : st.action}`,
      explain: st.message,
      routers: [st.at],
      ping: st,
      anim: st.toDevice && st.linkId ? { from: st.at, to: st.toDevice, linkId: st.linkId, style: 'data', label: st.phase === 'request' ? 'REQ' : 'REP', ttl: st.ttlOut } : st.action === 'drop' ? { from: st.at, to: st.at, linkId: '', style: 'data', drop: true, label: 'X', ttl: st.ttlOut } : undefined,
    }));
  }
  pingFrames.push(frame(at, {
    kind: 'ping-result', category: 'data',
    title: result.success ? 'Ping successful' : 'Ping failed',
    explain: result.success
      ? `Success: the echo request reached ${deviceName(t, dstId)} and the echo reply came back to ${deviceName(t, srcId)}. Request path: ${result.requestPath.map((d) => deviceName(t, d)).join(' → ')}. Reply path: ${result.replyPath.map((d) => deviceName(t, d)).join(' → ')}.`
      : `Failed during the echo ${result.failure?.phase} at ${deviceName(t, result.failure?.at ?? '')}: ${result.failure?.message}`,
  }));
  return { frames: [...frames.slice(0, cursor + 1), ...pingFrames, ...frames.slice(cursor + 1)], result, start: cursor + 1 };
}

/** Run a mode to completion and return the final state (used by comparison and tests). */
export function converge(topo: Topology, mode: Mode, options: SimOptions): { frames: Frame[]; state: SimState } {
  const frames = createTimeline(topo, mode, options);
  return { frames, state: frames[frames.length - 1].state };
}

// Guided classroom scenarios. Every explanation is computed from the CURRENT simulation state,
// so if a student's configuration breaks something, the explanation says so.
import { addStatic, fiveRouter, staticRoute, threeRouter, triangle } from '../model/samples';
import { deviceName } from '../model/topology';
import type { DvOptions, Level, Mode, Topology } from '../model/types';
import { simulatePing, type PingResult } from '../engine/ping';
import { routeKey } from '../engine/rib';
import { hasLoop } from '../engine/compare';
import type { Frame, SimState } from '../engine/types';

export interface ScenarioCtx {
  frames: Frame[];
  cursor: number;
  state: SimState;
  topo: Topology;
  selected: string | null;
}

export interface QuickAction {
  label: string;
  link: [string, string];
  up?: boolean;
  cost?: number;
}

export interface Scenario {
  id: string;
  num: number;
  title: string;
  mode: Mode | 'compare';
  level: Level;
  topology: () => Topology;
  dv?: Partial<DvOptions>;
  objective: string;
  prediction: { question: string; choices: string[] };
  actions: string[];
  quickActions?: QuickAction[];
  ping?: [string, string];
  select?: string;
  explain: (ctx: ScenarioCtx) => string;
}

const ping = (s: SimState, a = 'pc1', b = 'pc2'): PingResult => simulatePing(s.topo, s.tables, a, b, s.options.ttl);

function describePing(s: SimState, a = 'pc1', b = 'pc2'): string {
  const p = ping(s, a, b);
  const n = (id: string) => deviceName(s.topo, id);
  if (p.success) return `Right now a ping ${n(a)} → ${n(b)} SUCCEEDS. Request: ${p.requestPath.map(n).join(' → ')}. Reply: ${p.replyPath.map(n).join(' → ')}.`;
  return `Right now a ping ${n(a)} → ${n(b)} FAILS during the echo ${p.failure!.phase} at ${n(p.failure!.at)}: ${p.failure!.message}`;
}

function routeText(s: SimState, router: string, key: string): string {
  const r = s.tables[router]?.find((x) => routeKey(x) === key);
  const n = deviceName(s.topo, router);
  if (!r) return `${n} has no route to ${key}.`;
  if (r.unreachable) return `${n} marks ${key} as unreachable.`;
  if (r.source === 'connected') return `${n} is directly connected to ${key}.`;
  return `${n} reaches ${key} via ${r.learnedFrom ? deviceName(s.topo, r.learnedFrom) : r.nextHop} (next hop ${r.resolvedVia ?? r.nextHop}), ${r.source === 'static' ? `static, AD ${r.ad}` : `cost ${r.metric}`}.`;
}

function lastChangeIndex(frames: Frame[], cursor: number): number {
  for (let i = cursor; i >= 0; i--) if (frames[i].ev.kind === 'config-change') return i;
  return -1;
}

const NET3 = '192.168.3.0/24';

function fiveRouterLpm(): Topology {
  let t = fiveRouter();
  t = addStatic(t, 'R1', staticRoute('0.0.0.0', 0, '10.0.12.2'), staticRoute('192.168.3.0', 24, '10.0.14.4'));
  t = addStatic(t, 'R2', staticRoute('192.168.3.0', 24, '10.0.23.3'), staticRoute('192.168.1.0', 24, '10.0.12.1'));
  t = addStatic(t, 'R4', staticRoute('192.168.3.0', 24, '10.0.45.5'), staticRoute('192.168.1.0', 24, '10.0.14.1'));
  t = addStatic(t, 'R5', staticRoute('192.168.3.0', 24, '10.0.35.3'), staticRoute('192.168.1.0', 24, '10.0.45.4'));
  t = addStatic(t, 'R3', staticRoute('0.0.0.0', 0, '10.0.35.5'));
  return t;
}

function fiveRouterBackup(): Topology {
  let t = fiveRouter();
  t = addStatic(t, 'R1', staticRoute('192.168.3.0', 24, '10.0.12.2', 1), staticRoute('192.168.3.0', 24, '10.0.14.4', 5));
  t = addStatic(t, 'R2', staticRoute('192.168.3.0', 24, '10.0.23.3'), staticRoute('192.168.1.0', 24, '10.0.12.1'));
  t = addStatic(t, 'R4', staticRoute('192.168.3.0', 24, '10.0.45.5'), staticRoute('192.168.1.0', 24, '10.0.14.1'));
  t = addStatic(t, 'R5', staticRoute('192.168.3.0', 24, '10.0.35.3'), staticRoute('192.168.1.0', 24, '10.0.45.4'));
  t = addStatic(t, 'R3', staticRoute('192.168.1.0', 24, '10.0.35.5'));
  return t;
}

function missingReturn(): Topology {
  let t = threeRouter();
  t = addStatic(t, 'R1', staticRoute('192.168.3.0', 24, '10.0.12.2'));
  t = addStatic(t, 'R2', staticRoute('192.168.3.0', 24, '10.0.23.3'));
  return t;
}

function countToInfinityText(ctx: ScenarioCtx): string {
  const i = lastChangeIndex(ctx.frames, ctx.cursor);
  if (i < 0) return `Step to the end so the routers converge, then press "Fail link R2–R3" and step through the events. ${routeText(ctx.state, 'r1', NET3)}`;
  const after = ctx.frames.slice(i, ctx.cursor + 1);
  let maxM = 0;
  for (const f of after) for (const r of ['r1', 'r2']) {
    const x = f.state.tables[r]?.find((y) => routeKey(y) === NET3 && !y.unreachable);
    if (x) maxM = Math.max(maxM, x.metric);
  }
  const loops = after.filter((f) => hasLoop(f, NET3)).length;
  const o = ctx.state.options.dv;
  const inf = ctx.state.dv?.infinity ?? 16;
  const settings = `Settings: split horizon ${o.splitHorizon ? 'ON' : 'OFF'}, poison reverse ${o.poisonReverse ? 'ON' : 'OFF'}, triggered updates ${o.triggeredUpdates ? 'ON' : 'OFF'}.`;
  const result = loops
    ? `Since the failure, R1 and R2 pointed at EACH OTHER for ${NET3} in ${loops} event${loops > 1 ? 's' : ''} — a routing loop. They kept believing each other's stale information, and the cost climbed to ${maxM} on its way to ${inf} (infinity). A ping sent during this time loops until its TTL expires.`
    : `Since the failure, no routing loop has formed for ${NET3} so far (highest metric seen: ${maxM || 'none'}).`;
  return `${settings} ${result} ${routeText(ctx.state, 'r1', NET3)} ${routeText(ctx.state, 'r2', NET3)}`;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'connected-only', num: 1, title: 'Connected networks only', mode: 'static', level: 'beginner', topology: threeRouter, ping: ['pc1', 'pc2'], select: 'r1',
    objective: 'Understand that a router only knows its directly connected networks until it is told about others.',
    prediction: { question: 'PC1 pings PC2. What happens?', choices: ['It succeeds', 'It fails at PC1', 'It fails at R1', 'It fails at R3'] },
    actions: ['Select R1 and read its routing table (C = connected).', 'Press "Run ping" PC1 → PC2 and step through it.', 'Find the exact router and reason for the drop.'],
    explain: (c) => `${routeText(c.state, 'r1', NET3)} ${describePing(c.state)} A router can only forward to networks in its routing table. Without static routes, R1 knows only 192.168.1.0/24 and 10.0.12.0/24.`,
  },
  {
    id: 'add-static', num: 2, title: 'Add a static route and observe forwarding', mode: 'static', level: 'beginner', topology: threeRouter, ping: ['pc1', 'pc2'], select: 'r1',
    objective: 'Add static routes so packets can travel one more hop at a time, and see why every router on the path needs a route.',
    prediction: { question: 'If you add ONLY "192.168.3.0/24 via 10.0.12.2" on R1, how far does the echo request get?', choices: ['To PC2', 'To R2 and is dropped there', 'Dropped at R1'] },
    actions: ['Select R1 → Static routes → add 192.168.3.0 /24 next hop 10.0.12.2.', 'Ping PC1 → PC2. Where is it dropped now?', 'Add a route on R2 to 192.168.3.0/24 via 10.0.23.3 and ping again.', 'Keep going until the reply also returns.'],
    explain: (c) => `${routeText(c.state, 'r1', NET3)} ${routeText(c.state, 'r2', NET3)} ${routeText(c.state, 'r3', '192.168.1.0/24')} ${describePing(c.state)}`,
  },
  {
    id: 'missing-return', num: 3, title: 'Missing return route', mode: 'static', level: 'beginner', topology: missingReturn, ping: ['pc1', 'pc2'], select: 'r3',
    objective: 'See that a ping needs routes in BOTH directions: the reply is a new packet travelling back.',
    prediction: { question: 'R1 and R2 have routes towards PC2. Does the ping succeed?', choices: ['Yes', 'No — the request is dropped', 'No — the request arrives but the reply is dropped'] },
    actions: ['Run the ping and step until the request reaches PC2.', 'Watch the echo reply: where is it dropped?', 'Add the missing return routes on R3 (and R2), then ping again.'],
    explain: (c) => `${describePing(c.state)} ${routeText(c.state, 'r3', '192.168.1.0/24')} ${routeText(c.state, 'r2', '192.168.1.0/24')}`,
  },
  {
    id: 'default-vs-specific', num: 4, title: 'Default route vs a more-specific route', mode: 'static', level: 'beginner', topology: fiveRouterLpm, ping: ['pc1', 'pc2'], select: 'r1',
    objective: 'Use longest-prefix matching: the most specific matching route wins, even if a default route also matches.',
    prediction: { question: 'R1 has 0.0.0.0/0 via R2 and 192.168.3.0/24 via R4. Which way does a packet to 192.168.3.10 go?', choices: ['Via R2 (default route)', 'Via R4 (/24 route)', 'Both, alternately'] },
    actions: ['Ping PC1 → PC2 and look at R1\'s "matching routes" list.', 'Disable the /24 route on R1 and ping again.', 'Explain why the default route is used now.'],
    explain: (c) => {
      const p = ping(c.state);
      const r1 = p.steps.find((x) => x.at === 'r1' && x.phase === 'request');
      const used = r1?.chosen ? `${routeKey(r1.chosen)} → next hop ${r1.nextHopIp}` : 'no route';
      return `At R1 the candidates for 192.168.3.10 are: ${r1?.candidates?.map(routeKey).join(', ') || 'none'}. Longest-prefix match picks ${used}. ${describePing(c.state)}`;
    },
  },
  {
    id: 'backup-static', num: 5, title: 'Failed link with a backup static route', mode: 'static', level: 'advanced', topology: fiveRouterBackup, ping: ['pc1', 'pc2'], select: 'r1',
    quickActions: [{ label: 'Fail link R1–R2', link: ['r1', 'r2'], up: false }, { label: 'Restore R1–R2', link: ['r1', 'r2'], up: true }, { label: 'Fail link R2–R3', link: ['r2', 'r3'], up: false }],
    objective: 'A floating static route (higher administrative distance) is only installed when the main route disappears.',
    prediction: { question: 'The R1–R2 link fails. Will PC1 still reach PC2?', choices: ['Yes, via the backup route through R4', 'No, static routes cannot adapt'] },
    actions: ['Look at R1\'s static routes: one is "Backup only" (AD 5).', 'Press "Fail link R1–R2", then ping again.', 'Now restore it and fail R2–R3 instead. Does R1 notice? Why not?'],
    explain: (c) => `${routeText(c.state, 'r1', NET3)} ${describePing(c.state)} R1 only installs the backup when the main route's next hop becomes unreachable from R1 itself. A failure further away (such as R2–R3) is invisible to R1, so static routing cannot work around it.`,
  },
  {
    id: 'dv-learn', num: 6, title: 'Distance vector: learning a remote network', mode: 'dv', level: 'beginner', topology: threeRouter, select: 'r1', dv: { profile: 'rip', splitHorizon: true, poisonReverse: false, triggeredUpdates: true },
    objective: 'See a router learn about a network two hops away from its neighbour, without ever seeing the whole network.',
    prediction: { question: 'How will R1 learn about 192.168.3.0/24?', choices: ['R3 tells R1 directly', 'R2 tells R1, after hearing it from R3', 'R1 discovers it by itself'] },
    actions: ['Step through events and watch the orange DV update packets.', 'At each update, read the calculation: link cost + advertised cost.', 'Find the event where R1 adds 192.168.3.0/24. Who told it?'],
    explain: (c) => {
      const idx = c.frames.findIndex((f) => f.ev.changes?.some((x) => x.router === 'r1' && x.key === NET3));
      const when = idx >= 0 ? (idx <= c.cursor ? `It happened at event ${idx + 1} (${c.frames[idx].ev.title}).` : `It has not happened yet at this point in the timeline (keep stepping).`) : 'In this run R1 never learns it — check the configuration.';
      return `${routeText(c.state, 'r1', NET3)} ${when} R1 never talks to R3: it only trusts what its neighbour R2 advertises.`;
    },
  },
  {
    id: 'dv-better', num: 7, title: 'Distance vector: selecting a better path', mode: 'dv', level: 'beginner', topology: triangle, select: 'r1', dv: { profile: 'generic', splitHorizon: true, poisonReverse: false, triggeredUpdates: true },
    objective: 'See a router replace a route when a neighbour offers a lower total cost.',
    prediction: { question: 'R1–R3 direct costs 5; R1–R2–R3 costs 1+1. Which next hop will R1 finally use for 192.168.3.0/24?', choices: ['R3 (direct link)', 'R2', 'Both'] },
    actions: ['Step until R1 first learns 192.168.3.0/24. Which neighbour told it first?', 'Keep stepping: find the event marked "better".', 'Change the R1–R3 cost to 1 (select the link) and observe.'],
    explain: (c) => {
      const sw = c.frames.slice(0, c.cursor + 1).filter((f) => f.ev.dv?.to === 'r1' && f.ev.dv.rows.some((x) => x.key === NET3 && (x.decision === 'better' || x.decision === 'new')));
      const hist = sw.map((f) => f.ev.dv!.rows.find((x) => x.key === NET3)!).map((x) => x.text).join(' ');
      return `${routeText(c.state, 'r1', NET3)} ${hist ? `History so far: ${hist}` : 'R1 has not learned this network yet at this point.'}`;
    },
  },
  {
    id: 'dv-count', num: 8, title: 'Distance vector loop and count to infinity', mode: 'dv', level: 'advanced', topology: threeRouter, select: 'r2',
    dv: { profile: 'rip', splitHorizon: false, poisonReverse: false, triggeredUpdates: false },
    quickActions: [{ label: 'Fail link R2–R3', link: ['r2', 'r3'], up: false }],
    objective: 'See how stale information creates a routing loop and why metrics count up to infinity (16 in RIP).',
    prediction: { question: 'With all loop prevention OFF, R2–R3 fails. What will R2 believe about 192.168.3.0/24 next?', choices: ['Unreachable, immediately', 'Reachable via R1 (R1 still advertises it)', 'Reachable via R3'] },
    actions: ['Jump to the end (converged).', 'Press "Fail link R2–R3".', 'Step through the updates and watch R1 and R2\'s metrics for 192.168.3.0/24 climb.', 'While they count, run a ping: see TTL expire in a loop.'],
    explain: countToInfinityText,
  },
  {
    id: 'dv-split', num: 9, title: 'Split horizon and poison reverse comparison', mode: 'dv', level: 'advanced', topology: threeRouter, select: 'r2',
    dv: { profile: 'rip', splitHorizon: true, poisonReverse: false, triggeredUpdates: false },
    quickActions: [{ label: 'Fail link R2–R3', link: ['r2', 'r3'], up: false }],
    objective: 'Compare the same failure with different loop-prevention settings.',
    prediction: { question: 'With split horizon ON, will R1 and R2 count to infinity after R2–R3 fails?', choices: ['Yes', 'No'] },
    actions: ['Open "Loop prevention comparison" in the protocol options.', 'Fail R2–R3 and step through; note which routes R1 omits (split horizon).', 'Toggle poison reverse ON, restart, repeat. What does R1 advertise now?'],
    explain: countToInfinityText,
  },
  {
    id: 'ls-flood', num: 10, title: 'Link-state flooding', mode: 'ls', level: 'beginner', topology: fiveRouter, select: 'r3',
    objective: 'See every router\'s LSA reach every other router, and why duplicates are discarded.',
    prediction: { question: 'How many LSAs will R3\'s database hold when flooding finishes?', choices: ['1 (its own)', '3 (neighbours only)', '5 (one per router)'] },
    actions: ['Step through Hello, Describe and Originate events.', 'Watch the purple LSA packets flood.', 'Find a "discards a duplicate" event and explain why flooding stops.'],
    explain: (c) => {
      const r = c.state.ls?.routers[c.selected ?? 'r3'] ?? c.state.ls?.routers.r3;
      const db = r ? Object.values(r.lsdb).map((l) => `${deviceName(c.state.topo, l.origin)}#${l.seq}`).join(', ') : '';
      const upTo = c.frames.slice(0, c.cursor + 1);
      return `So far: ${upTo.filter((f) => f.ev.kind === 'ls-flood').length} LSAs stored after flooding, ${upTo.filter((f) => f.ev.kind === 'ls-dup').length} duplicate copies discarded. ${deviceName(c.state.topo, c.selected ?? 'r3')}'s database: ${db || 'empty'}. A copy is only flooded further if it is NEW to the receiver.`;
    },
  },
  {
    id: 'ls-dijkstra', num: 11, title: 'Dijkstra calculation step by step', mode: 'ls', level: 'advanced', topology: fiveRouter, select: 'r1',
    objective: 'Follow Dijkstra\'s algorithm: confirm the cheapest tentative node, relax its links, repeat; then derive next hops.',
    prediction: { question: 'Which next hop will R1 use to reach R3?', choices: ['R2 (2 + 5 = 7)', 'R4 (1 + 1 + 1 = 3)', 'R2 via R5 (2 + 3 + 1 = 6)'] },
    actions: ['Step to the "R1 runs SPF" events (select R1, open the SPF tab).', 'For each step, predict which node is confirmed next.', 'Watch the tentative cost of R3 improve.', 'Check the next-hop column after the final step.'],
    explain: (c) => {
      const spf = c.state.ls?.routers.r1?.spf;
      if (!spf) return 'R1 has not run SPF yet at this point in the timeline. Keep stepping.';
      const view = c.state.spfView;
      if (view?.router === 'r1' && view.step < spf.steps.length)
        return `R1 is in the middle of its SPF calculation (step ${view.step} of ${spf.steps.length}). Confirmed so far: ${spf.steps.slice(0, view.step).map((s) => `${deviceName(c.state.topo, s.selected)}(${s.selectedDist})`).join(' → ') || 'nothing yet'}. Predict which router is confirmed next, then step.`;
      const f = spf.firstHop.r3;
      return `R1's shortest path to R3 costs ${spf.dist.r3 ?? '∞'}, first hop ${f ? deviceName(c.state.topo, f.router) : 'none'}. Confirmation order: ${spf.steps.map((s) => `${deviceName(c.state.topo, s.selected)}(${s.selectedDist})`).join(' → ')}. ${routeText(c.state, 'r1', NET3)}`;
    },
  },
  {
    id: 'ls-failure', num: 12, title: 'Link-state reaction to a link failure', mode: 'ls', level: 'advanced', topology: fiveRouter, select: 'r1',
    quickActions: [{ label: 'Fail link R4–R5', link: ['r4', 'r5'], up: false }, { label: 'Restore R4–R5', link: ['r4', 'r5'], up: true }, { label: 'Set R1–R4 cost 10', link: ['r1', 'r4'], cost: 10 }],
    objective: 'See the new advertisements, flooding, database changes, recalculation and route installation after a failure.',
    prediction: { question: 'R4–R5 fails. What will R1\'s new path cost to 192.168.3.0/24 be?', choices: ['3', '6', '7', 'Unreachable'] },
    actions: ['Jump to the end (converged).', 'Press "Fail link R4–R5".', 'Watch R4 and R5 originate LSA #2, the flooding, then each router\'s SPF.'],
    explain: (c) => {
      const i = lastChangeIndex(c.frames, c.cursor);
      const after = i >= 0 ? c.frames.slice(i, c.cursor + 1) : [];
      return `${i < 0 ? 'No change made yet. ' : `Since the change: ${after.filter((f) => f.ev.kind === 'ls-originate').length} new LSAs originated, ${after.filter((f) => f.ev.kind === 'ls-flood').length} accepted during flooding, ${after.filter((f) => f.ev.kind === 'spf-start').length} SPF runs. `}${routeText(c.state, 'r1', NET3)}`;
    },
  },
  {
    id: 'compare', num: 13, title: 'Compare all three on the same topology', mode: 'compare', level: 'advanced', topology: fiveRouterBackup,
    objective: 'Compare what routers know, what they exchange, what they calculate, and how they react to the same failure.',
    prediction: { question: 'After the R4–R5 link fails, which approaches still deliver PC1 → PC2 without manual changes?', choices: ['Only static', 'Only link state', 'Distance vector and link state', 'All three'] },
    actions: ['Choose a link to fail in the comparison panel.', 'Compare events, messages and table changes.', 'Read the "manual intervention" row.'],
    explain: () => 'The comparison table is computed by actually running all three simulations on this topology. Event counts depend on the topology, timers and settings of this model — they are not universal speeds.',
  },
];

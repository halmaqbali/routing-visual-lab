# Routing Visual Lab

An interactive simulator for teaching **static routing**, **distance-vector routing** and **link-state routing** to Year 2 networking students.

Students follow a single learning loop: **Predict → Change something → Step through events → Observe the tables → Explain the result.**

Everything runs in the browser. No real packets are sent and no real routers are needed.

## Setup

Requires Node.js 18 or newer.

```bash
npm install
```

```bash
npm run dev
```

Open the address Vite prints (usually http://localhost:5173).

Other commands:

| Command | What it does |
| --- | --- |
| `npm test` | Runs the automated engine tests (Vitest) |
| `npm run typecheck` | TypeScript type check |
| `npm run build` | Type check + production build into `dist/` |
| `npm run preview` | Serves the production build |

The production build is a static site (relative paths), so `dist/` can be copied to any web server or opened from a learning platform.

## Features

- **Editable network canvas** (SVG): add and remove routers, PCs and links; drag devices; rename; edit IPv4 addresses, prefixes, PC gateways and link costs; enable or disable links. New links get sensible addresses automatically (`10.0.ij.0/24` between Ri and Rj, `192.168.k.0/24` for a PC on Rk).
- **Validation** of invalid addresses, network/broadcast addresses, duplicate addresses, mismatched link subnets, duplicate subnets, wrong gateways, static routes with host bits set, and invalid next hops.
- **Ping tracing**: 1, 3 (default) or continuous pings until Stop, with a statistics summary like the `ping` command. Each ping shows the ICMP echo request and the echo reply, hop by hop. Each hop shows the destination IP, the matching routes, the longest-prefix match and why it won, the next hop, the outgoing interface, the TTL change and the next action. Failures name the exact point and reason: missing gateway, no route, missing return route, unreachable next hop, link down, host unreachable, or TTL expiry in a loop.
- **Static mode**: add, edit, enable, disable and delete static routes, including default and floating (backup) routes. Next hops are resolved recursively. Each route is explained in plain English, and matching **Huawei VRP** and **Cisco IOS** commands are generated from the same model.
- **Distance-vector mode**: event-driven updates showing the sender, the receiver, the advertised vector, the calculation (`candidate = link cost + advertised cost`) and the decision for every row. Two clearly separated profiles: generic weighted costs, and RIP hop count (1 per link, 16 = unreachable). Split horizon, poison reverse and triggered updates each have their own switch. A built-in loop-prevention comparison runs every combination.
- **Link-state mode**: Hello → describe links → originate LSA → flooding (with duplicate discard) → LSDB → Dijkstra step by step → route installation. For each router you can inspect its neighbours, its LSDB, its topology view and its shortest-path tree. The tree is also drawn on the canvas.
- **Comparison mode**: runs all three approaches on the same topology, fails a link, and compares events, messages, table changes, ping results and whether a person has to fix anything.
- **13 guided scenarios**, each with an objective, a prediction question, suggested actions, quick actions, a reset button, and an explanation computed from the *current* simulation result.
- **Teacher Mode**: hide explanations until a prediction is made, reveal one event at a time, hide next hops and costs for quiz questions, reset the scenario instantly, and enlarge text for a projector.
- **Timeline** with real state restoration. Previous Event shows the exact earlier state, because every event stores a full snapshot.
- Save and load as JSON, browser autosave, keyboard shortcuts (← → Space Home End Esc), reduced-motion support, dark mode, and layouts for projectors, laptops and tablets.

## Architecture

```
src/
  model/            configuration only (what the student sets up)
    ip.ts           IPv4 parsing, masks, subnet matching
    types.ts        Topology, Device, Link, StaticRoute, options
    topology.ts     queries + pure editing helpers + auto-addressing
    validate.ts     configuration validation with plain-English messages
    samples.ts      3-router, 5-router and triangle topologies
  engine/           learned state and algorithms (no React)
    rib.ts          routing table type, longest-prefix match, table diffs
    static.ts       connected + static routes, recursive next-hop resolution, AD
    dv.ts           distance-vector engine (generic + RIP profile)
    ls.ts           link-state engine, flooding, Dijkstra with recorded steps
    core.ts         deterministic event queue (time, then sequence number)
    simulation.ts   timeline of frames; edits truncate and branch the timeline
    ping.ts         hop-by-hop ICMP request/reply forwarding
    compare.ts      three-way comparison and loop-prevention comparison
    cli.ts          Huawei VRP / Cisco IOS command generation
  scenarios/        guided classroom scenarios
  ui/               React + SVG presentation and animation
tests/              Vitest tests for the engine
```

**Determinism.** Every pending event has a time and a sequence number. Events are processed in that order, so a scenario always produces the same timeline.

**Timeline and state.** A simulation is an array of frames. Each frame holds an event and the full state *after* that event. Previous Event displays an earlier frame, so it restores the real earlier state.

**Changes during a run.** If you disable a link, re-enable it or change a cost, the timeline is cut at the current event. A new event sequence then continues from the current routing state, so the protocol has to react, and stale future events are never replayed. Structural edits (adding devices, changing addresses) restart the simulation from time 0, and a banner says so.

**Data plane and control plane are separate.** A ping inserts data-packet frames that never change routing state. They use a different icon, colour and shape from routing updates and LSAs.

## Tests

`npm test` covers:

- IPv4 validation, masks and subnet matching
- configuration validation and auto-addressing
- longest-prefix matching, default vs specific routes
- recursive next-hop resolution and unresolvable next hops
- request **and** reply paths, missing return route, missing gateway
- floating static route after a link failure
- loop detection by TTL expiry (static loop and count-to-infinity)
- distance-vector learning, better-path selection, the candidate calculation, RIP hop counts, unreachable propagation, count to infinity, split horizon, link recovery, determinism
- Dijkstra distances, predecessor improvements, next-hop derivation, per-router roots, the two-way check
- link-state flooding, stage order, failure, recovery and cost change
- Previous Event state restoration, timeline truncation, pings that do not change state
- every scenario loads a valid configuration, and its explanation follows the actual result

## Model assumptions

The in-app **Model assumptions** panel lists every simplification. The main ones:

- PCs connect directly to routers (no switches). ARP is simplified.
- Each message takes 1 time unit. DV updates run every 30 units. SPF runs 5 units after the last database change.
- Equal-cost multipath is not modelled.
- RIP route timeout, garbage-collection and hold-down timers are not modelled.
- The link-state mode is an OSPF-*inspired* teaching model, not OSPF (no areas, DR/BDR, LSA types, ageing or acknowledgements).
- Each mode uses only its own routes (no redistribution between static and dynamic routes).

See [TEACHER_GUIDE.md](TEACHER_GUIDE.md) for classroom use.

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

**Interface**
- **Header:** the lab menu (save, open, new, import, export), the routing method switcher, **Ping**, **Share**, and a ⋯ menu for the theme, Teacher mode, projector text, reduced motion and the model assumptions.
- **Tool rail on the left:** Select, Router, PC, Switch, Cable, Note, Undo/Redo and Delete.
- **Step card under the network:** what happened in the current step, in plain English, with Play / Previous / Next, a progress slider, speed, Details (the calculation tables) and **All steps** (the event timeline drawer).
- **Inspector on the right**, with four tabs: **Device** (routing table, interfaces, static routes, ARP/MAC tables, CLI), **Packet** (Packet Inspector), **Lesson** (guided lessons, exercises, Teacher mode) and **Settings** (level, protocol options, display, legend). It can be resized (drag or double-click the divider) and hidden.
- **On phones:** the network on top, the content below, and a bottom tab bar (Step, Device, Packet, Lesson, Steps, More).

**Labs: save, share, exercises**
- **New / Open / Save / Export / Import Lab.** A lab file holds the whole network: device positions, names, interfaces (IPs, prefixes, loopbacks), link costs and states, static routes, PC gateways, routing-protocol settings, canvas notes, the mode and level, and the timeline position with a routing-table snapshot.
- **Saved labs library** in the browser: open, rename, duplicate, delete and export. The current work is autosaved, so a refresh loses nothing.
- **Share Lab**: download a lab file, or create a **share link** that contains the whole compressed lab after the `#`, plus a **QR code** for it. No server is involved, and the link works on any computer.
- **Student Exercise Mode**: share an exercise (optionally with all static routes removed) with instructions. Students get **Reset Lab** (restores the exact starting configuration, which is stored inside the lab and never edited) and **Check connectivity**.
- Files from the earlier version-1 format are **migrated automatically**; broken or foreign files are rejected with clear messages.

**Packets and Layer 2**
- **Unmanaged switch**: MAC learning, a dynamic MAC table with aging and relearning, forwarding of known unicast, and flooding of broadcast and unknown unicast. No IP configuration and no routing.
- **ARP**: requests are broadcast and replies are unicast; ARP caches live on routers and PCs. The first ping shows ARP; later pings reuse the cache.
- **Packet Inspector**: click a packet on the canvas (or a row in the packet log). It shows source/destination IP and MAC, devices, protocol, time and step, interfaces in and out, TTL, size, current and next hop, protocol layers and fields (ICMP, ARP, RIPv2, OSPF Hello/LSU), the routing lookup with longest-prefix match, the TTL trail and the switch MAC table. It also explains why the destination MAC changes at each router while the IP stays the same. Simulated fields are labelled.
- **Ping from any PC or router to any address**, including loopbacks, with an optional source address. Outcomes: reply received, destination unreachable, TTL expired in transit, or request timed out. A ping succeeds only if the request and the reply both arrive.

**Canvas**
- Device palette (Router, PC, Switch, Link, Note), **zoom and pan**, fit-to-screen, grid and snap-to-grid, **undo/redo**.
- **Canvas notes**: titles, `**bold**`, bullets, four neutral shades, lock, an optional arrow to a device, drag, resize, duplicate and delete. Notes are saved and shared with the lab.
- A **monochrome design** with light, dark and automatic themes. Red, amber and green are kept only for error, warning and success states, always alongside icons or text.

**Routing (as before)**

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
- **Resizable workspace**: drag the dividers between the topology, the controls, the event timeline and the learning-activity panel. You can also use the arrow keys on a focused divider; double-click a divider (or press Enter) to reset it. Every panel can be maximized and restored, and **moved**: drag its ✥ handle onto another panel to swap places (or focus the handle and use the arrow keys). The timeline and learning panels collapse to their header. **Reset layout** restores the default sizes and arrangement, and **⛶ Present** shows the topology full screen with a compact control bar. Panel sizes are saved in the browser, separately from saved topologies. Resizing never restarts the simulation or moves routers: the drawing keeps its coordinate system and aspect ratio.
- Save and load as JSON, browser autosave, keyboard shortcuts (← → Space Home End Esc), reduced-motion support, dark mode, and layouts for projectors, laptops and tablets.

## Architecture

```
src/
  lab/              lab file format (v2 + migration), saved-labs library, share links, theme preference
  model/            configuration only (what the student sets up)
    ip.ts           IPv4 parsing, masks, subnet matching
    types.ts        Topology, Device, Link, StaticRoute, options
    topology.ts     queries, Layer 2 segments, neighbours via switches, MACs, editing + auto-addressing
    validate.ts     configuration validation with plain-English messages
    samples.ts      3-router, 5-router and triangle topologies
  engine/           learned state and algorithms (no React)
    rib.ts          routing table type, longest-prefix match, table diffs
    static.ts       connected + static routes, recursive next-hop resolution, AD
    dv.ts           distance-vector engine (generic + RIP profile)
    ls.ts           link-state engine, flooding, Dijkstra with recorded steps
    core.ts         deterministic event queue (time, then sequence number)
    simulation.ts   timeline of frames; edits truncate and branch the timeline
    ping.ts         ICMP request/reply between any devices: ARP, switching, LPM, TTL, outcomes
    l2.ts           ARP caches and switch MAC tables (learning, aging, flushing)
    packets.ts      Packet Inspector views: ICMP, ARP, RIPv2, teaching DV, OSPF Hello/LSU
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

`npm test` runs 88 tests. They cover:

- **Lab persistence**: save and reopen a configured topology, export and import JSON, version-1 migration, rejection of broken files, the library (rename, duplicate, delete), autosave across reloads, a share link opened by a separate user with empty storage, exercise mode and Reset Lab, notes surviving save/load/share, and theme switching without touching lab data
- **Switching and ARP**: switch MAC learning, flooding of broadcast and unknown unicast, forwarding of known unicast, aging and relearning, ARP resolution across a switch (and no ARP on the next ping), loop/IP/subnet validation on switched segments
- **Router ping**: router-to-router ping, loopback-to-loopback ping with a chosen source, failure when the return route is missing, destination unreachable, TTL expired in a loop, pinging its own address
- **Packet Inspector accuracy**: MACs changing per hop while IPs stay the same, TTL per hop, ICMP/ARP fields and sizes, RIPv2 and OSPF messages
- **Routing through switches**: DV and LS neighbours through a switch, and the RIP-style route timeout when a neighbour disappears behind a switch

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

## Back end and sharing

The app is a static site, with no server or database. Everything that needs to work across computers uses files or self-contained links:

- **Lab files** (`.rvlab.json`) can be emailed or uploaded to a learning platform.
- **Share links** carry the compressed lab in the URL fragment (`#lab=…`). The fragment is never sent to a web server, so nothing is uploaded. Links for typical classroom labs are 1–3 KB and fit in a QR code; very large labs need the file.
- Saved labs and autosave use the browser's `localStorage`, which is per browser and per computer.

Short links such as `…/l/abc123`, server-side storage, accounts, or seeing students' work would need a backend (for example a small API with a database). That is not implemented.

## Migrations

Lab files carry `"format": "routing-visual-lab"` and `"version"`. Version-1 files (topology, mode, options and level, as saved by earlier versions) and the old autosave are converted automatically: notes start empty, and switches and loopbacks are simply absent. Files from a newer version are refused with a message rather than misread.

## Model assumptions

The in-app **Model assumptions** panel lists every simplification. The main ones:

- PCs connect to routers or to unmanaged switches (no STP, no VLANs). ARP caches do not expire.
- Each message takes 1 time unit. DV updates run every 30 units. SPF runs 5 units after the last database change.
- Equal-cost multipath is not modelled.
- The RIP route timeout (180) is modelled; garbage-collection and hold-down timers are not.
- The link-state mode is an OSPF-*inspired* teaching model, not OSPF (no areas, DR/BDR, LSA types, ageing or acknowledgements).
- Each mode uses only its own routes (no redistribution between static and dynamic routes).

See [TEACHER_GUIDE.md](TEACHER_GUIDE.md) for classroom use.

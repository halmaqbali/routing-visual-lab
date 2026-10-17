# Teacher Guide — Routing Visual Lab

## The big question

By the end, students should be able to answer, for any router:

> **What does this router know, where did it learn that information, why did it choose this next hop, and what changes when the network changes?**

Each part maps to something on screen:

| Question | Where to look |
| --- | --- |
| What does it know? | Inspector → **Routing table** |
| Where did it learn it? | **Src** column (C / S / R / D / L) and **Learned from**; the **History** tab |
| Why this next hop? | Click a row for the plain-English sentence; DV calculation table; SPF tab |
| What changes? | Yellow **NEW / CHANGED** rows, the event timeline, the Explanation panel |

## Before class

1. Run `npm install`, then `npm run dev` (or put the built `dist/` folder on a web server).
2. Open the app on the projector and turn on **Projector** (bigger text).
3. Turn on **Teacher** and choose your options:
   - **Hide explanations until a prediction is made**: students commit to an answer first.
   - **Reveal one event at a time**: turns off Play and End, and hides future events in the timeline.
   - **Hide next hops & costs**: shows a "?" that you click to reveal. Good for "what will R2's cost be?" questions.

## Suggested lesson sequence

| Lesson | Scenarios | Key idea |
| --- | --- | --- |
| 1. Why routing is needed | 1, 2 | Routers only know connected networks; every router on the path needs a route |
| 2. Two-way thinking | 3, 4 | A ping needs a return path; longest-prefix match beats the default route |
| 3. Static resilience | 5 | Floating static routes; routers only see their own interface failures |
| 4. Distance vector | 6, 7 | Routers learn from neighbours: link cost + advertised cost |
| 5. Loops | 8, 9 | Stale information, count to infinity, split horizon, poison reverse |
| 6. Link state | 10, 11, 12 | Flooding, LSDB, Dijkstra from each router's own point of view |
| 7. Synthesis | 13 | Compare all three on the same failure |

## Running a scenario (Predict → Change → Step → Observe → Explain)

1. **Predict.** Read the prediction question aloud. Students vote (show of hands or a poll), then click the class's choice.
2. **Change.** Follow the suggested actions. Quick-action buttons (for example "Fail link R2–R3") do the change for you.
3. **Step.** Use **Next** (→ key) one event at a time. Ask "what will happen next?" before each step.
4. **Observe.** Point to the yellow changed rows and the Explanation panel. On a ping hop, point out that the destination IP never changes; only the next hop does.
5. **Explain.** Ask students to explain the result in their own words, then reveal **"What the simulation shows now"**. That text is computed from the current simulation, so if a student's configuration breaks something, it says so.

**Reset scenario** restores the starting configuration at any time.

## Discussion prompts

- *Scenario 1:* "R1 has the packet. What does R1 look for in its table? Why does it give up?"
- *Scenario 3:* "The request reached PC2. Why did the ping still fail?"
- *Scenario 4:* "Both routes match 192.168.3.10. Which is more specific, and why does that win?"
- *Scenario 5:* "After R2–R3 fails, R1 still sends packets to R2. Why doesn't R1 know about the failure?"
- *Scenario 7:* "R1 heard about 192.168.3.0 from R3 first. Why did it change its mind?"
- *Scenario 8:* "R2 lost its route. Why does it believe R1? What does R1 actually know?" Run a ping mid-count and watch the TTL expire.
- *Scenario 9:* Open **Show loop-prevention comparison**. "Which settings removed the loop? Which still took many events?"
- *Scenario 11:* Before each SPF step: "Which node has the lowest tentative cost? What will be confirmed next?"
- *Scenario 13:* "Which approach needed a person to fix it? Is link state always faster?" (No. Compare event counts and read the note about timing assumptions.)

## Arranging the screen for projection

- Drag the dividers to give the topology more room, or maximize a panel with its maximize button (top right of each panel). Click the restore button to return to the previous layout.
- **⛶ Present** (in the topology toolbar) shows only the network, full screen, with Play / Prev / Next and the current event title. Press **Esc** to leave.
- Collapse the timeline or the learning panel when you don't need it. **Reset layout** in the top bar restores the default arrangement.
- The layout is remembered on each computer, and is not stored in exported topology files.

## Building your own exercises

- Choose **New… → Empty canvas**, then use **+ Router**, **+ PC** and **Link** to build any network. Addresses are assigned automatically and can be edited in the Inspector.
- Use **Save** to download the exercise as JSON, and share it with students, who open it with **Load**.
- The app autosaves to the browser, so students can close the tab and continue later on the same computer.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| → / ← | Next / previous event |
| Space | Play / pause |
| Home / End | First / last event |
| Esc | Cancel the current tool, close dialogs |
| Tab, Enter | Move between devices on the canvas and select one |

## Honest limitations to mention to students

- The link-state mode is a **simplified, OSPF-inspired** model. Real OSPF has areas, DR/BDR, many LSA types, ageing and acknowledgements.
- RIP timers (timeout, garbage collection, hold-down) are not modelled, so count to infinity is not slowed down as it would be on real routers.
- Times are abstract simulation units. Event counts show how a protocol behaves in this model, not real convergence times.
- The generated Huawei/Cisco commands are a learning aid, not a complete device configuration.

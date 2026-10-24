import { useMemo, useState } from 'react';
import type { Level, Mode, SimOptions, Topology } from '../model/types';
import { deviceName, getDevice, pcs } from '../model/topology';
import { compareLoopPrevention, compareModes, destinationOf, MODE_FACTS } from '../engine/compare';
import type { Scenario, ScenarioCtx } from '../scenarios';

// ---------------------------------------------------------------- scenario card

export function ScenarioPanel({ sc, ctx, predicted, onPredict, onReset, onQuick, teacher }: {
  sc: Scenario; ctx: ScenarioCtx; predicted: string | null; onPredict: (c: string) => void; onReset: () => void; onQuick: (i: number) => void; teacher: boolean;
}) {
  const [open, setOpen] = useState(true);
  let explanation = '';
  try {
    explanation = sc.explain(ctx);
  } catch {
    explanation = 'The explanation cannot be computed for the current configuration.';
  }
  const revealed = !teacher || predicted !== null;
  return (
    <section className="card scenario" aria-label="Guided scenario">
      <div className="card-head">
        <h2>Scenario {sc.num}: {sc.title}</h2>
        <div className="row">
          <button className="btn small" onClick={onReset} title="Reload this scenario's starting configuration">↺ Reset scenario</button>
          <button className="btn small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Show'}</button>
        </div>
      </div>
      {open && (
        <>
          <p><strong>Objective:</strong> {sc.objective}</p>
          <div className="stack">
            <strong>Predict: {sc.prediction.question}</strong>
            <div className="choices" role="group" aria-label="Prediction choices">
              {sc.prediction.choices.map((c) => (
                <button key={c} className="btn" aria-pressed={predicted === c} onClick={() => onPredict(c)}>{c}</button>
              ))}
            </div>
            {predicted && <p className="small muted">Your prediction: <strong>{predicted}</strong>. Now test it — the explanation below is computed from what the simulation actually does.</p>}
          </div>
          <details open>
            <summary>Suggested actions</summary>
            <ol className="small">{sc.actions.map((a) => <li key={a}>{a}</li>)}</ol>
          </details>
          {sc.quickActions && (
            <div className="row" style={{ marginBottom: '0.5rem' }}>
              {sc.quickActions.map((q, i) => <button key={q.label} className="btn small" onClick={() => onQuick(i)}>{q.label}</button>)}
            </div>
          )}
          <div className={`banner ${revealed ? 'info' : ''}`}>
            <div>
              <strong>What the simulation shows now: </strong>
              {revealed ? explanation : 'Hidden until you make a prediction (Teacher Mode).'}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- settings

export function SettingsPanel({ mode, options, level, onOptions, topo }: { mode: Mode; options: SimOptions; level: Level; onOptions: (o: SimOptions) => void; topo: Topology }) {
  const dv = options.dv;
  const setDv = (patch: Partial<SimOptions['dv']>) => onOptions({ ...options, dv: { ...dv, ...patch } });
  const [loop, setLoop] = useState(false);
  return (
    <section className="card" aria-label="Protocol settings">
      <div className="card-head"><h2>Protocol settings</h2><span className="small muted">changes restart the simulation</span></div>
      {mode === 'static' && (
        <p className="small">
          Static routing: no protocol messages. Next hops may be adjacent or remote (recursive lookup). When two routes cover the same network, the lower administrative distance (AD) wins.
        </p>
      )}
      {mode === 'dv' && (
        <div className="stack">
          <div className="seg" role="group" aria-label="Distance vector profile">
            <button aria-pressed={dv.profile === 'generic'} onClick={() => setDv({ profile: 'generic' })}>Generic (weighted costs)</button>
            <button aria-pressed={dv.profile === 'rip'} onClick={() => setDv({ profile: 'rip' })}>RIP profile (hop count)</button>
          </div>
          <p className="small muted">
            {dv.profile === 'rip'
              ? 'RIP profile: every link = 1 hop; 15 is the largest usable metric; 16 = unreachable (infinity). Periodic updates every 30 s (simulated).'
              : `Generic: metric = sum of link costs. Infinity = ${dv.genericInfinity}. Connected networks have cost 0.`}
          </p>
          <label><input type="checkbox" checked={dv.splitHorizon} onChange={(e) => setDv({ splitHorizon: e.target.checked })} /> Split horizon <span className="muted small">— don't advertise a route back to the neighbour it was learned from</span></label>
          <label><input type="checkbox" checked={dv.poisonReverse} onChange={(e) => setDv({ poisonReverse: e.target.checked })} /> Poison reverse <span className="muted small">— advertise it back as unreachable (∞) instead</span></label>
          <label><input type="checkbox" checked={dv.triggeredUpdates} onChange={(e) => setDv({ triggeredUpdates: e.target.checked })} /> Triggered updates <span className="muted small">— send changes immediately</span></label>
          {dv.profile === 'generic' && level === 'advanced' && (
            <label>Infinity <input type="number" min={8} max={1000} value={dv.genericInfinity} onChange={(e) => setDv({ genericInfinity: Math.max(8, Number(e.target.value) || 100) })} style={{ width: '6rem' }} /></label>
          )}
          <button className="btn small" onClick={() => setLoop(!loop)} aria-expanded={loop}>{loop ? 'Hide' : 'Show'} loop-prevention comparison</button>
          {loop && <LoopCompare topo={topo} options={options} />}
        </div>
      )}
      {mode === 'ls' && (
        <p className="small">
          OSPF-style link state (OSPFv2, single area 0): Hellos with neighbour states up to Full, DR/BDR election on switched LANs, DBD/LSR/LSU database exchange, Router-LSAs and Network-LSAs, flooding over Full adjacencies, Dead interval 40, SPF 5 time units after the last database change. Not modelled: other areas, LSA ageing and retransmission (see Model assumptions).
        </p>
      )}
      {level === 'advanced' && (
        <label className="small" style={{ marginTop: '0.4rem' }}>
          Ping TTL <input type="number" min={2} max={255} value={options.ttl} onChange={(e) => onOptions({ ...options, ttl: Math.min(255, Math.max(2, Number(e.target.value) || 16)) })} style={{ width: '5rem' }} />
          <span className="muted">teaching default 16 (real hosts use 64 or 128)</span>
        </label>
      )}
    </section>
  );
}

function LoopCompare({ topo, options }: { topo: Topology; options: SimOptions }) {
  const routerLinks = topo.links.filter((l) => getDevice(topo, l.a.dev)?.kind === 'router' && getDevice(topo, l.b.dev)?.kind === 'router');
  const [link, setLink] = useState(routerLinks[routerLinks.length - 1]?.id ?? '');
  const pcList = pcs(topo);
  const [dst, setDst] = useState(pcList[pcList.length - 1]?.id ?? '');
  const dest = destinationOf(topo, dst);
  const rows = useMemo(() => (link && dest ? compareLoopPrevention(topo, options, link, dest) : []), [topo, options, link, dest]);
  const name = (id: string) => deviceName(topo, id);
  return (
    <div className="stack small">
      <div className="row">
        <label>Fail link <select value={link} onChange={(e) => setLink(e.target.value)}>{routerLinks.map((l) => <option key={l.id} value={l.id}>{name(l.a.dev)}–{name(l.b.dev)}</option>)}</select></label>
        <label>Watch network of <select value={dst} onChange={(e) => setDst(e.target.value)}>{pcList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      </div>
      <p className="muted">Each row runs the same topology to convergence, fails the link, and counts what happens next for {dest}.</p>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Setting</th><th>Events</th><th>DV updates</th><th>Highest metric</th><th>Events with a 2-router loop</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={r.loopFrames ? 'unreach' : ''}>
                <td>{r.label}</td><td>{r.events}{r.limitHit ? ' (limit)' : ''}</td><td>{r.updates}</td><td>{r.maxMetric}</td><td>{r.loopFrames ? `⚠ ${r.loopFrames}` : '0'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">Results depend on this topology, the timing model and which link fails. Split horizon only prevents loops between TWO routers; larger loops can still count to infinity.</p>
    </div>
  );
}

// ---------------------------------------------------------------- comparison

export function ComparePanel({ topo, options }: { topo: Topology; options: SimOptions }) {
  const pcList = pcs(topo);
  const [src, setSrc] = useState(pcList[0]?.id ?? '');
  const [dst, setDst] = useState(pcList[pcList.length - 1]?.id ?? '');
  const routerLinks = topo.links.filter((l) => getDevice(topo, l.a.dev)?.kind === 'router' && getDevice(topo, l.b.dev)?.kind === 'router');
  const [fail, setFail] = useState<string>(routerLinks.find((l) => deviceName(topo, l.a.dev) === 'R4' && deviceName(topo, l.b.dev) === 'R5')?.id ?? routerLinks[0]?.id ?? '');
  const res = useMemo(() => (src && dst && src !== dst ? compareModes(topo, options, src, dst, fail || null) : []), [topo, options, src, dst, fail]);
  const name = (id: string) => deviceName(topo, id);
  const dest = destinationOf(topo, dst);
  const routersList = topo.devices.filter((d) => d.kind === 'router');
  const pingText = (r: (typeof res)[number]['initial']) => (r.ping.success ? `✔ works (${r.ping.requestPath.map(name).join('→')})` : `✕ fails at ${name(r.ping.failure?.at ?? '')} (${r.ping.failure?.code})`);
  return (
    <section className="card" aria-label="Comparison of routing methods">
      <div className="card-head"><h2>Compare all three on the same topology</h2></div>
      <div className="row">
        <label>From <select value={src} onChange={(e) => setSrc(e.target.value)}>{pcList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>To <select value={dst} onChange={(e) => setDst(e.target.value)}>{pcList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Then fail link <select value={fail} onChange={(e) => setFail(e.target.value)}><option value="">(no failure)</option>{routerLinks.map((l) => <option key={l.id} value={l.id}>{name(l.a.dev)}–{name(l.b.dev)}</option>)}</select></label>
      </div>
      <p className="small muted">Destination network: {dest}. Static mode uses the static routes currently configured on the routers. Counts come from actually running each simulation; they are event counts in this model, not real-world times.</p>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th></th>{res.map((r) => <th key={r.mode}>{MODE_FACTS[r.mode].name}</th>)}</tr></thead>
          <tbody>
            {(['knows', 'obtain', 'exchanged', 'calc'] as const).map((k) => (
              <tr key={k}>
                <th scope="row">{{ knows: 'What each router knows at first', obtain: 'How routes are obtained', exchanged: 'Information exchanged', calc: 'Calculation performed' }[k]}</th>
                {res.map((r) => <td key={r.mode}>{MODE_FACTS[r.mode][k]}</td>)}
              </tr>
            ))}
            <tr><th scope="row">Events until stable</th>{res.map((r) => <td key={r.mode}>{r.initial.events}</td>)}</tr>
            <tr><th scope="row">Protocol messages</th>{res.map((r) => <td key={r.mode}>{r.initial.messages}</td>)}</tr>
            <tr><th scope="row">Routing-table changes</th>{res.map((r) => <td key={r.mode}>{r.initial.tableChanges}</td>)}</tr>
            {routersList.map((rt) => (
              <tr key={rt.id}>
                <th scope="row">{rt.name} → {dest}</th>
                {res.map((r) => {
                  const x = r.initial.routes[rt.id];
                  return <td key={r.mode} className="mono small">{!x ? 'no route' : x.source === 'connected' ? 'connected' : `via ${x.learnedFrom ? name(x.learnedFrom) : x.nextHop}${x.source !== 'static' ? `, cost ${x.metric}` : ''}`}</td>;
                })}
              </tr>
            ))}
            <tr><th scope="row">Ping {name(src)} → {name(dst)}</th>{res.map((r) => <td key={r.mode}>{pingText(r.initial)}</td>)}</tr>
            <tr><th scope="row">Response to a failure</th>{res.map((r) => <td key={r.mode}>{MODE_FACTS[r.mode].failure}</td>)}</tr>
            {fail && (
              <>
                <tr><th scope="row">After failure: events</th>{res.map((r) => <td key={r.mode}>{r.afterFailure?.events}{r.afterFailure?.limitHit ? ' (limit)' : ''}</td>)}</tr>
                <tr><th scope="row">After failure: messages</th>{res.map((r) => <td key={r.mode}>{r.afterFailure?.messages}</td>)}</tr>
                <tr><th scope="row">After failure: table changes</th>{res.map((r) => <td key={r.mode}>{r.afterFailure?.tableChanges}</td>)}</tr>
                <tr><th scope="row">After failure: ping</th>{res.map((r) => <td key={r.mode}>{r.afterFailure && pingText(r.afterFailure)}</td>)}</tr>
                <tr><th scope="row">Manual intervention needed?</th>{res.map((r) => <td key={r.mode}><strong>{r.manual}</strong></td>)}</tr>
              </>
            )}
          </tbody>
        </table>
      </div>
      <p className="small muted">Convergence depends on the topology, protocol settings and this event model (1 time unit per message, 30-unit DV update timer, 5-unit SPF delay). No method is "always faster".</p>
    </section>
  );
}

// ---------------------------------------------------------------- legend and assumptions

export function Legend() {
  const sw = (el: JSX.Element) => <svg width="44" height="26" viewBox="-22 -13 44 26" aria-hidden>{el}</svg>;
  return (
    <section className="card" aria-label="Legend">
      <h2>Legend</h2>
      <div className="legend">
        <div className="item">{sw(<g><rect x={-15} y={-10} width={30} height={20} rx={3} fill="var(--c-data)" /><path d="M-15 -10 L0 2 L15 -10" fill="none" stroke="var(--bg)" strokeWidth={1.5} /></g>)} Data packet (ICMP ping) — teal solid envelope, shows TTL</div>
        <div className="item">{sw(<g><rect x={-15} y={-10} width={30} height={20} rx={3} fill="var(--node)" stroke="var(--c-arp)" strokeWidth={1.6} strokeDasharray="4 3" /><path d="M-15 -10 L0 2 L15 -10" fill="none" stroke="var(--c-arp)" strokeWidth={1.3} /></g>)} ARP frame — purple dashed envelope</div>
        <div className="item">{sw(<g><rect x={-11} y={-11} width={22} height={22} rx={4} fill="var(--node)" stroke="var(--c-dv)" strokeWidth={2} /><text y={4} textAnchor="middle" fontSize={8} fontWeight={800} fill="var(--c-dv)">DV</text></g>)} Distance-vector / RIP update — orange square "DV"</div>
        <div className="item">{sw(<g><rect x={-20} y={-11} width={40} height={22} rx={6} fill="var(--node)" stroke="var(--c-ospf)" strokeWidth={1.8} /><text y={4} textAnchor="middle" fontSize={8.5} fontWeight={800} fill="var(--c-ospf)">Hello</text></g>)} OSPF Hello / LSAck — outlined box with the message name</div>
        <div className="item">{sw(<g><rect x={-20} y={-11} width={40} height={22} rx={6} fill="var(--node)" stroke="var(--c-ospf)" strokeWidth={1.8} strokeDasharray="4 2.5" /><text y={4} textAnchor="middle" fontSize={8.5} fontWeight={800} fill="var(--c-ospf)">DBD</text></g>)} OSPF DBD / LSR (database exchange) — dashed box</div>
        <div className="item">{sw(<g><rect x={-20} y={-11} width={40} height={22} rx={6} fill="var(--c-ospf)" /><text y={4} textAnchor="middle" fontSize={8.5} fontWeight={800} fill="var(--bg)">LSU</text></g>)} OSPF LSU (carries LSAs) — solid box; the line below says whose LSA</div>
        <div className="item">{sw(<g>{[-12, 0, 12].map((x) => <rect key={x} x={x - 5} y={-4} width={10} height={8} rx={1.5} fill="var(--fg)" />)}</g>)} Switch flooding — several copies leave at once</div>
        <div className="item">{sw(<g><line x1={-20} y1={0} x2={20} y2={0} stroke="var(--fail)" strokeWidth={3} strokeDasharray="6 4" /><circle r={7} fill="var(--node)" stroke="var(--fail)" strokeWidth={2} /><path d="M-3 -3 L3 3 M3 -3 L-3 3" stroke="var(--fail)" strokeWidth={2} /></g>)} Failed / disabled link — dashed + ✕ "DOWN"</div>
        <div className="item">{sw(<line x1={-18} y1={0} x2={14} y2={0} stroke="var(--c-data)" strokeWidth={7} strokeOpacity={0.4} markerEnd="url(#arrow-route)" />)} Selected route path — thick teal arrow</div>
        <div className="item">{sw(<line x1={-18} y1={0} x2={18} y2={0} stroke="var(--c-ospf)" strokeWidth={6} strokeOpacity={0.5} strokeDasharray="2 6" strokeLinecap="round" />)} Shortest-path tree (link state) — blue dotted</div>
        <div className="item">{sw(<g><polygon points="-6,-12 6,-12 12,-6 12,6 6,12 -6,12 -12,6 -12,-6" fill="var(--fail)" /><path d="M-5 -5 L5 5 M5 -5 L-5 5" stroke="#fff" strokeWidth={2.5} /></g>)} Packet drop — octagon ✕ "DROP"</div>
        <div className="item">{sw(<circle r={10} fill="none" stroke="var(--fg)" strokeWidth={2} strokeDasharray="4 3" />)} Device involved in the current event</div>
        <div className="item">{sw(<g><circle cx={-10} r={8} fill="var(--node)" stroke="var(--fg)" strokeWidth={2} /><rect x={2} y={-7} width={18} height={14} rx={2} fill="var(--node)" stroke="var(--fg)" strokeWidth={2} /></g>)} Router (circle) · Switch (wide box) · PC (screen)</div>
        <div className="item"><span className="badge new">NEW</span><span className="badge chg">CHANGED</span> Row changed in this event · click a packet to inspect it</div>
      </div>
    </section>
  );
}

export function Assumptions({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="assump-title" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head"><h2 id="assump-title">Model assumptions and simplifications</h2><button className="btn" onClick={onClose} autoFocus>Close</button></div>
        <h3>General</h3>
        <ul>
          <li>No real packets are sent. Everything is simulated in your browser and is deterministic: the same configuration always gives the same events.</li>
          <li>PCs connect to a router or to an unmanaged switch. A direct link or a group of devices joined by switches forms one Layer 2 segment, which must use one subnet.</li>
          <li>Links are point-to-point and symmetric (same cost in both directions). A disabled link takes both interfaces down; both routers notice immediately.</li>
          <li>Time is measured in abstract time units. Every protocol message takes 1 time unit to cross a link.</li>
          <li>Ping uses a teaching default TTL of 16 (routers and PCs originate with the same value). Routers decrease TTL by 1 before forwarding and drop the packet when it reaches 0.</li>
          <li>Ping outcomes: <em>success</em> needs both the echo request and the echo reply. A router with no route reports <em>destination unreachable</em>; TTL 0 reports <em>TTL expired in transit</em>; a lost reply is a <em>timeout</em>. The ICMP error messages themselves are not animated.</li>
          <li>Pings are sent one after another (not on a 1-second timer). Packet sizes are realistic for ICMP, ARP and RIPv2; OSPF sizes are approximate; the generic distance-vector protocol has no real size.</li>
          <li>Packet Inspector fields are simulated, not captured. Checksums are not computed and fields such as the ICMP identifier use fixed values (marked "simulated").</li>
          <li>Ping count: 1, 3 (default) or continuous until Stop. Pings are sent one after another, not on a real 1-second timer. If routing events are still pending, exactly one routing event happens between two pings, so a continuous ping shows the network converging.</li>
          <li>Equal-cost paths: one route is kept (no load sharing). Ties are broken by name order.</li>
          <li>Each mode uses its own routes only: static routes are ignored in distance-vector and link-state modes (no redistribution).</li>
        </ul>
        <h3>Layer 2: ARP and switches</h3>
        <ul>
          <li>Every interface has a stable, locally administered MAC address (02:00:…). Before sending, a device needs the next hop's MAC: it uses its ARP cache, or broadcasts an ARP request and waits for the unicast reply. Both sides learn each other's entry.</li>
          <li>ARP cache entries do not expire in this model; use "Clear ARP &amp; MAC tables" to watch them being learned again.</li>
          <li>Unmanaged switches learn source MAC addresses per port, forward known unicast to one port, and flood broadcast and unknown unicast to all other ports. MAC entries age out after 300 time units and are removed when a port's link goes down.</li>
          <li>No Spanning Tree Protocol, VLANs or full-duplex/collision details. Loops between switches are rejected by validation.</li>
          <li>Routers on the same switched LAN become neighbours (multi-access) for RIP and link state; the cost used is the router's own link cost.</li>
        </ul>
        <h3>Static routing</h3>
        <ul>
          <li>Connected routes (AD 0) appear automatically for interfaces with an address on an enabled link.</li>
          <li>Next hops may be adjacent or remote. Remote next hops are resolved recursively through another route; a route cannot resolve through itself.</li>
          <li>A static route with only an exit interface sends the packet to the device at the other end of that point-to-point link.</li>
          <li>The simulator uses Cisco-style administrative distance (static default 1). Huawei commands map AD a → preference 59 + a.</li>
          <li>A router only withdraws a static route when its OWN next-hop/interface becomes unusable. Remote failures are not detected.</li>
        </ul>
        <h3>Distance vector</h3>
        <ul>
          <li>Metric convention: connected networks cost 0 at the router that owns them. Candidate cost = link cost to neighbour + neighbour's advertised cost.</li>
          <li>Generic profile: weighted link costs, configurable infinity (default 100). RIP profile: every link = 1 hop, 16 = unreachable. The two are never mixed.</li>
          <li>Periodic updates every 30 time units (labelled "30 s" in the RIP profile); all routers send at the same moment, processed in a fixed order.</li>
          <li>A route from the current next hop is always accepted (even if worse); from another neighbour only if strictly better.</li>
          <li>Triggered updates send only the changed routes, immediately. When a link comes up, both ends send their full table to the new neighbour (if triggered updates are on).</li>
          <li>Route timeout is modelled: a learned route not re-advertised by its next hop for more than 180 time units becomes unreachable (this is how a neighbour that disappears behind a switch is detected). RIP's garbage-collection (120 s) and hold-down timers are NOT modelled; unreachable routes stay in the table marked ∞.</li>
          <li>Cost changes take effect when the next advertisement arrives.</li>
          <li>Convergence is declared when a full periodic round changes nothing.</li>
        </ul>
        <h3>Link state (OSPF-style: OSPFv2, single area)</h3>
        <ul>
          <li>Close to OSPFv2 for one area (area 0), but still a teaching model: it is not a complete OSPF implementation.</li>
          <li>Router ID = the highest loopback address, otherwise the highest interface address. All router priorities are 1.</li>
          <li>Hellos list the neighbours already heard. A neighbour is <em>Init</em> until a router sees its own router ID in the neighbour's Hello (<em>2-Way</em>). Only the Hellos that change something are shown; the periodic 10-second Hellos are not animated.</li>
          <li>Switched LANs are multi-access: after 2-Way the routers elect a DR (highest router ID) and BDR. A working DR is never replaced (no preemption); if it fails, the BDR takes over. DROTHERs stay 2-Way with each other.</li>
          <li>Adjacency: ExStart (master = higher router ID) → Exchange (DBD headers) → Loading (LSR, LSU, LSAck) → Full. DBD sequence numbers, flags and retransmissions are not modelled; LSAcks are mentioned but not animated.</li>
          <li>Router-LSAs (Type 1) list only FULL neighbours, transit LANs and stub networks; loopbacks are advertised as /32. The DR originates a Network-LSA (Type 2) listing the attached routers. No Summary or External LSAs (no areas, no redistribution).</li>
          <li>LSAs are flooded only over FULL adjacencies, unchanged, and only when newer (higher sequence number). LSA age, MaxAge and refresh every 30 minutes are not modelled.</li>
          <li>A failed interface is noticed at once by its own router. A neighbour that disappears behind a switch is declared down after the Dead interval (40 time units).</li>
          <li>SPF runs 5 time units after the router's last database change. Point-to-point links are used only if both ends report them; a LAN is its own node (router → LAN = interface cost, LAN → router = 0).</li>
          <li>Interface costs are the link costs you set (no reference-bandwidth calculation). Equal-cost paths are not load-shared.</li>
        </ul>
        <h3>Saving and sharing</h3>
        <ul>
          <li>Labs are saved in this browser (Save Lab, autosave). There is no server: to move a lab to another computer, export the file or create a share link.</li>
          <li>A share link contains the whole lab, compressed, after the # in the address. The # part is never sent to the web server, so nothing is uploaded or stored online. Large labs give long links; QR codes hold about 2,800 characters.</li>
          <li>Routing tables are not stored as truth: they are recalculated from the saved configuration (the result is deterministic). Pings and other data packets in the timeline are not saved.</li>
        </ul>
        <h3>Comparison</h3>
        <ul>
          <li>Event and message counts depend on this topology, these timers and settings. They do not show that one protocol is always faster.</li>
        </ul>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { cidr, inSubnet, isValidIp, networkOf } from '../model/ip';
import { addLoopback, deviceName, getDevice, isLoopback, linkOfIface, macOf, otherEnd, routerNeighbors, segmentOf } from '../model/topology';
import type { Device, Level, Link, SimOptions, StaticRoute, Topology } from '../model/types';
import { validateIfaceAddress, validateStaticRoute } from '../model/validate';
import { generateCli } from '../engine/cli';
import { routeKey, type Change } from '../engine/rib';
import type { Frame, SimState } from '../engine/types';
import type { HopStep } from '../engine/ping';
import { RouteTable } from './RouteTable';
import { DvRouterView, LsRouterView } from './ProtocolViews';
import type { Sel } from './Canvas';

interface Props {
  state: SimState;
  frames: Frame[];
  cursor: number;
  level: Level;
  options: SimOptions;
  sel: Sel;
  hideValues: boolean;
  changes: Change[];
  pingHop?: HopStep;
  selectedKey: string | null;
  onSelectKey: (k: string | null) => void;
  onStructural: (t: Topology, desc: string) => void;
  onLink: (linkId: string, patch: Partial<Pick<Link, 'up' | 'cost'>>) => void;
  onStatic: (t: Topology, desc: string) => void;
  onDelete: (s: Sel) => void;
}

export function Inspector(p: Props) {
  const topo = p.state.topo;
  if (!p.sel) {
    return (
      <div className="card">
        <h2>Inspector</h2>
        <p className="muted">Click a router, PC or link on the canvas to inspect it. Routers show their routing table, where each route came from, and the protocol's working.</p>
      </div>
    );
  }
  if (p.sel.kind === 'link') {
    const link = topo.links.find((l) => l.id === p.sel!.id);
    if (!link) return null;
    return <LinkPanel {...p} link={link} />;
  }
  const dev = getDevice(topo, p.sel.id);
  if (!dev) return null;
  return dev.kind === 'pc' ? <PcPanel {...p} dev={dev} /> : dev.kind === 'switch' ? <SwitchPanel {...p} dev={dev} /> : <RouterPanel {...p} dev={dev} />;
}

function LinkPanel(p: Props & { link: Link }) {
  const topo = p.state.topo;
  const { link } = p;
  const [cost, setCost] = useState(String(link.cost));
  useEffect(() => setCost(String(link.cost)), [link.cost, link.id]);
  const mode = p.state.mode;
  const costUsed = mode === 'ls' || (mode === 'dv' && p.options.dv.profile === 'generic');
  const end = (e: Link['a']) => {
    const d = getDevice(topo, e.dev);
    const i = d?.ifaces.find((x) => x.id === e.iface);
    return { d, i };
  };
  const a = end(link.a);
  const b = end(link.b);
  const costNum = Number(cost);
  const costBad = !Number.isInteger(costNum) || costNum < 1 || costNum > 65535;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Link {a.d?.name} — {b.d?.name}</h2>
        <span className={`pill ${link.up ? 'ok' : 'bad'}`}>{link.up ? '● enabled' : '✕ disabled'}</span>
      </div>
      <dl className="kv">
        {[a, b].map((x, k) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{x.d?.name} {x.i?.name}</dt>
            <dd className="mono">{x.i?.ip ? `${x.i.ip}/${x.i.prefix}` : 'no address'}</dd>
          </div>
        ))}
        <dt>Network</dt>
        <dd className="mono">{a.i?.ip ? cidr(networkOf(a.i.ip, a.i.prefix), a.i.prefix) : '—'}</dd>
      </dl>
      <div className="stack" style={{ marginTop: '0.6rem' }}>
        <div className="row">
          <button className={`btn ${link.up ? 'danger' : 'primary'}`} onClick={() => p.onLink(link.id, { up: !link.up })}>
            {link.up ? '✕ Disable link (simulate failure)' : '● Enable link'}
          </button>
        </div>
        <div className="row">
          <label>
            Cost
            <input type="number" min={1} value={cost} onChange={(e) => setCost(e.target.value)} disabled={!costUsed} className={costBad ? 'bad' : ''} style={{ width: '6rem' }} aria-label="Link cost" />
          </label>
          <button className="btn" disabled={!costUsed || costBad || costNum === link.cost} onClick={() => p.onLink(link.id, { cost: costNum })}>Apply cost</button>
        </div>
        <p className="muted small">
          {mode === 'static' ? 'Static routing does not use link costs.' : mode === 'dv' && p.options.dv.profile === 'rip' ? 'RIP profile: every link counts as 1 hop, so costs are ignored.' : 'Lower cost = preferred. Changing it starts a new event sequence from this point.'}
        </p>
        <p className="muted small">Disabling a link or changing its cost keeps the current routing state and lets the protocol react. Events after this point are replaced.</p>
        <button className="btn danger small" onClick={() => p.onDelete(p.sel)}>Delete link (restarts simulation)</button>
      </div>
    </div>
  );
}

function PcPanel(p: Props & { dev: Device }) {
  const topo = p.state.topo;
  const { dev } = p;
  const ifc = dev.ifaces[0];
  const [name, setName] = useState(dev.name);
  const [ip, setIp] = useState(ifc?.ip ?? '');
  const [prefix, setPrefix] = useState(String(ifc?.prefix ?? 24));
  const [gw, setGw] = useState(dev.gateway ?? '');
  useEffect(() => {
    setName(dev.name);
    setIp(ifc?.ip ?? '');
    setPrefix(String(ifc?.prefix ?? 24));
    setGw(dev.gateway ?? '');
  }, [dev, ifc]);
  const ipErr = ifc && ip ? validateIfaceAddress(ip, Number(prefix)) : null;
  const gwErr = gw && !isValidIp(gw) ? 'Not a valid IPv4 address.' : gw && ip && !ipErr && !inSubnet(gw, ip, Number(prefix)) ? `Gateway must be inside ${cidr(networkOf(ip, Number(prefix)), Number(prefix))}.` : null;
  const apply = () => {
    const t = structuredClone(topo);
    const d = getDevice(t, dev.id)!;
    d.name = name.trim() || dev.name;
    if (d.ifaces[0]) {
      d.ifaces[0].ip = ip.trim();
      d.ifaces[0].prefix = Number(prefix);
    }
    d.gateway = gw.trim();
    p.onStructural(t, `${dev.name} configuration changed`);
  };
  const link = ifc ? linkOfIface(topo, dev.id, ifc.id) : undefined;
  const peer = link ? getDevice(topo, otherEnd(link, dev.id).dev) : undefined;
  return (
    <div className="card">
      <div className="card-head"><h2>PC {dev.name}</h2><span className="pill">host</span></div>
      <p className="muted small">A PC does not route. For any destination outside its own subnet it sends the packet to its default gateway.</p>
      <div className="form-grid">
        <label htmlFor="pc-name">Name</label>
        <input id="pc-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="pc-ip">IP address</label>
        <input id="pc-ip" type="text" value={ip} onChange={(e) => setIp(e.target.value)} className={ipErr ? 'bad' : ''} disabled={!ifc} />
        <label htmlFor="pc-pre">Prefix /</label>
        <input id="pc-pre" type="number" min={1} max={31} value={prefix} onChange={(e) => setPrefix(e.target.value)} disabled={!ifc} />
        <label htmlFor="pc-gw">Default gateway</label>
        <input id="pc-gw" type="text" value={gw} onChange={(e) => setGw(e.target.value)} className={gwErr ? 'bad' : ''} placeholder="(none)" />
      </div>
      {!ifc && <p className="muted small">Connect this PC to a router with the Link tool first.</p>}
      {ipErr && <p className="issue error">{ipErr}</p>}
      {gwErr && <p className="issue error">{gwErr}</p>}
      {peer && <p className="small muted">Connected to {peer.name}{peer.kind === 'switch' ? ' (switch)' : ''}. {peer.kind === 'switch' ? 'The gateway must be a router interface on the same switched LAN.' : 'Its interface on this link is the usual gateway.'}</p>}
      {ifc && <p className="small">MAC address (Layer 2): <span className="mono">{macOf(dev.id, ifc)}</span></p>}
      <ArpTable state={p.state} dev={dev} />
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button className="btn primary" onClick={apply} disabled={!!ipErr || !!gwErr}>Apply (restarts simulation)</button>
        <button className="btn danger small" onClick={() => p.onDelete(p.sel)}>Delete PC</button>
      </div>
    </div>
  );
}

function RouterPanel(p: Props & { dev: Device }) {
  const mode = p.state.mode;
  const [tab, setTab] = useState<'table' | 'ifaces' | 'static' | 'proto' | 'cli' | 'history' | 'arp'>('table');
  useEffect(() => {
    if (tab === 'static' && mode !== 'static') setTab('table');
  }, [mode, tab]);
  const topo = p.state.topo;
  const { dev } = p;
  const pingHere = p.pingHop && p.pingHop.at === dev.id ? p.pingHop : undefined;
  const tabs: [typeof tab, string][] = [
    ['table', 'Routing table'],
    ['ifaces', 'Interfaces'],
    ...(mode === 'static' ? ([['static', `Static routes (${dev.staticRoutes.length})`]] as [typeof tab, string][]) : []),
    ...(mode === 'dv' ? ([['proto', 'DV updates']] as [typeof tab, string][]) : []),
    ...(mode === 'ls' ? ([['proto', 'Link state']] as [typeof tab, string][]) : []),
    ['arp', 'ARP cache'],
    ['history', 'History'],
    ['cli', 'CLI'],
  ];
  return (
    <div className="card">
      <div className="card-head">
        <h2>Router {dev.name}</h2>
        <button className="btn danger small" onClick={() => p.onDelete(p.sel)}>Delete router</button>
      </div>
      <div className="tabs" role="tablist" aria-label="Router details">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'table' && (
        <>
          {pingHere && <p className="small"><strong>Packet here:</strong> destination {pingHere.dstIp}. Green rows match it; the darker row is the longest-prefix match.</p>}
          <RouteTable
            topo={topo} router={dev.id} table={p.state.tables[dev.id] ?? []} mode={mode} options={p.options} level={p.level} changes={p.changes}
            hideValues={p.hideValues} selectedKey={p.selectedKey} onSelectKey={p.onSelectKey} infinity={p.state.dv?.infinity}
            matchKeys={pingHere?.candidates?.map(routeKey)} chosenKey={pingHere?.chosen ? routeKey(pingHere.chosen) : null}
          />
        </>
      )}
      {tab === 'ifaces' && <IfaceEditor {...p} />}
      {tab === 'static' && <StaticEditor {...p} />}
      {tab === 'proto' && mode === 'dv' && <DvRouterView state={p.state} router={dev.id} frames={p.frames} cursor={p.cursor} />}
      {tab === 'proto' && mode === 'ls' && <LsRouterView state={p.state} router={dev.id} />}
      {tab === 'arp' && <ArpTable state={p.state} dev={dev} />}
      {tab === 'history' && <History {...p} />}
      {tab === 'cli' && <Cli {...p} />}
    </div>
  );
}

function History(p: Props & { dev: Device }) {
  const items: { i: number; title: string; c: Change }[] = [];
  for (let i = 0; i <= p.cursor; i++) for (const c of p.frames[i].ev.changes ?? []) if (c.router === p.dev.id) items.push({ i, title: p.frames[i].ev.title, c });
  const fmt = (r?: { metric: number; unreachable?: boolean; nextHop: string | null; source: string }) => (r ? `${r.source}${r.nextHop ? ` via ${r.nextHop}` : ''}${r.source !== 'connected' && r.source !== 'static' ? `, ${r.unreachable ? '∞' : r.metric}` : ''}` : '');
  return (
    <div className="stack">
      <p className="muted small">Every change to {p.dev.name}'s table up to the current event (newest first).</p>
      {items.length === 0 && <p className="muted">No changes yet.</p>}
      <ol className="small" style={{ paddingLeft: '1.2rem', maxHeight: 300, overflow: 'auto' }} reversed>
        {items.reverse().slice(0, 80).map((x, k) => (
          <li key={k} style={{ fontWeight: x.i === p.cursor ? 700 : undefined }}>
            <span className="mono">#{x.i + 1}</span> <span className={`badge ${x.c.kind === 'added' ? 'new' : x.c.kind === 'removed' ? 'del' : 'chg'}`}>{x.c.kind}</span>{' '}
            <span className="mono">{x.c.key}</span> {x.c.kind === 'changed' ? `${fmt(x.c.before)} → ${fmt(x.c.after)}` : fmt(x.c.after ?? x.c.before)}
            <div className="muted">{x.title}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function IfaceEditor(p: Props & { dev: Device }) {
  const topo = p.state.topo;
  const [draft, setDraft] = useState(() => p.dev.ifaces.map((i) => ({ ...i, prefixS: String(i.prefix) })));
  const [name, setName] = useState(p.dev.name);
  useEffect(() => {
    setDraft(p.dev.ifaces.map((i) => ({ ...i, prefixS: String(i.prefix) })));
    setName(p.dev.name);
  }, [p.dev]);
  const errs = draft.map((d) => (d.ip ? validateIfaceAddress(d.ip.trim(), Number(d.prefixS)) : null));
  const apply = () => {
    const t = structuredClone(topo);
    const d = getDevice(t, p.dev.id)!;
    d.name = name.trim() || p.dev.name;
    d.ifaces = d.ifaces.map((i) => {
      const x = draft.find((y) => y.id === i.id)!;
      return { ...i, ip: x.ip.trim(), prefix: Number(x.prefixS) };
    });
    p.onStructural(t, `${p.dev.name} interfaces changed`);
  };
  return (
    <div className="stack">
      <div className="row"><label>Name <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '8rem' }} /></label></div>
      {draft.length === 0 && <p className="muted small">No interfaces. Use the Link tool to connect this router.</p>}
      <table className="tbl">
        <thead><tr><th>Interface</th><th>IP address</th><th>/</th><th>Link to</th>{p.level === 'advanced' && <th>MAC</th>}<th></th></tr></thead>
        <tbody>
          {draft.map((d, k) => {
            const link = linkOfIface(topo, p.dev.id, d.id);
            const peer = isLoopback(d) ? 'virtual (always up)' : link ? deviceName(topo, otherEnd(link, p.dev.id).dev) : '-';
            return (
              <tr key={d.id}>
                <td className="mono">{d.name}</td>
                <td><input type="text" value={d.ip} aria-label={`${d.name} IP address`} className={errs[k] ? 'bad' : ''} style={{ width: '9.5rem' }} onChange={(e) => setDraft(draft.map((x) => (x.id === d.id ? { ...x, ip: e.target.value } : x)))} /></td>
                <td><input type="number" min={1} max={31} value={d.prefixS} aria-label={`${d.name} prefix length`} style={{ width: '4rem' }} onChange={(e) => setDraft(draft.map((x) => (x.id === d.id ? { ...x, prefixS: e.target.value } : x)))} /></td>
                <td>{peer} {link && !link.up && <span className="badge del">DOWN</span>}</td>
                {p.level === 'advanced' && <td className="mono small">{isLoopback(d) ? '—' : macOf(p.dev.id, d)}</td>}
                <td>{isLoopback(d) && (
                  <button className="btn small danger" onClick={() => { const t = structuredClone(topo); const dd = getDevice(t, p.dev.id)!; dd.ifaces = dd.ifaces.filter((i) => i.id !== d.id); p.onStructural(t, `Removed ${d.name} from ${p.dev.name}`); }}>Remove</button>
                )}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {errs.map((e, k) => e && <p key={k} className="issue error">{draft[k].name}: {e}</p>)}
      <div className="row">
        <button className="btn primary" onClick={apply} disabled={errs.some(Boolean)}>Apply (restarts simulation)</button>
        {p.dev.kind === 'router' && <button className="btn" onClick={() => p.onStructural(addLoopback(topo, p.dev.id), `Added a loopback interface to ${p.dev.name}`)}>+ Add loopback</button>}
      </div>
      {p.dev.kind === 'router' && <p className="small muted">A loopback is a virtual interface that is always up. It is handy as a stable address to ping (for example R3's 10.0.3.3) and is advertised by RIP/OSPF like any connected network.</p>}
    </div>
  );
}

function ArpTable({ state, dev }: { state: SimState; dev: Device }) {
  const entries = Object.entries(state.l2.arp[dev.id] ?? {});
  return (
    <div className="stack small">
      <h4>ARP cache (IP → MAC)</h4>
      {entries.length === 0 ? <p className="muted">Empty. {dev.name} learns entries when it sends or receives ARP (run a ping).</p> : (
        <table className="tbl">
          <thead><tr><th>IP address</th><th>MAC address</th><th>Owner</th></tr></thead>
          <tbody>
            {entries.map(([ip, e]) => (
              <tr key={ip}><td className="mono">{ip}</td><td className="mono">{e.mac}</td><td>{state.topo.devices.find((d) => d.ifaces.some((i) => i.ip === ip))?.name ?? '?'}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SwitchPanel(p: Props & { dev: Device }) {
  const topo = p.state.topo;
  const { dev } = p;
  const [name, setName] = useState(dev.name);
  useEffect(() => setName(dev.name), [dev.name]);
  const table = p.state.l2.mac[dev.id] ?? [];
  const lan = (() => {
    for (const port of dev.ifaces) {
      const l = linkOfIface(topo, dev.id, port.id);
      if (l?.up) {
        const o = otherEnd(l, dev.id);
        return segmentOf(topo, o.dev, o.iface).endpoints;
      }
    }
    return [];
  })();
  const owner = (mac: string) => topo.devices.flatMap((d) => d.ifaces.map((i) => ({ d, i }))).find(({ d, i }) => d.kind !== 'switch' && macOf(d.id, i) === mac);
  return (
    <div className="card">
      <div className="card-head"><h2>Switch {dev.name}</h2><span className="pill">unmanaged · Layer 2</span></div>
      <p className="small">An unmanaged switch forwards <strong>Ethernet frames</strong> using MAC addresses. It has no IP address, no routing table and no configuration: it never routes IP packets between networks — that is the router's job. All devices connected through it are in one network (one subnet, one broadcast domain).</p>
      <div className="row"><label>Name <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ width: '8rem' }} /></label>
        <button className="btn small" disabled={!name.trim() || name === dev.name} onClick={() => { const t = structuredClone(topo); getDevice(t, dev.id)!.name = name.trim(); p.onStructural(t, `Renamed switch to ${name.trim()}`); }}>Rename</button></div>
      <h4>Ports</h4>
      <table className="tbl small">
        <thead><tr><th>Port</th><th>Connected to</th><th>State</th></tr></thead>
        <tbody>
          {dev.ifaces.map((i) => {
            const l = linkOfIface(topo, dev.id, i.id);
            const o = l ? otherEnd(l, dev.id) : null;
            return <tr key={i.id}><td>{i.name}</td><td>{o ? `${deviceName(topo, o.dev)} ${topo.devices.find((d) => d.id === o.dev)?.ifaces.find((x) => x.id === o.iface)?.name ?? ''}` : '-'}</td><td>{l?.up ? 'up' : <span className="badge del">DOWN</span>}</td></tr>;
          })}
        </tbody>
      </table>
      <h4>MAC address table</h4>
      {table.length === 0 ? <p className="small muted">Empty. The switch learns the SOURCE MAC of every frame it receives, and which port it came in on. Run a ping to fill it.</p> : (
        <table className="tbl small">
          <thead><tr><th>MAC address</th><th>Port</th><th>Device</th><th>Age</th></tr></thead>
          <tbody>
            {table.map((e) => {
              const o = owner(e.mac);
              return <tr key={e.mac}><td className="mono">{e.mac}</td><td>{topo.devices.find((d) => d.id === dev.id)?.ifaces.find((i) => i.id === e.port)?.name}</td><td>{o ? `${o.d.name} ${o.i.name}` : '?'}</td><td>{p.state.time - e.learnedAt}</td></tr>;
            })}
          </tbody>
        </table>
      )}
      <ul className="small muted">
        <li><strong>Known destination MAC</strong> → forward out of that one port.</li>
        <li><strong>Broadcast or unknown destination</strong> → flood out of every other port.</li>
        <li>Entries age out after 300 time units without traffic, and are removed when a port goes down; they are then relearned.</li>
        <li>No Spanning Tree: loops between switches are rejected.</li>
      </ul>
      {lan.length > 0 && <p className="small">Devices on this LAN: {lan.map((e) => `${e.dev.name} (${e.iface.ip || 'no IP'})`).join(', ')}</p>}
      <button className="btn danger small" onClick={() => p.onDelete(p.sel)}>Delete switch</button>
    </div>
  );
}

const emptyForm = { network: '', prefix: '24', nextHop: '', iface: '', ad: '1' };

function StaticEditor(p: Props & { dev: Device }) {
  const topo = p.state.topo;
  const { dev } = p;
  const status = p.state.staticStatus[dev.id] ?? [];
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<{ severity: string; message: string }[]>([]);
  const adv = p.level === 'advanced';
  const neighbors = routerNeighbors(topo, dev.id);

  const update = (fn: (d: Device) => void, desc: string) => {
    const t = structuredClone(topo);
    fn(getDevice(t, dev.id)!);
    p.onStatic(t, desc);
  };

  const submit = () => {
    const r: StaticRoute = {
      id: editing ?? `sr-${Date.now().toString(36)}`,
      network: form.network.trim(),
      prefix: Number(form.prefix),
      nextHop: form.nextHop.trim(),
      iface: form.iface || undefined,
      ad: Number(form.ad) || 1,
      enabled: true,
    };
    const issues = validateStaticRoute(topo, dev, r);
    setMsgs(issues);
    if (issues.some((i) => i.severity === 'error')) return;
    update((d) => {
      const i = d.staticRoutes.findIndex((x) => x.id === r.id);
      if (i >= 0) d.staticRoutes[i] = { ...r, enabled: d.staticRoutes[i].enabled };
      else d.staticRoutes.push(r);
    }, `${editing ? 'Edited' : 'Added'} static route ${r.network}/${r.prefix} on ${dev.name}`);
    setForm(emptyForm);
    setEditing(null);
  };

  const ifName = (id?: string) => dev.ifaces.find((i) => i.id === id)?.name;
  return (
    <div className="stack">
      <p className="small muted">
        A static route says: "to reach network X, send packets to neighbour Y". Next hops can be adjacent (on a connected network) or remote; remote next hops are resolved recursively through another route.
      </p>
      {dev.staticRoutes.length === 0 && <p className="muted small">No static routes yet.</p>}
      {dev.staticRoutes.map((r) => {
        const st = status.find((s) => s.routeId === r.id);
        const neighbor = topo.devices.find((d) => d.ifaces.some((i) => i.ip === r.nextHop));
        return (
          <div key={r.id} className="card" style={{ padding: '0.45rem 0.6rem' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="mono"><strong>{r.network}/{r.prefix}</strong> → {r.nextHop || ifName(r.iface)}{r.iface && r.nextHop ? ` (${ifName(r.iface)})` : ''}{adv || r.ad !== 1 ? ` · AD ${r.ad}` : ''}</span>
              <span className={`pill ${!r.enabled ? '' : st?.installed ? 'ok' : 'bad'}`}>{!r.enabled ? 'disabled' : st?.installed ? '✔ installed' : '✕ not installed'}</span>
            </div>
            <div className="small">
              To reach {r.prefix === 0 ? 'any unknown network (default route)' : `network ${r.network}/${r.prefix}`}, send the packet to {neighbor ? `neighbour ${neighbor.name}` : 'next hop'} {r.nextHop}{r.iface ? ` through interface ${ifName(r.iface)}` : ''}.
            </div>
            {st && <div className="small muted">{st.reason}</div>}
            <div className="row" style={{ marginTop: '0.3rem' }}>
              <button className="btn small" onClick={() => update((d) => { const x = d.staticRoutes.find((y) => y.id === r.id)!; x.enabled = !x.enabled; }, `${r.enabled ? 'Disabled' : 'Enabled'} static route ${r.network}/${r.prefix} on ${dev.name}`)}>
                {r.enabled ? 'Disable' : 'Enable'}
              </button>
              <button className="btn small" onClick={() => { setEditing(r.id); setForm({ network: r.network, prefix: String(r.prefix), nextHop: r.nextHop, iface: r.iface ?? '', ad: String(r.ad) }); }}>Edit</button>
              <button className="btn small danger" onClick={() => update((d) => { d.staticRoutes = d.staticRoutes.filter((y) => y.id !== r.id); }, `Deleted static route ${r.network}/${r.prefix} on ${dev.name}`)}>Delete</button>
            </div>
          </div>
        );
      })}
      <fieldset className="card" style={{ padding: '0.6rem' }}>
        <legend><strong>{editing ? 'Edit static route' : 'Add static route'}</strong></legend>
        <div className="form-grid">
          <label htmlFor="sr-net">Destination network</label>
          <input id="sr-net" type="text" placeholder="192.168.3.0" value={form.network} onChange={(e) => setForm({ ...form, network: e.target.value })} />
          <label htmlFor="sr-pre">Prefix length /</label>
          <input id="sr-pre" type="number" min={0} max={32} value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} />
          <label htmlFor="sr-nh">Next hop</label>
          <div className="row">
            <input id="sr-nh" type="text" list="nh-list" placeholder="10.0.12.2" value={form.nextHop} onChange={(e) => setForm({ ...form, nextHop: e.target.value })} />
            <datalist id="nh-list">{neighbors.map((n) => <option key={n.key} value={n.remoteIface.ip}>{deviceName(topo, n.router)}</option>)}</datalist>
          </div>
          {adv && (
            <>
              <label htmlFor="sr-if">Exit interface (optional)</label>
              <select id="sr-if" value={form.iface} onChange={(e) => setForm({ ...form, iface: e.target.value })}>
                <option value="">(resolve from next hop)</option>
                {dev.ifaces.map((i) => <option key={i.id} value={i.id}>{i.name} {i.ip}</option>)}
              </select>
              <label htmlFor="sr-ad">Admin distance</label>
              <input id="sr-ad" type="number" min={1} max={255} value={form.ad} onChange={(e) => setForm({ ...form, ad: e.target.value })} />
            </>
          )}
        </div>
        {neighbors.length > 0 && (
          <div className="small muted" style={{ marginTop: '0.35rem' }}>
            Neighbours: {neighbors.map((n) => `${deviceName(topo, n.router)} = ${n.remoteIface.ip}`).join(' · ')}
            <div className="row" style={{ marginTop: '0.25rem' }}>
              <button className="btn small" onClick={() => setForm({ ...form, network: '0.0.0.0', prefix: '0' })}>Make it a default route (0.0.0.0/0)</button>
            </div>
          </div>
        )}
        {msgs.map((m, k) => <p key={k} className={`issue ${m.severity}`}>{m.message}</p>)}
        <div className="row" style={{ marginTop: '0.4rem' }}>
          <button className="btn primary" onClick={submit}>{editing ? 'Save route' : 'Add route'}</button>
          {editing && <button className="btn" onClick={() => { setEditing(null); setForm(emptyForm); setMsgs([]); }}>Cancel</button>}
        </div>
        {adv && <p className="small muted">Backup ("floating") route: give it a higher AD than the main route (e.g. 5). It is only installed when the main route cannot be used.</p>}
      </fieldset>
    </div>
  );
}

function Cli(p: Props & { dev: Device }) {
  const [vendor, setVendor] = useState<'huawei' | 'cisco'>('huawei');
  const lines = generateCli(p.state.topo, p.dev, p.state.mode, p.options.dv, vendor);
  return (
    <div className="stack">
      <div className="seg" role="group" aria-label="Vendor">
        <button aria-pressed={vendor === 'huawei'} onClick={() => setVendor('huawei')}>Huawei VRP</button>
        <button aria-pressed={vendor === 'cisco'} onClick={() => setVendor('cisco')}>Cisco IOS</button>
      </div>
      <pre className="cli" aria-label="Generated configuration commands">{lines.join('\n')}</pre>
      <p className="muted small">
        Generated from the same configuration the simulator uses (learning aid; not a complete device config).
        {vendor === 'huawei' && ' Huawei static routes use a "preference" (default 60). The lab maps AD a → preference 59 + a so the order of main and backup routes is kept.'}
        {p.state.mode === 'ls' && ' The simulator is a simplified OSPF-inspired model; real OSPF has areas, DR/BDR, timers and LSA types that are not modelled.'}
      </p>
    </div>
  );
}

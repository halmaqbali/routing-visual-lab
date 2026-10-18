import { useEffect, useRef } from 'react';
import { deviceName, ifaceName } from '../model/topology';
import type { Topology } from '../model/types';
import { routeKey } from '../engine/rib';
import type { Frame } from '../engine/types';

const LAYER_LABEL: Record<number, string> = { 2: 'Layer 2 — data link (MAC addresses)', 3: 'Layer 3 — network (IP addresses)', 4: 'Layer 4 — transport', 7: 'Application / routing protocol' };

function KV({ k, v, mono }: { k: string; v?: string | number | null; mono?: boolean }) {
  if (v === undefined || v === null || v === '') return null;
  return (
    <>
      <dt>{k}</dt>
      <dd className={mono ? 'mono' : undefined}>{v}</dd>
    </>
  );
}

export function PacketInspector({ frames, cursor, onJump }: { frames: Frame[]; cursor: number; onJump: (i: number) => void }) {
  const f = frames[cursor];
  const pkt = f.ev.packet;
  const topo: Topology = f.state.topo;
  const n = (id?: string) => (id ? deviceName(topo, id) : undefined);
  const hop = f.ev.ping;
  const logRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    const row = logRef.current;
    const box = row?.closest('.packet-log');
    if (row && box) {
      const top = row.offsetTop - (box as HTMLElement).offsetTop;
      if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 30) box.scrollTop = top - 40;
    }
  }, [cursor]);

  // TTL trail for the current ping: every hop of the IP packet so far.
  let start = -1;
  for (let i = cursor; i >= 0; i--) if (frames[i].ev.kind === 'ping-start') { start = i; break; }
  const trail = start >= 0
    ? frames.slice(start, cursor + 1).filter((x) => x.ev.ping && x.ev.ping.layer === 3 && x.ev.packet?.protocol === 'ICMP' && (x.ev.ping.toDevice || x.ev.ping.action === 'receive' || x.ev.ping.action === 'drop'))
    : [];

  const log = frames.map((x, i) => ({ x, i })).filter(({ x }) => x.ev.packet);
  const shown = log.filter(({ i }) => i <= cursor + 60).slice(-200);

  return (
    <div className="stack packet-inspector">
      {!pkt ? (
        <div className="banner info small">
          <span>This event has no packet. Step to a packet event, click a moving packet on the canvas, or choose one in the packet log below.</span>
        </div>
      ) : (
        <>
          <div className="row">
            <span className="pill strong">{pkt.protocol}</span>
            <strong className="mono small">{pkt.info}</strong>
          </div>
          <dl className="kv">
            <KV k="Time / step" v={`t = ${f.ev.time} · event ${cursor + 1} of ${frames.length}`} />
            <KV k="Created by" v={n(pkt.origin)} />
            <KV k="Final destination" v={n(pkt.target)} />
            <KV k="Current hop" v={n(pkt.at)} />
            <KV k="Next hop" v={n(pkt.next) ?? (hop?.action === 'drop' ? 'none — dropped here' : hop?.action === 'receive' ? 'none — delivered' : undefined)} />
            <KV k="Incoming interface" v={pkt.inIface ?? hop?.inIfaceName} />
            <KV k="Outgoing interface" v={pkt.outIface ?? hop?.outIfaceName} />
            <KV k="Source IP (L3)" v={pkt.srcIp} mono />
            <KV k="Destination IP (L3)" v={pkt.dstIp} mono />
            <KV k="Source MAC (L2)" v={pkt.srcMac} mono />
            <KV k="Destination MAC (L2)" v={pkt.dstMac} mono />
            <KV k="IP TTL" v={pkt.ttl} />
            <KV k="Size" v={pkt.sizeBytes ? `${pkt.sizeBytes} bytes` : 'not modelled'} />
          </dl>
          <p className="small muted">{pkt.sizeNote}</p>

          {pkt.notes.length > 0 && (
            <div className="card inset">
              <h4>Why this happens</h4>
              <ul className="small">{pkt.notes.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
          )}

          {hop?.candidates && hop.layer === 3 && (
            <div className="card inset small">
              <h4>Routing table lookup at {n(hop.at)}</h4>
              {hop.candidates.length === 0 ? <p>No route contains {hop.dstIp} → the packet is dropped.</p> : (
                <table className="tbl">
                  <thead><tr><th>Matching route</th><th>Prefix length</th><th>Next hop</th><th>Out</th></tr></thead>
                  <tbody>
                    {hop.candidates.map((r) => (
                      <tr key={routeKey(r)} className={hop.chosen && routeKey(hop.chosen) === routeKey(r) ? 'chosen' : 'match'}>
                        <td className="mono">{routeKey(r)}</td><td>/{r.prefix}</td><td className="mono">{r.source === 'connected' ? 'connected' : r.nextHop ?? '—'}</td><td>{ifaceName(topo, hop.at, r.iface)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted">Longest-prefix match: when several routes contain the destination, the one with the longest prefix (most specific network) wins.</p>
            </div>
          )}

          {hop?.macDecision && (
            <div className="card inset small">
              <h4>{n(hop.macDecision.switch)} MAC address table after this frame</h4>
              <table className="tbl">
                <thead><tr><th>MAC address</th><th>Port</th><th>Age</th></tr></thead>
                <tbody>
                  {(f.state.l2.mac[hop.macDecision.switch] ?? []).map((e) => (
                    <tr key={e.mac} className={e.mac === hop.macDecision!.learned ? 'changed' : ''}>
                      <td className="mono">{e.mac}</td><td>{ifaceName(topo, hop.macDecision!.switch, e.port)}</td><td>{f.ev.time - e.learnedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted">Decision: <strong>{hop.macDecision.decision}</strong>{hop.macDecision.outPorts.length ? ` → ${hop.macDecision.outPorts.join(', ')}` : ''}.</p>
            </div>
          )}

          {trail.length > 1 && (
            <div className="card inset small">
              <h4>TTL along this {f.ev.ping?.phase === 'reply' ? 'reply' : 'request'} so far</h4>
              <ol className="ttl-trail">
                {trail.filter((x) => x.ev.ping!.phase === f.ev.ping?.phase).map((x, k) => (
                  <li key={k}><strong>{n(x.ev.ping!.at)}</strong> TTL {x.ev.ping!.ttlIn === x.ev.ping!.ttlOut ? x.ev.ping!.ttlOut : `${x.ev.ping!.ttlIn} → ${x.ev.ping!.ttlOut}`}</li>
                ))}
              </ol>
            </div>
          )}

          {pkt.layers.map((l) => (
            <details key={l.name} className="layer" open>
              <summary><span className="layer-tag">L{l.layer}</span> {l.name} <span className="muted small">— {LAYER_LABEL[l.layer]}</span></summary>
              <table className="tbl fields">
                <tbody>
                  {l.fields.map((fd, i) => (
                    <tr key={i}><th scope="row">{fd.name}</th><td className="mono">{fd.value}{fd.simulated && <span className="badge sim" title="Fixed or illustrative value: not computed by a real network stack">simulated</span>}</td></tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
          <p className="small muted">These are simulated packets, not real captures. Fields marked "simulated" use fixed or illustrative values; checksums are not computed.</p>
        </>
      )}

      <div>
        <h4>Packet log</h4>
        <div className="packet-log">
          <table className="tbl">
            <thead><tr><th>No.</th><th>Time</th><th>Source → Destination</th><th>Protocol</th><th>Info</th></tr></thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={5} className="muted">No packets yet.</td></tr>}
              {shown.map(({ x, i }) => (
                <tr key={i} ref={i === cursor ? logRef : undefined} className={`clickable ${i === cursor ? 'sel' : ''} ${i > cursor ? 'future' : ''}`} onClick={() => onJump(i)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onJump(i); }}>
                  <td>{i + 1}</td>
                  <td>{x.ev.time}</td>
                  <td className="mono">{x.ev.packet!.srcIp || n(x.ev.packet!.origin)} → {x.ev.packet!.dstIp || n(x.ev.packet!.target) || '?'}</td>
                  <td>{x.ev.packet!.protocol}</td>
                  <td>{n(x.ev.packet!.at)}: {x.ev.packet!.info}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

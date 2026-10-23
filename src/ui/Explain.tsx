import type { Level } from '../model/types';
import { deviceName } from '../model/topology';
import { routeKey, type Change } from '../engine/rib';
import type { Frame } from '../engine/types';
import { DvCalcTable, SpfTable } from './ProtocolViews';

export const CATEGORY: Record<string, { label: string; short: string }> = {
  config: { label: 'Configuration / topology change', short: 'C' },
  control: { label: 'Routing update (control plane)', short: 'DV' },
  lsa: { label: 'Link-state message (control plane)', short: 'L' },
  spf: { label: 'SPF calculation', short: 'S' },
  data: { label: 'Data packet (ping)', short: 'P' },
  info: { label: 'Information', short: 'i' },
};

function changeText(f: Frame, c: Change) {
  const n = deviceName(f.state.topo, c.router);
  const r = c.after ?? c.before!;
  const via = r.nextHop ? ` via ${r.nextHop}` : r.source === 'connected' ? ' (connected)' : '';
  const cost = r.source === 'dv' || r.source === 'ls' ? `, cost ${r.unreachable ? '∞' : r.metric}` : '';
  if (c.kind === 'added') return `${n}: added ${c.key}${via}${cost}`;
  if (c.kind === 'removed') return `${n}: removed ${c.key}`;
  const b = c.before!;
  return `${n}: changed ${c.key} — was${b.nextHop ? ` via ${b.nextHop}` : ''}${b.source === 'dv' || b.source === 'ls' ? ` cost ${b.unreachable ? '∞' : b.metric}` : ''}, now${via}${cost}`;
}

interface Props {
  frame: Frame;
  index: number;
  total: number;
  level: Level;
  gated: boolean;
  /** Only the detail tables (the step card already shows the category, title and explanation). */
  compact?: boolean;
  hideValues: boolean;
  onUngate: () => void;
}

export function Explain({ frame, index, total, level, gated, hideValues, onUngate, compact }: Props) {
  const ev = frame.ev;
  const cat = CATEGORY[ev.category];
  const topo = frame.state.topo;
  const n = (id: string) => deviceName(topo, id);
  const hop = ev.ping;
  return (
    <section className={compact ? 'explain compact' : 'card explain'} aria-live={compact ? undefined : 'polite'} aria-label="Explanation details">
      {!compact && <><div className="card-head">
        <div className="row">
          <span className={`cat ${ev.category}`} aria-hidden><span>{cat.short}</span></span>
          <span className="small muted">{cat.label}</span>
        </div>
        <span className="small muted">Event {index + 1} of {total} · t = {ev.time}</span>
      </div>
      <h3>{ev.title}</h3></>}
      {gated ? (
        <div className="gate">
          <p><strong>Make your prediction first.</strong> The explanation is hidden in Teacher Mode until you answer the scenario's prediction question.</p>
          <button className="btn" onClick={onUngate}>Show explanation anyway</button>
        </div>
      ) : (
        <>
          {!compact && <p className="lead">{ev.explain}</p>}
          {hop && (
            <div className="stack">
              <div className="tbl-wrap">
                <table className="tbl">
                  <caption className="sr-only">Forwarding decision</caption>
                  <tbody>
                    <tr><th scope="row">Packet</th><td>{hop.packet.protocol === 'ARP' ? `ARP (needed before the ICMP echo ${hop.phase} can be sent)` : `ICMP echo ${hop.phase}`} · IP {hop.srcIp} → <strong className="mono">{hop.dstIp}</strong></td></tr>
                    {hop.srcMac && <tr><th scope="row">Ethernet frame (L2)</th><td className="mono">{hop.srcMac} → {hop.dstMac}</td></tr>}
                    {hop.macDecision && <tr><th scope="row">Switch decision</th><td>learned {hop.macDecision.learned} on {hop.macDecision.port}; <strong>{hop.macDecision.decision}</strong>{hop.macDecision.outPorts.length ? ` → ${hop.macDecision.outPorts.join(', ')}` : ''}</td></tr>}
                    {hop.candidates && <tr><th scope="row">Matching routes</th><td className="mono">{hop.candidates.length ? hop.candidates.map(routeKey).join(', ') : 'none'}</td></tr>}
                    {hop.candidates !== undefined && <tr><th scope="row">Selected route</th><td className="mono">{hop.chosen ? routeKey(hop.chosen) : '— (no match)'}</td></tr>}
                    <tr><th scope="row">Why</th><td>{hop.why}</td></tr>
                    {hop.nextHopIp && <tr><th scope="row">Next hop</th><td className="mono">{hideValues ? '?' : hop.nextHopIp}{hop.toDevice ? ` (${n(hop.toDevice)})` : ''}</td></tr>}
                    {hop.outIfaceName && <tr><th scope="row">Outgoing interface</th><td className="mono">{hideValues ? '?' : hop.outIfaceName}</td></tr>}
                    {hop.layer === 3 && <tr><th scope="row">TTL</th><td>{hop.ttlIn === hop.ttlOut ? `${hop.ttlIn} (not changed here)` : `${hop.ttlIn} → ${hop.ttlOut}`}</td></tr>}
                    <tr><th scope="row">Next action</th><td><strong style={{ color: hop.action === 'drop' ? 'var(--fail)' : undefined }}>{({ drop: `DROP — ${hop.failure}`, receive: 'Received by destination', deliver: 'Deliver on connected network', forward: 'Forward to next hop', send: 'Send', 'arp-request': 'Broadcast ARP request, wait for reply', 'arp-reply': 'Send unicast ARP reply', 'arp-learn': 'Store in ARP cache, then send the packet', 'switch-forward': 'Forward frame out of one port', 'switch-flood': 'Flood frame out of all other ports', 'switch-filter': 'Filter (drop) frame' } as Record<string, string>)[hop.action] ?? hop.action}</strong></td></tr>
                  </tbody>
                </table>
              </div>
              {hop.nextHopIp && hop.action !== 'drop' && hop.layer === 3 && <p className="small muted">The next-hop address only tells this device which neighbour to hand the packet to. The destination IP in the packet stays {hop.dstIp} the whole way; only the Ethernet (MAC) addresses change at each hop.</p>}
            </div>
          )}
          {ev.dv && <DvCalcTable topo={topo} d={ev.dv} infinity={frame.state.dv?.infinity ?? 16} hide={hideValues} />}
          {ev.spf && frame.state.ls?.routers[ev.spf.router]?.spf && (
            <SpfTable topo={topo} spf={frame.state.ls.routers[ev.spf.router].spf!} step={ev.spf.step} />
          )}
          {ev.changes && ev.changes.length > 0 && (
            <details open={level === 'advanced' || ev.changes.length <= 4}>
              <summary>Routing table changes ({ev.changes.length})</summary>
              <ul className="small">{ev.changes.map((c, k) => <li key={k} className="mono">{hideValues ? `${n(c.router)}: ${c.key} ${c.kind}` : changeText(frame, c)}</li>)}</ul>
            </details>
          )}
          {level === 'advanced' && ev.detail && ev.detail.length > 0 && !ev.dv && (
            <details>
              <summary>Protocol details</summary>
              <ul className="small mono">{ev.detail.map((d, k) => <li key={k}>{d}</li>)}</ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

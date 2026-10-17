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
  hideValues: boolean;
  onUngate: () => void;
}

export function Explain({ frame, index, total, level, gated, hideValues, onUngate }: Props) {
  const ev = frame.ev;
  const cat = CATEGORY[ev.category];
  const topo = frame.state.topo;
  const n = (id: string) => deviceName(topo, id);
  const hop = ev.ping;
  return (
    <section className="card explain" aria-live="polite" aria-label="Explanation">
      <div className="card-head">
        <div className="row">
          <span className={`cat ${ev.category}`} aria-hidden><span>{cat.short}</span></span>
          <span className="small muted">{cat.label}</span>
        </div>
        <span className="small muted">Event {index + 1} of {total} · t = {ev.time}</span>
      </div>
      <h3>{ev.title}</h3>
      {gated ? (
        <div className="gate">
          <p><strong>Make your prediction first.</strong> The explanation is hidden in Teacher Mode until you answer the scenario's prediction question.</p>
          <button className="btn" onClick={onUngate}>Show explanation anyway</button>
        </div>
      ) : (
        <>
          <p className="lead">{ev.explain}</p>
          {hop && (
            <div className="stack">
              <div className="tbl-wrap">
                <table className="tbl">
                  <caption className="sr-only">Forwarding decision</caption>
                  <tbody>
                    <tr><th scope="row">Packet</th><td>ICMP echo {hop.phase} · source {hop.srcIp} → destination <strong className="mono">{hop.dstIp}</strong></td></tr>
                    {hop.candidates && <tr><th scope="row">Matching routes</th><td className="mono">{hop.candidates.length ? hop.candidates.map(routeKey).join(', ') : 'none'}</td></tr>}
                    {hop.candidates !== undefined && <tr><th scope="row">Selected route</th><td className="mono">{hop.chosen ? routeKey(hop.chosen) : '— (no match)'}</td></tr>}
                    <tr><th scope="row">Why</th><td>{hop.why}</td></tr>
                    {hop.nextHopIp && <tr><th scope="row">Next hop</th><td className="mono">{hideValues ? '?' : hop.nextHopIp}{hop.toDevice ? ` (${n(hop.toDevice)})` : ''}</td></tr>}
                    {hop.outIfaceName && <tr><th scope="row">Outgoing interface</th><td className="mono">{hideValues ? '?' : hop.outIfaceName}</td></tr>}
                    <tr><th scope="row">TTL</th><td>{hop.ttlIn === hop.ttlOut ? `${hop.ttlIn} (hosts do not change TTL)` : `${hop.ttlIn} → ${hop.ttlOut}`}</td></tr>
                    <tr><th scope="row">Next action</th><td><strong style={{ color: hop.action === 'drop' ? 'var(--fail)' : undefined }}>{hop.action === 'drop' ? `DROP — ${hop.failure}` : hop.action === 'receive' ? 'Received by destination' : hop.action === 'deliver' ? 'Deliver on connected network' : 'Forward to next hop'}</strong></td></tr>
                  </tbody>
                </table>
              </div>
              {hop.nextHopIp && hop.action !== 'drop' && <p className="small muted">The next-hop address only tells this device which neighbour to hand the packet to. The destination IP in the packet stays {hop.dstIp} the whole way.</p>}
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

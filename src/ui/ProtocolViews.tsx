import { useState } from 'react';
import { cidr } from '../model/ip';
import { deviceName, routerNeighbors } from '../model/topology';
import type { Topology } from '../model/types';
import { buildAdverts } from '../engine/dv';
import type { DvDetail, Frame, LsRouterState, SimState, SpfResult } from '../engine/types';

const inf = (m: number, i: number) => (m >= i ? '∞' : String(m));

export function DvCalcTable({ topo, d, infinity, hide }: { topo: Topology; d: DvDetail; infinity: number; hide?: boolean }) {
  const n = (id: string) => deviceName(topo, id);
  const decision: Record<string, string> = {
    new: 'ADD (new network)', better: 'REPLACE (better)', 'update-same': 'UPDATE (same next hop)', refresh: 'no change', worse: 'ignore (not better)', equal: 'ignore (equal)', connected: 'ignore (connected)', unreachable: 'ignore (unreachable)',
  };
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <caption className="sr-only">Distance vector calculation at {n(d.to)}</caption>
        <thead>
          <tr>
            <th>Destination</th>
            <th>{n(d.from)} advertises</th>
            <th>+ link cost</th>
            <th>= candidate</th>
            <th>{n(d.to)} had</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {d.rows.map((r) => (
            <tr key={r.key} className={['new', 'better', 'update-same'].includes(r.decision) ? 'changed' : ''}>
              <td className="mono">{r.key}</td>
              <td className="mono">{inf(r.advertised, infinity)}{d.adverts.find((a) => `${a.network}/${a.prefix}` === r.key)?.poisoned && <span className="badge del">POISON</span>}</td>
              <td className="mono">+ {r.linkCost}</td>
              <td className="mono">{hide ? '?' : `= ${inf(r.candidate, infinity)}`}</td>
              <td>{r.current}</td>
              <td><strong>{hide ? '?' : decision[r.decision]}</strong></td>
            </tr>
          ))}
          {d.omitted.map((k) => (
            <tr key={k}>
              <td className="mono">{k}</td>
              <td colSpan={5} className="muted">Not sent — split horizon (learned from {n(d.to)})</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DvRouterView({ state, router, frames, cursor }: { state: SimState; router: string; frames: Frame[]; cursor: number }) {
  const topo = state.topo;
  let last: Frame | undefined;
  for (let i = cursor; i >= 0; i--) if (frames[i].ev.dv?.to === router) { last = frames[i]; break; }
  const infinity = state.dv?.infinity ?? 16;
  return (
    <div className="stack">
      <h4>What {deviceName(topo, router)} would advertise now</h4>
      {routerNeighbors(topo, router).map((nb) => {
        const { adverts, omitted } = buildAdverts(state, router, nb.router, nb.key);
        return (
          <div key={nb.key} className="small">
            <strong>To {deviceName(topo, nb.router)}:</strong>{' '}
            <span className="mono">{adverts.map((a) => `${cidr(a.network, a.prefix)}=${inf(a.metric, infinity)}${a.poisoned ? '(poisoned)' : ''}`).join(', ') || '(nothing)'}</span>
            {omitted.length > 0 && <span className="muted"> · split horizon hides {omitted.join(', ')}</span>}
          </div>
        );
      })}
      <h4>Last update received</h4>
      {last ? (
        <>
          <div className="small muted">Event {frames.indexOf(last) + 1}: {last.ev.title}</div>
          <DvCalcTable topo={topo} d={last.ev.dv!} infinity={infinity} />
        </>
      ) : (
        <p className="muted small">None yet at this point of the timeline.</p>
      )}
    </div>
  );
}

export function SpfTable({ topo, spf, step }: { topo: Topology; spf: SpfResult; step: number }) {
  const n = (id: string) => deviceName(topo, id);
  const shown = spf.steps.slice(0, step);
  const cur = shown[shown.length - 1];
  const nodes = Object.keys(spf.dist).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const finished = step >= spf.steps.length;
  return (
    <div className="stack">
      {step === 0 && <p className="small">Start: only the root {n(spf.root)} is tentative, with cost 0.</p>}
      {cur && (
        <div className="small">
          <div><strong>Step {step}:</strong> selected <strong>{n(cur.selected)}</strong> (lowest tentative cost {cur.selectedDist}).</div>
          <div><strong>Confirmed set:</strong> {cur.confirmed.map(n).join(', ')}</div>
          <div><strong>Tentative:</strong> {Object.entries(cur.tentative).map(([k, v]) => `${n(k)}=${v.dist} (via ${v.pred ? n(v.pred) : '-'})`).join(', ') || 'none'}</div>
          <ul>
            {cur.relax.map((r, i) => (
              <li key={i} style={{ fontWeight: r.outcome === 'improved' ? 700 : undefined }}>{r.text}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="tbl-wrap">
        <table className="tbl">
          <caption className="sr-only">Shortest path tree</caption>
          <thead>
            <tr><th>Router</th><th>Cost</th><th>Predecessor</th><th>Status</th><th>Next hop (first router on path)</th></tr>
          </thead>
          <tbody>
            {nodes.map((node) => {
              const confirmedAt = spf.steps.findIndex((s) => s.selected === node);
              const confirmed = confirmedAt >= 0 && confirmedAt < step;
              const tentative = !confirmed && cur?.tentative[node];
              if (!confirmed && !tentative && !(step === 0 && node === spf.root)) return (
                <tr key={node}><td>{n(node)}</td><td className="muted">∞</td><td className="muted">-</td><td className="muted">unknown</td><td className="muted">-</td></tr>
              );
              const dist = confirmed ? spf.dist[node] : tentative ? tentative.dist : 0;
              const pred = confirmed ? spf.pred[node]?.node : tentative ? tentative.pred : null;
              return (
                <tr key={node} className={cur?.selected === node ? 'chosen' : ''}>
                  <td>{n(node)}{node === spf.root && ' (root)'}</td>
                  <td className="mono">{dist}</td>
                  <td>{pred ? n(pred) : '-'}</td>
                  <td>{confirmed ? '✔ confirmed' : '… tentative'}</td>
                  <td>{node === spf.root ? 'itself' : finished || confirmed ? (spf.firstHop[node] ? n(spf.firstHop[node].router) : '-') : '…'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LsRouterView({ state, router }: { state: SimState; router: string }) {
  const [tab, setTab] = useState<'nbr' | 'lsdb' | 'topo' | 'spf'>('spf');
  const topo = state.topo;
  const n = (id: string) => deviceName(topo, id);
  const st: LsRouterState | undefined = state.ls?.routers[router];
  if (!st) return <p className="muted">No link-state information.</p>;
  const view = state.spfView?.router === router ? state.spfView.step : st.spf?.steps.length ?? 0;
  const lsas = Object.values(st.lsdb).sort((a, b) => a.origin.localeCompare(b.origin, undefined, { numeric: true }));
  return (
    <div className="stack">
      <div className="tabs" role="tablist">
        {([['nbr', 'Neighbours'], ['lsdb', `LSDB (${lsas.length})`], ['topo', 'Topology view'], ['spf', 'SPF / Dijkstra']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'nbr' && (
        st.neighbors.length ? (
          <table className="tbl"><thead><tr><th>Neighbour</th><th>Address</th><th>Cost</th></tr></thead>
            <tbody>{st.neighbors.map((x) => <tr key={x.linkId}><td>{n(x.router)}</td><td className="mono">{x.remoteIp}</td><td>{x.cost}</td></tr>)}</tbody>
          </table>
        ) : <p className="muted small">No neighbours discovered yet.</p>
      )}
      {tab === 'lsdb' && (
        <div className="stack small">
          <p className="muted">Each LSA is an unchanged copy of one router's own description of its links.</p>
          {lsas.length === 0 && <p className="muted">Empty.</p>}
          {lsas.map((l) => (
            <div key={l.origin} className="card" style={{ padding: '0.4rem 0.6rem' }}>
              <strong>{n(l.origin)}</strong> <span className="pill">seq #{l.seq}</span>
              <div>Links: {l.links.map((x) => `${n(x.to)} (cost ${x.cost})`).join(', ') || 'none'}</div>
              <div className="mono">Networks: {l.stubs.map((x) => cidr(x.network, x.prefix)).join(', ')}</div>
            </div>
          ))}
        </div>
      )}
      {tab === 'topo' && (
        <div className="small">
          {st.spf ? (
            <>
              <p className="muted">The map {n(router)} built from its LSDB (links confirmed by both ends):</p>
              <ul>{st.spf.edges.map((e) => <li key={e.linkId}>{n(e.a)} — {n(e.b)}: cost {e.cost}</li>)}</ul>
            </>
          ) : <p className="muted">SPF has not run yet, so the map has not been built.</p>}
        </div>
      )}
      {tab === 'spf' && (st.spf ? <SpfTable topo={topo} spf={st.spf} step={view} /> : <p className="muted small">{n(router)} has not run SPF yet. Keep stepping.</p>)}
    </div>
  );
}

import { useState } from 'react';
import type { Level, Mode, SimOptions, Topology } from '../model/types';
import { deviceName, ifaceName } from '../model/topology';
import { routeKey, type Change, type Route } from '../engine/rib';
import { describeRoute } from '../engine/static';

export function Quiz({ hide, children }: { hide: boolean; children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  if (!hide || shown) return <>{children}</>;
  return (
    <button className="quiz" onClick={(e) => { e.stopPropagation(); setShown(true); }} aria-label="Hidden value, click to reveal">
      ?
    </button>
  );
}

export function sourceCode(r: Route, options: SimOptions) {
  if (r.source === 'connected') return { code: 'C', name: 'Connected' };
  if (r.source === 'static') return { code: r.prefix === 0 ? 'S*' : 'S', name: r.prefix === 0 ? 'Static default route' : 'Static' };
  if (r.source === 'dv') return options.dv.profile === 'rip' ? { code: 'R', name: 'RIP (hop count)' } : { code: 'D', name: 'Distance vector' };
  return { code: 'L', name: 'Link state (SPF)' };
}

interface Props {
  topo: Topology;
  router: string;
  table: Route[];
  mode: Mode;
  options: SimOptions;
  level: Level;
  changes: Change[];
  hideValues: boolean;
  selectedKey: string | null;
  onSelectKey?: (k: string | null) => void;
  matchKeys?: string[];
  chosenKey?: string | null;
  infinity?: number;
}

export function RouteTable(p: Props) {
  const changed = new Map(p.changes.filter((c) => c.router === p.router).map((c) => [c.key, c]));
  const removed = p.changes.filter((c) => c.router === p.router && c.kind === 'removed').map((c) => c.before!);
  const rows = [...p.table, ...removed];
  const adv = p.level === 'advanced';
  const showMetric = p.mode !== 'static';
  const sel = rows.find((r) => routeKey(r) === p.selectedKey);
  return (
    <div className="stack">
      <div className="tbl-wrap">
        <table className="tbl">
          <caption className="sr-only">Routing table of {deviceName(p.topo, p.router)}</caption>
          <thead>
            <tr>
              <th scope="col" title="Where the route came from">Src</th>
              <th scope="col">Destination network</th>
              <th scope="col">Next hop</th>
              <th scope="col">Out interface</th>
              {showMetric && <th scope="col">{p.mode === 'dv' && p.options.dv.profile === 'rip' ? 'Hops' : 'Cost'}</th>}
              {adv && <th scope="col" title="Administrative distance">AD</th>}
              {p.mode !== 'static' && <th scope="col">Learned from</th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="muted">Empty table — this router knows no networks.</td></tr>
            )}
            {rows.map((r) => {
              const k = routeKey(r);
              const c = changed.get(k);
              const isRemoved = c?.kind === 'removed' && !p.table.includes(r);
              const src = sourceCode(r, p.options);
              const cls = [
                isRemoved ? 'removed' : c ? 'changed' : '',
                p.chosenKey === k ? 'chosen' : p.matchKeys?.includes(k) ? 'match' : '',
                r.unreachable ? 'unreach' : '',
                p.onSelectKey ? 'clickable' : '',
                p.selectedKey === k ? 'sel' : '',
              ].join(' ');
              return (
                <tr key={k + (isRemoved ? '-old' : '')} className={cls} onClick={() => p.onSelectKey?.(p.selectedKey === k ? null : k)} tabIndex={p.onSelectKey ? 0 : undefined}
                  onKeyDown={(e) => { if (e.key === 'Enter') p.onSelectKey?.(p.selectedKey === k ? null : k); }}>
                  <td><span className="src" title={src.name}>{src.code}</span></td>
                  <td className="mono">
                    {k}
                    {c && <span className={`badge ${c.kind === 'added' ? 'new' : c.kind === 'removed' ? 'del' : 'chg'}`}>{c.kind === 'added' ? 'NEW' : c.kind === 'removed' ? 'REMOVED' : 'CHANGED'}</span>}
                    {p.chosenKey === k && <span className="badge new">SELECTED</span>}
                  </td>
                  <td className="mono">
                    <Quiz hide={p.hideValues && r.source !== 'connected'}>
                      {r.source === 'connected' ? 'directly connected' : r.nextHop ?? '—'}
                      {adv && r.resolvedVia && r.resolvedVia !== r.nextHop && <div className="muted small">via {r.resolvedVia}</div>}
                    </Quiz>
                  </td>
                  <td className="mono"><Quiz hide={p.hideValues && r.source !== 'connected'}>{ifaceName(p.topo, p.router, r.iface)}</Quiz></td>
                  {showMetric && (
                    <td className="mono">
                      <Quiz hide={p.hideValues && r.source !== 'connected'}>{r.unreachable ? `∞ (${p.infinity ?? '∞'})` : r.metric}</Quiz>
                      {c?.kind === 'changed' && c.before && (c.before.metric !== r.metric || !!c.before.unreachable !== !!r.unreachable) && (
                        <div className="muted small">was {c.before.unreachable ? '∞' : c.before.metric}</div>
                      )}
                    </td>
                  )}
                  {adv && <td>{r.ad}</td>}
                  {p.mode !== 'static' && <td>{r.learnedFrom ? deviceName(p.topo, r.learnedFrom) : r.source === 'connected' ? 'own interface' : '—'}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sel && (
        <div className="banner info small">
          <div>
            <strong>In plain English: </strong>
            {describeRoute(p.topo, p.router, sel)}
            {sel.note && p.level === 'advanced' && <div className="muted">{sel.note}</div>}
          </div>
        </div>
      )}
      <div className="muted small">
        Src codes: C connected · S static (S* default) · {p.mode === 'dv' ? (p.options.dv.profile === 'rip' ? 'R RIP' : 'D distance vector') : p.mode === 'ls' ? 'L link state' : 'D/L dynamic'}. Click a row for an explanation and to highlight its path. Yellow rows changed in the current event.
      </div>
    </div>
  );
}

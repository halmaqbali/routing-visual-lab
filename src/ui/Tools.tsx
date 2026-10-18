import { useEffect, useState } from 'react';
import { isValidIp } from '../model/ip';
import { isLoopback } from '../model/topology';
import type { Topology } from '../model/types';
import type { Note, NoteShade } from '../lab/lab';

export interface PingForm {
  src: string;
  srcIp: string; // '' = automatic (outgoing interface)
  dstIp: string;
}

/** All pingable addresses: PCs and every router interface, including loopbacks. */
export function addressList(topo: Topology) {
  const out: { ip: string; label: string; dev: string }[] = [];
  for (const d of topo.devices) {
    if (d.kind === 'switch') continue;
    for (const i of d.ifaces) if (i.ip) out.push({ ip: i.ip, dev: d.id, label: d.kind === 'pc' ? `${d.name} — ${i.ip}` : `${d.name} ${isLoopback(i) ? i.name : i.name} — ${i.ip}` });
  }
  return out;
}

export function PingTool({ topo, form, setForm, count, setCount, running, onRun, onStop, stats }: {
  topo: Topology; form: PingForm; setForm: (f: PingForm) => void; count: number; setCount: (n: number) => void;
  running: { total: number } | null; onRun: () => void; onStop: () => void; stats: { sent: number; received: number } | null;
}) {
  const sources = topo.devices.filter((d) => d.kind !== 'switch');
  const src = topo.devices.find((d) => d.id === form.src);
  const addrs = addressList(topo);
  const known = addrs.some((a) => a.ip === form.dstIp);
  const [custom, setCustom] = useState(!known && !!form.dstIp);
  useEffect(() => { if (known) setCustom(false); }, [known]);
  const badIp = custom && form.dstIp !== '' && !isValidIp(form.dstIp);
  const srcIps = src?.kind === 'router' ? src.ifaces.filter((i) => i.ip) : [];
  return (
    <div className="ping-tool">
      <div className="row">
        <strong>Ping</strong>
        <label>from
          <select value={form.src} onChange={(e) => setForm({ ...form, src: e.target.value, srcIp: '' })} aria-label="Source device" disabled={!!running}>
            {sources.map((d) => <option key={d.id} value={d.id}>{d.name}{d.kind === 'router' ? ' (router)' : ''}</option>)}
          </select>
        </label>
        {src?.kind === 'router' && (
          <label>source
            <select value={form.srcIp} onChange={(e) => setForm({ ...form, srcIp: e.target.value })} aria-label="Source address" disabled={!!running}>
              <option value="">auto (outgoing interface)</option>
              {srcIps.map((i) => <option key={i.id} value={i.ip}>{i.name} — {i.ip}</option>)}
            </select>
          </label>
        )}
        <label>to
          <select value={custom ? '__custom' : form.dstIp} aria-label="Destination address" disabled={!!running}
            onChange={(e) => { if (e.target.value === '__custom') { setCustom(true); setForm({ ...form, dstIp: '' }); } else { setCustom(false); setForm({ ...form, dstIp: e.target.value }); } }}>
            {!known && !custom && <option value={form.dstIp}>choose…</option>}
            {addrs.map((a) => <option key={`${a.dev}-${a.ip}`} value={a.ip}>{a.label}</option>)}
            <option value="__custom">Type an IP address…</option>
          </select>
        </label>
        {custom && <input type="text" value={form.dstIp} placeholder="e.g. 10.0.3.3" aria-label="Destination IP address" className={badIp ? 'bad' : ''} onChange={(e) => setForm({ ...form, dstIp: e.target.value.trim() })} style={{ width: '9rem' }} />}
        <label>count
          <select value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Number of pings" disabled={!!running}>
            <option value={1}>1</option>
            <option value={3}>3</option>
            <option value={0}>∞ (until Stop)</option>
          </select>
        </label>
        {running ? (
          <button className="btn danger" onClick={onStop}>■ Stop ping</button>
        ) : (
          <button className="btn primary" onClick={onRun} disabled={!src || !form.dstIp || badIp}>✉ Run ping</button>
        )}
        {stats && (
          <span className="pill" aria-live="polite">
            {running ? (running.total === Infinity ? `Sent ${stats.sent}` : `Sent ${stats.sent} of ${running.total}`) : `Last run: sent ${stats.sent}`} · received {stats.received} · lost {stats.sent - stats.received}
          </span>
        )}
      </div>
      {badIp && <p className="issue error">"{form.dstIp}" is not a valid IPv4 address.</p>}
      <div className="small muted">
        A ping is an ICMP echo request plus an echo reply; it succeeds only if BOTH arrive. Devices use ARP first when they do not know a neighbour's MAC address. Routers can ping any address, including loopbacks.
      </div>
    </div>
  );
}

const SHADES: { id: NoteShade; label: string }[] = [
  { id: 'white', label: 'White' },
  { id: 'light', label: 'Light grey' },
  { id: 'mid', label: 'Mid grey' },
  { id: 'dark', label: 'Dark' },
];

export function NotePanel({ note, topo, onChange, onDuplicate, onDelete }: {
  note: Note; topo: Topology; onChange: (n: Note) => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const [title, setTitle] = useState(note.title ?? '');
  const [text, setText] = useState(note.text);
  useEffect(() => {
    setTitle(note.title ?? '');
    setText(note.text);
  }, [note.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (patch: Partial<Note>) => onChange({ ...note, ...patch });
  return (
    <div className="card stack" data-note-editor>
      <div className="card-head"><h2>Canvas note</h2>{note.locked && <span className="pill">🔒 locked</span>}</div>
      <label className="stack-label">Title (optional)
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== (note.title ?? '') && commit({ title: title || undefined })} maxLength={120} />
      </label>
      <label className="stack-label">Text
        <textarea id="note-text" rows={7} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== note.text && commit({ text })} />
      </label>
      <p className="small muted">Formatting: <code>**bold**</code>, start a line with <code>- </code> for a bullet, press Enter for a new line. Changes are saved when you leave the field.</p>
      <div className="row">
        <span className="small">Shade:</span>
        {SHADES.map((s) => (
          <button key={s.id} className={`btn small swatch shade-${s.id}`} aria-pressed={note.shade === s.id} onClick={() => commit({ shade: s.id })} title={s.label}>{s.label}</button>
        ))}
      </div>
      <label>Arrow to device
        <select value={note.arrowTo ?? ''} onChange={(e) => commit({ arrowTo: e.target.value || undefined })}>
          <option value="">none</option>
          {topo.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      <div className="row">
        <button className="btn" aria-pressed={!!note.locked} onClick={() => commit({ locked: !note.locked || undefined })}>{note.locked ? '🔓 Unlock' : '🔒 Lock position'}</button>
        <button className="btn" onClick={onDuplicate}>Duplicate</button>
        <button className="btn danger" onClick={onDelete}>Delete note</button>
      </div>
      <p className="small muted">Drag the note to move it; drag its bottom-right corner to resize. Notes are saved with the lab and included when you share it.</p>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { makeExercise, safeFileName, serializeLab, type Lab } from '../lab/lab';
import type { LabLibrary, LabMeta } from '../lab/library';
import { QR_MAX_CHARS, shareLink } from '../lab/share';
import { isLoopback } from '../model/topology';
import { runPing } from '../engine/ping';
import { emptyL2 } from '../engine/l2';
import type { SimState } from '../engine/types';

export function downloadLab(lab: Lab) {
  const blob = new Blob([serializeLab(lab)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeFileName(lab.name)}.rvlab.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, button, select, textarea')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label={title} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} ref={ref}>
        <div className="card-head"><h2>{title}</h2><button className="btn" onClick={onClose} aria-label="Close dialog">✕</button></div>
        {children}
      </div>
    </div>
  );
}

export function NameDialog({ title, initial, action, onSubmit, onClose }: { title: string; initial: string; action: string; onSubmit: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim()); }}>
        <label className="stack-label">Lab name<input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>
        <div className="row"><button className="btn primary" type="submit" disabled={!name.trim()}>{action}</button><button className="btn" type="button" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}

export function OpenLabDialog({ library, currentId, onOpen, onImport, onClose }: {
  library: LabLibrary; currentId: string; onOpen: (lab: Lab) => void; onImport: (file: File) => void; onClose: () => void;
}) {
  const [list, setList] = useState<LabMeta[]>(() => library.list());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => setList(library.list());
  return (
    <Modal title="Open lab" onClose={onClose} wide>
      <div className="row" style={{ marginBottom: '0.6rem' }}>
        <button className="btn primary" onClick={() => fileRef.current?.click()}>⬆ Import lab file…</button>
        <span className="small muted">Open a .json lab file from your computer (for example one your instructor sent you).</span>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ''; }} />
      </div>
      <h3>Saved labs in this browser</h3>
      {list.length === 0 && <p className="muted">No saved labs yet. Use <strong>Save Lab</strong> to keep your work here.</p>}
      <ul className="lab-list">
        {list.map((m) => (
          <li key={m.id} className={m.id === currentId ? 'current' : ''}>
            {renaming === m.id ? (
              <form className="row grow" onSubmit={(e) => { e.preventDefault(); library.rename(m.id, newName); setRenaming(null); refresh(); }}>
                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="New name" autoFocus maxLength={120} />
                <button className="btn small primary" type="submit" disabled={!newName.trim()}>Rename</button>
                <button className="btn small" type="button" onClick={() => setRenaming(null)}>Cancel</button>
              </form>
            ) : (
              <div className="grow">
                <strong>{m.name}</strong> {m.id === currentId && <span className="pill">open now</span>} {m.exercise && <span className="pill">exercise</span>}
                <div className="small muted">{m.devices} devices · {m.notes} notes · saved {new Date(m.updatedAt).toLocaleString()}</div>
              </div>
            )}
            {renaming !== m.id && (
              <div className="row">
                <button className="btn small primary" onClick={() => { const lab = library.load(m.id); if (lab) onOpen(lab); }}>Open</button>
                <button className="btn small" onClick={() => { setRenaming(m.id); setNewName(m.name); }}>Rename</button>
                <button className="btn small" onClick={() => { library.duplicate(m.id); refresh(); }}>Duplicate</button>
                <button className="btn small" onClick={() => { const lab = library.load(m.id); if (lab) downloadLab(lab); }}>Export</button>
                {confirmDelete === m.id ? (
                  <>
                    <button className="btn small danger" onClick={() => { library.delete(m.id); setConfirmDelete(null); refresh(); }}>Delete permanently</button>
                    <button className="btn small" onClick={() => setConfirmDelete(null)}>Keep</button>
                  </>
                ) : <button className="btn small danger" onClick={() => setConfirmDelete(m.id)}>Delete</button>}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="small muted">Saved labs are stored in this browser only. To move a lab to another computer, use Export or Share Lab.</p>
    </Modal>
  );
}

function QR({ text }: { text: string }) {
  const cells = useMemo(() => {
    try {
      const q = qrcode(0, 'L');
      q.addData(text, 'Byte');
      q.make();
      const c = q.getModuleCount();
      const rects: string[] = [];
      for (let r = 0; r < c; r++) for (let col = 0; col < c; col++) if (q.isDark(r, col)) rects.push(`M${col + 4} ${r + 4}h1v1h-1z`);
      return { size: c + 8, d: rects.join('') };
    } catch {
      return null;
    }
  }, [text]);
  if (!cells) return <p className="small muted">This link is too long for a QR code. Share the link or the lab file instead.</p>;
  return (
    <svg className="qr" viewBox={`0 0 ${cells.size} ${cells.size}`} role="img" aria-label="QR code for the share link" shapeRendering="crispEdges">
      <rect width={cells.size} height={cells.size} fill="#fff" />
      <path d={cells.d} fill="#000" />
    </svg>
  );
}

export function ShareDialog({ lab, onClose }: { lab: Lab; onClose: () => void }) {
  const [asExercise, setAsExercise] = useState(false);
  const [strip, setStrip] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const shared = () => (asExercise ? makeExercise(lab, { stripStaticRoutes: strip, instructions }) : lab);
  const base = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : '';
  useEffect(() => { setLink(''); setCopied(false); }, [asExercise, strip, instructions]);
  const makeLink = async () => {
    setBusy(true);
    setError('');
    try {
      setLink(await shareLink(shared(), base));
    } catch {
      setError('Could not create the link in this browser. Download the lab file instead.');
    }
    setBusy(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError('Copy was blocked by the browser. Select the link text and copy it manually.');
    }
  };
  const staticCount = lab.topo.devices.reduce((n, d) => n + d.staticRoutes.length, 0);
  return (
    <Modal title="Share lab" onClose={onClose} wide>
      <fieldset className="stack">
        <legend className="small muted">What do you want to share?</legend>
        <label><input type="radio" checked={!asExercise} onChange={() => setAsExercise(false)} /> <strong>The lab as it is</strong> — the complete configuration, notes and settings.</label>
        <label><input type="radio" checked={asExercise} onChange={() => setAsExercise(true)} /> <strong>An exercise for students</strong> — opens in Student Exercise Mode with a <em>Reset Lab</em> button that restores this starting point.</label>
        {asExercise && (
          <div className="card inset stack">
            <label><input type="checkbox" checked={strip} onChange={(e) => setStrip(e.target.checked)} /> Remove all static routes ({staticCount}) so students configure routing themselves</label>
            <label className="stack-label">Instructions shown to students (optional)
              <textarea rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Configure static routes so PC1 can ping PC2. Explain why R2 needs a route back." />
            </label>
            <p className="small muted">Your own copy is not changed. The students' starting configuration is stored inside their copy and is never edited, so <em>Reset Lab</em> always returns to it.</p>
          </div>
        )}
      </fieldset>

      <h3>Option 1 — Lab file (works everywhere)</h3>
      <p className="small">Download a <code>.json</code> file and send it by email or put it on your learning platform. Students open it with <strong>Open Lab → Import lab file</strong>.</p>
      <button className="btn primary" onClick={() => downloadLab(shared())}>⬇ Download lab file</button>

      <h3>Option 2 — Share link</h3>
      <p className="small">The whole lab is compressed <strong>inside the link</strong> (after the #). No server stores it, and nothing is uploaded: anyone who opens the link gets an exact copy in their own browser, on any computer. Very large labs make very long links.</p>
      {!link ? (
        <button className="btn" onClick={makeLink} disabled={busy}>{busy ? 'Creating…' : '🔗 Create share link'}</button>
      ) : (
        <div className="stack">
          <div className="row">
            <input type="text" readOnly value={link} className="grow mono" aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
            <button className="btn primary" onClick={copy}>{copied ? '✔ Copied' : 'Copy link'}</button>
          </div>
          <p className="small muted">Link length: {link.length.toLocaleString()} characters.</p>
          <h4>QR code</h4>
          {link.length <= QR_MAX_CHARS ? <QR text={link} /> : <p className="small muted">This lab is too large for a QR code ({link.length.toLocaleString()} characters; the limit is about {QR_MAX_CHARS.toLocaleString()}). Share the link or the file instead.</p>}
        </div>
      )}
      {error && <p className="issue error">{error}</p>}
    </Modal>
  );
}

export function ConnectivityCheck({ state, onClose }: { state: SimState; onClose: () => void }) {
  // Test endpoints: every PC, and every router loopback (pinged from that loopback address).
  const ends = state.topo.devices.flatMap((d) =>
    d.kind === 'pc' ? (d.ifaces[0]?.ip ? [{ dev: d.id, ip: d.ifaces[0].ip, label: d.name, loop: false }] : [])
      : d.kind === 'router' ? d.ifaces.filter((i) => isLoopback(i) && i.ip).map((i) => ({ dev: d.id, ip: i.ip, label: `${d.name} ${i.name}`, loop: true })) : []);
  const results = useMemo(
    () => ends.flatMap((a) => ends.filter((b) => b.dev !== a.dev).map((b) => ({ a, b, r: runPing(state.topo, state.tables, emptyL2(), { src: a.dev, srcIp: a.loop ? a.ip : undefined, dstIp: b.ip }, state.options.ttl) }))),
    [state], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const ok = results.filter((x) => x.r.success).length;
  return (
    <Modal title="Check my work: connectivity" onClose={onClose}>
      {ends.length < 2 ? <p>This lab needs at least two PCs or router loopbacks with addresses to check connectivity.</p> : (
        <>
          <p><strong>{ok} of {results.length}</strong> pings succeed with the current routing tables (PCs, and router loopbacks pinging from their loopback address).</p>
          <table className="tbl">
            <thead><tr><th>From</th><th>To</th><th>Result</th></tr></thead>
            <tbody>
              {results.map(({ a, b, r }) => (
                <tr key={`${a.dev}-${a.ip}-${b.ip}`} className={r.success ? '' : 'unreach'}>
                  <td>{a.label}</td><td>{b.label} ({b.ip})</td>
                  <td>{r.success ? '✔ reply received' : `✕ ${r.outcomeText}${r.failure ? ` — ${r.failure.code}` : ''}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">Use Run ping to see exactly where a failing ping is dropped. In distance-vector and link-state modes this checks the tables at the current event.</p>
        </>
      )}
    </Modal>
  );
}

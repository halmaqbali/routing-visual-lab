// App shell pieces from the redesign: stroke icons, an accessible dropdown menu and the ping popover.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isValidIp } from '../model/ip';
import type { Topology } from '../model/types';
import { addressList, type PingForm } from './Tools';

const P: Record<string, ReactNode> = {
  select: <path d="M5 3l11 6-5 1.5L8.5 16z" fill="currentColor" stroke="none" />,
  router: <><circle cx="10" cy="10" r="8" /><path d="M5 8h5M5 8l2-2M5 8l2 2M15 12h-5M15 12l-2-2M15 12l-2 2" /></>,
  pc: <><rect x="3" y="4" width="14" height="9" rx="1.5" /><path d="M7 17h6M10 13v4" /></>,
  switch: <><rect x="1.5" y="5" width="17" height="10" rx="2" /><path d="M5 8.5h9M14 8.5l-2-1.5M15 11.5H6M6 11.5l2 1.5" /></>,
  cable: <><circle cx="4" cy="16" r="2" /><circle cx="16" cy="4" r="2" /><path d="M5.5 14.5l9-9" /></>,
  note: <><path d="M4 3h12v9l-5 5H4z" /><path d="M11 17v-5h5" /></>,
  undo: <><path d="M6 4L3 7l3 3" /><path d="M3 7h9a4.5 4.5 0 010 9H8" /></>,
  redo: <><path d="M14 4l3 3-3 3" /><path d="M17 7H8a4.5 4.5 0 000 9h4" /></>,
  trash: <path d="M4 5h12M8 5V3h4v2M5.5 5l.8 12h7.4l.8-12" />,
  ping: <><rect x="2.5" y="5" width="15" height="10" rx="1.8" /><path d="M2.5 5l7.5 6 7.5-6" /></>,
  share: <path d="M10 13V3M6.5 6.5L10 3l3.5 3.5M4 11v6h12v-6" />,
  more: <><circle cx="4" cy="10" r="1.6" fill="currentColor" stroke="none" /><circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none" /><circle cx="16" cy="10" r="1.6" fill="currentColor" stroke="none" /></>,
  prev: <path d="M4 4h2.5v12H4zM16 4v12L8 10z" fill="currentColor" stroke="none" />,
  next: <path d="M13.5 4H16v12h-2.5zM4 4v12l8-6z" fill="currentColor" stroke="none" />,
  play: <path d="M5 3l12 7-12 7z" fill="currentColor" stroke="none" />,
  pause: <path d="M4 3h4v14H4zM12 3h4v14h-4z" fill="currentColor" stroke="none" />,
  end: <path d="M3 4v12l7-6zM10 4v12l7-6z" fill="currentColor" stroke="none" />,
  reset: <><path d="M4 10a6 6 0 106-6H7" /><path d="M9 1.5L6.5 4 9 6.5" /></>,
  fit: <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" />,
  plus: <path d="M10 4v12M4 10h12" />,
  minus: <path d="M4 10h12" />,
  chevron: <path d="M5 8l5 5 5-5" />,
  close: <path d="M5 5l10 10M15 5L5 15" />,
  present: <><rect x="2" y="3" width="16" height="11" rx="1.5" /><path d="M7 18h6M10 14v4" /></>,
  steps: <path d="M4 5h12M4 10h12M4 15h8" />,
  table: <><rect x="3" y="3" width="14" height="14" rx="2" /><path d="M3 8h14M3 13h14M9 3v14" /></>,
  book: <path d="M3 4h5.5A2.5 2.5 0 0111 6.5V17a2 2 0 00-2-2H3zM17 4h-5.5A2.5 2.5 0 009 6.5V17a2 2 0 012-2h6z" />,
  settings: <><circle cx="10" cy="10" r="2.6" /><path d="M10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18M4.3 4.3l1.8 1.8M13.9 13.9l1.8 1.8M4.3 15.7l1.8-1.8M13.9 6.1l1.8-1.8" /></>,
  network: <><circle cx="4.5" cy="10" r="2.5" /><circle cx="15.5" cy="4.5" r="2.5" /><circle cx="15.5" cy="15.5" r="2.5" /><path d="M7 9l6-3.5M7 11l6 3.5" /></>,
  warn: <><path d="M10 3l8 14H2z" /><path d="M10 8v4M10 14.5v.5" /></>,
  panel: <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="M12.5 3.5v13" /></>,
};

export function Icon({ name, size = 18, label }: { name: keyof typeof P | string; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      {P[name]}
    </svg>
  );
}

export interface MenuItem {
  label?: string;
  onSelect?: () => void;
  checked?: boolean;
  hint?: string;
  separator?: boolean;
  heading?: string;
  disabled?: boolean;
}

/** Dropdown menu: button with aria-haspopup, arrow-key navigation, Esc and click-outside to close. */
export function MenuButton({ items, ariaLabel, className, children, align = 'right' }: {
  items: MenuItem[]; ariaLabel?: string; className?: string; children: ReactNode; align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); (ref.current?.querySelector('[aria-haspopup]') as HTMLElement | null)?.focus(); }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    requestAnimationFrame(() => (ref.current?.querySelector('[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]') as HTMLElement | null)?.focus());
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const move = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  };
  return (
    <div className="menu-wrap" ref={ref}>
      <button className={className ?? 'hbtn'} aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen(!open)}>{children}</button>
      {open && (
        <div className={`menu ${align}`} role="menu" onKeyDown={move}>
          {items.map((it, k) =>
            it.separator ? <div key={k} className="menu-sep" role="separator" /> :
            it.heading ? <div key={k} className="menu-heading">{it.heading}</div> : (
              <button key={k} role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={it.checked} disabled={it.disabled}
                onClick={() => { setOpen(false); it.onSelect?.(); }}>
                <span className="menu-check" aria-hidden>{it.checked ? '✓' : ''}</span>
                <span className="menu-label">{it.label}</span>
                {it.hint && <span className="menu-hint">{it.hint}</span>}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** The ping form from the redesign: From, (source address), To, how many, Send. */
export function PingPopover({ topo, form, setForm, count, setCount, onRun, onClose, onClearL2, l2Text, sheet }: {
  topo: Topology; form: PingForm; setForm: (f: PingForm) => void; count: number; setCount: (n: number) => void;
  onRun: () => void; onClose: () => void; onClearL2: () => void; l2Text: string; sheet?: boolean;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const sources = topo.devices.filter((d) => d.kind !== 'switch');
  const src = topo.devices.find((d) => d.id === form.src);
  const addrs = addressList(topo).filter((a) => a.dev !== form.src);
  const known = addrs.some((a) => a.ip === form.dstIp);
  const [custom, setCustom] = useState(!known && !!form.dstIp);
  const [advanced, setAdvanced] = useState(!!form.srcIp);
  const badIp = custom && form.dstIp !== '' && !isValidIp(form.dstIp);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest('[data-ping-trigger]')) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('select')?.focus();
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const dstName = topo.devices.find((d) => d.ifaces.some((i) => i.ip === form.dstIp))?.name ?? form.dstIp;
  return (
    <form ref={ref} className={`ping-pop ${sheet ? 'sheet' : ''}`} aria-label="Ping" onSubmit={(e) => { e.preventDefault(); if (!badIp && form.src && form.dstIp) { onRun(); onClose(); } }}>
      <div className="pp-head">
        <h2>Ping</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
      <label className="pp-field">From
        <select value={form.src} onChange={(e) => setForm({ ...form, src: e.target.value, srcIp: '' })}>
          {sources.map((d) => <option key={d.id} value={d.id}>{d.name}{d.kind === 'router' ? ' — router' : d.ifaces[0]?.ip ? ` — ${d.ifaces[0].ip}` : ''}</option>)}
        </select>
      </label>
      <label className="pp-field">To
        <select value={custom ? '__custom' : form.dstIp} onChange={(e) => { if (e.target.value === '__custom') { setCustom(true); setForm({ ...form, dstIp: '' }); } else { setCustom(false); setForm({ ...form, dstIp: e.target.value }); } }}>
          {!known && !custom && <option value={form.dstIp}>Choose a destination…</option>}
          {addrs.map((a) => <option key={`${a.dev}-${a.ip}`} value={a.ip}>{a.label}</option>)}
          <option value="__custom">Type an IP address…</option>
        </select>
      </label>
      {custom && (
        <label className="pp-field">IP address
          <input type="text" value={form.dstIp} placeholder="e.g. 10.0.3.3" className={badIp ? 'bad' : ''} onChange={(e) => setForm({ ...form, dstIp: e.target.value.trim() })} />
        </label>
      )}
      {badIp && <p className="issue error">"{form.dstIp}" is not a valid IPv4 address.</p>}
      <fieldset className="pp-field">
        <legend>How many</legend>
        <div className="segm">
          {([[1, '1'], [3, '3'], [0, '∞ Continuous']] as const).map(([n, l]) => (
            <button key={n} type="button" aria-pressed={count === n} onClick={() => setCount(n)}>{l}</button>
          ))}
        </div>
      </fieldset>
      {count === 0 && <p className="pp-note">Keeps pinging until you press <strong>Stop</strong>. Tip: raise the speed to 2× or 4× to see many pings quickly.</p>}
      {advanced && src?.kind === 'router' && (
        <label className="pp-field">Source address
          <select value={form.srcIp} onChange={(e) => setForm({ ...form, srcIp: e.target.value })}>
            <option value="">Automatic (outgoing interface)</option>
            {src.ifaces.filter((i) => i.ip).map((i) => <option key={i.id} value={i.ip}>{i.name} — {i.ip}</option>)}
          </select>
        </label>
      )}
      <p className="pp-note">A ping succeeds only if the request reaches {dstName || 'the destination'} <em>and</em> the reply gets back. Devices that don’t know a neighbour’s MAC address use ARP first.</p>
      <button type="submit" className="pp-send" disabled={!form.src || !form.dstIp || badIp}><Icon name="ping" size={18} /> Send ping</button>
      <div className="pp-links">
        {src?.kind === 'router' && !advanced && <button type="button" className="link-btn" onClick={() => setAdvanced(true)}>Choose a source address</button>}
        <button type="button" className="link-btn" onClick={onClearL2} title="Empty every ARP cache and switch MAC table">Clear ARP &amp; MAC tables</button>
      </div>
      <p className="pp-note small">{l2Text}</p>
    </form>
  );
}

import { useEffect, useRef } from 'react';
import type { Frame } from '../engine/types';
import { CATEGORY } from './Explain';

interface ControlsProps {
  cursor: number;
  total: number;
  playing: boolean;
  speed: number;
  playDisabled: boolean;
  canAdvance: boolean;
  endDisabled: boolean;
  onPlay: () => void;
  onPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
  onEnd: () => void;
  onSpeed: (s: number) => void;
}

export function Controls(p: ControlsProps) {
  return (
    <div className="controls" role="toolbar" aria-label="Simulation controls">
      {p.playing ? (
        <button className="btn primary" onClick={p.onPause} aria-label="Pause (Space)">❚❚ Pause</button>
      ) : (
        <button className="btn primary" onClick={p.onPlay} disabled={p.playDisabled || !p.canAdvance} aria-label="Play (Space)" title={p.playDisabled ? 'Teacher Mode: reveal one event at a time' : 'Play (Space)'}>▶ Play</button>
      )}
      <button className="btn" onClick={p.onPrev} disabled={p.cursor <= 0} aria-label="Previous event (Left arrow)" title="Previous event (←)">⏮ Prev</button>
      <button className="btn" onClick={p.onNext} disabled={!p.canAdvance} aria-label="Next event (Right arrow)" title="Next event (→)">Next ⏭</button>
      <button className="btn" onClick={p.onEnd} disabled={p.cursor >= p.total - 1 || p.playDisabled || p.endDisabled} title="Jump to the last event (End)">⏩ End</button>
      <button className="btn" onClick={p.onReset} title="Restart the simulation from the current configuration (Home)">↺ Reset</button>
      <label className="small">
        Speed
        <select value={p.speed} onChange={(e) => p.onSpeed(Number(e.target.value))} aria-label="Playback speed">
          {[0.25, 0.5, 1, 2, 4].map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
      </label>
      <span className="pos" aria-live="polite">Event {p.cursor + 1} / {p.total}</span>
    </div>
  );
}

const WINDOW = 120;

export function Timeline({ frames, cursor, onJump, hideFuture, actions, collapsed, fill }: {
  frames: Frame[]; cursor: number; onJump: (i: number) => void; hideFuture: boolean; actions?: React.ReactNode; collapsed?: boolean; fill?: boolean;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Scroll only the timeline list, never the page (on phones the page would jump down to the timeline).
    const item = ref.current;
    const list = listRef.current;
    if (!item || !list) return;
    const top = item.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + item.offsetHeight - list.clientHeight;
  }, [cursor]);
  const from = Math.max(0, cursor - WINDOW);
  const to = hideFuture ? cursor + 1 : Math.min(frames.length, cursor + WINDOW);
  return (
    <section className={`card ${fill ? 'panel' : ''}`} aria-label="Event timeline panel">
      <div className="card-head"><h2>Event timeline</h2><span className="row"><span className="small muted">{frames.length} events</span>{actions}</span></div>
      {!collapsed && <div className="timeline" ref={listRef} tabIndex={0} aria-label="Event timeline">
        {from > 0 && <div className="small muted" style={{ padding: '0.3rem' }}>… {from} earlier events</div>}
        <ol>
          {frames.slice(from, to).map((f, k) => {
            const i = from + k;
            return (
              <li key={i} ref={i === cursor ? ref : undefined} className={i === cursor ? 'current' : i > cursor ? 'future' : ''}>
                <button onClick={() => onJump(i)} aria-current={i === cursor ? 'step' : undefined} aria-label={`Event ${i + 1}: ${CATEGORY[f.ev.category].label}: ${f.ev.title}`}>
                  <span className="t">t={f.ev.time}</span>
                  <span className={`cat ${f.ev.category}`} aria-hidden><span>{CATEGORY[f.ev.category].short}</span></span>
                  <span>{f.ev.title}</span>
                </button>
              </li>
            );
          })}
        </ol>
        {to < frames.length && <div className="small muted" style={{ padding: '0.3rem' }}>{hideFuture ? 'Future events hidden (Teacher Mode)' : `… ${frames.length - to} more events`}</div>}
      </div>}
    </section>
  );
}

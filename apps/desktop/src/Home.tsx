import type { Engine } from '@jle/engine';
import { useState } from 'react';

const MINUTES_KEY = 'jle.minutes';
const readMinutes = () => {
  try {
    return Number(localStorage.getItem(MINUTES_KEY)) || 20;
  } catch {
    return 20;
  }
};

export function Home({ engine, onStart }: { engine: Engine; onStart: (minutes: number) => Promise<void> }) {
  const [minutes, setMinutes] = useState(readMinutes);
  const [busy, setBusy] = useState(false);
  const firstRun = engine.log.length === 0;
  const mix = engine.previewMix();

  const start = async () => {
    setBusy(true);
    try {
      localStorage.setItem(MINUTES_KEY, String(minutes));
    } catch {
      /* a convenience only */
    }
    await onStart(minutes);
  };

  return (
    <section className="page today">
      <div className="today-head">
        <h1 className="t-title">Ready when you are.</h1>
        <p className="t-body jle-muted">How long do you have today?</p>
      </div>

      <div className="jle-row" role="radiogroup" aria-label="Minutes">
        {[10, 20, 30].map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={m === minutes}
            className="jle-btn chip-btn"
            onClick={() => setMinutes(m)}
          >
            {m} min
          </button>
        ))}
      </div>

      <div className="jle-card mix">
        <span className="jle-label">TODAY'S MIX</span>
        {mix.length > 0 ? (
          <ul className="mix-list">
            {mix.map((g) => (
              <li key={g} className="t-body">
                {g}
              </li>
            ))}
          </ul>
        ) : (
          <p className="t-body">Nothing new is ready yet.</p>
        )}
        <p className="jle-caption">
          {firstRun
            ? 'The first prompts find out what you already know. When you do not know, say so: it costs nothing, and it tells the app more than a guess.'
            : 'Chosen from what you showed last time. Older items come back when they are due.'}
        </p>
      </div>

      <button className="jle-btn jle-btn-primary wide-btn" onClick={start} disabled={busy}>
        Start {minutes} minutes
      </button>
    </section>
  );
}

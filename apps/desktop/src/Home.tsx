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

      {engine.canAddText && <AddText engine={engine} />}
    </section>
  );
}

/** Paste a text to read: an article, a song, a page of a book. It is read in coming lessons, part by part. */
function AddText({ engine }: { engine: Engine }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const { parts, coverage } = await engine.addOwnText(title, text);
      setResult(
        `Added in ${parts} ${parts === 1 ? 'part' : 'parts'}. You have met about ${Math.round(coverage * 100)}% of its words; ` +
          'the rest get furigana and can be looked up. It comes up in your next lesson.',
      );
      setTitle('');
      setText('');
      setOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="jle-stack add-text">
        {result && <p className="t-body-sm jle-muted">{result}</p>}
        <button className="link-btn" onClick={() => setOpen(true)}>
          Add something of your own to read
        </button>
      </div>
    );
  }
  return (
    <form
      className="jle-card jle-stack add-text"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void add();
      }}
    >
      <span className="jle-label">YOUR OWN TEXT</span>
      <p className="t-body-sm jle-muted">
        Paste Japanese you want to read: an article, lyrics, a page of a book. Long texts are split into short parts and
        read in order.
      </p>
      <input className="jle-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />
      <textarea
        className="jle-input add-text-body"
        value={text}
        onChange={(e) => setText(e.target.value)}
        lang="ja"
        placeholder="日本語の文章をここに貼り付けてください。"
        aria-label="Text"
        rows={8}
      />
      {error && <p className="t-body-sm jle-wrong">{error}</p>}
      <div className="jle-row">
        <button type="submit" className="jle-btn jle-btn-primary" disabled={!text.trim() || busy}>
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button type="button" className="jle-btn" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

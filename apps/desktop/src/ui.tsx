import type { Catalog, Item, Status } from '@jle/engine';
import { useState, type ReactNode } from 'react';
import { speak } from './host';

const LABEL: Record<Status, string> = {
  unseen: 'Unseen',
  introduced: 'Introduced',
  learning: 'Learning',
  known: 'Known',
  maintained: 'Maintained',
  leech: 'Leech',
};

export function StatusChip({ status }: { status: Status }) {
  return <span className={`jle jle-chip jle-chip-${status}`}>{LABEL[status]}</span>;
}

export function Word({ item, furigana, className = 't-reading' }: { item: Item; furigana: boolean; className?: string }) {
  if (!furigana || item.written === item.reading) {
    return (
      <span className={className} lang="ja">
        {item.written}
      </span>
    );
  }
  return (
    <span className={className} lang="ja">
      <ruby>
        {item.written}
        <rt className="t-furigana">{item.reading}</rt>
      </ruby>
    </span>
  );
}

/**
 * Japanese that opens a large popover on hover, click or focus. Not a lookup: it is never logged as evidence,
 * because it only enlarges what is already on screen.
 */
export function Zoom({ text, reading, children }: { text: string; reading?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const shown = open || pinned;
  const close = () => {
    setOpen(false);
    setPinned(false);
  };
  return (
    <span
      className="zoom"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <button
        type="button"
        className="zoom-trigger"
        lang="ja"
        aria-expanded={shown}
        aria-label={`Show ${text} larger`}
        onClick={() => setPinned((p) => !p)}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) close();
        }}
      >
        {children ?? text}
      </button>
      {shown && (
        <span className="zoom-pop" role="dialog" aria-label={text}>
          <span className="zoom-card">
            <span className="zoom-big" lang="ja">
              {text}
            </span>
            {reading && reading !== text && (
              <span className="zoom-reading" lang="ja">
                {reading}
              </span>
            )}
            <button type="button" className="jle-btn" onClick={() => void speak(reading ?? text)}>
              Play
            </button>
          </span>
        </span>
      )}
    </span>
  );
}

const JAPANESE_RUN = /([぀-ヿ㐀-鿿豈-﫿々〆ー]+)/;

/** Plain text with each run of Japanese made zoomable. */
export function JaText({ text }: { text: string }) {
  return (
    <>
      {text.split(JAPANESE_RUN).map((part, i) =>
        i % 2 === 1 ? <Zoom key={i} text={part} /> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

export function PlayButton({ text, label = 'Play' }: { text: string; label?: string }) {
  return (
    <button type="button" className="jle-btn" onClick={() => void speak(text)}>
      {label}
    </button>
  );
}

/** First starter word whose reading uses the kana, so a sound is anchored to a word, never to romaji. */
export function exampleWords(catalog: Catalog): Map<string, Item> {
  const words = catalog.items.filter((i) => i.type === 'vocab').sort((a, b) => a.order - b.order);
  const map = new Map<string, Item>();
  for (const kana of catalog.items.filter((i) => i.type === 'script')) {
    const hit = words.find((w) => w.reading.includes(kana.written) && w.reading !== kana.written);
    if (hit) map.set(kana.id, hit);
  }
  return map;
}

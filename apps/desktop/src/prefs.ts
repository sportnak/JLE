// Per-device preferences. They change how things look and sound, never what the engine knows,
// so they live outside the event log.

export const FONTS = {
  textbook: { label: 'Klee One', family: '"Klee One", var(--font-serif)', note: 'Textbook pen style. Kana drawn the way you write them.' },
  mincho: { label: 'Shippori Mincho', family: 'var(--font-serif)', note: 'Print serif. The design system default.' },
  gothic: { label: 'Zen Kaku Gothic New', family: 'var(--font-sans)', note: 'Sans. Even strokes, crisp at small sizes.' },
} as const;
export type FontChoice = keyof typeof FONTS;

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preference only */
  }
};

export function getVoice(): number | null {
  const v = Number(read('jle.voice'));
  return Number.isInteger(v) && v >= 0 && read('jle.voice') !== null ? v : null;
}
export function setVoice(id: number) {
  write('jle.voice', String(id));
}

export function getFont(): FontChoice {
  const f = read('jle.font');
  return f && f in FONTS ? (f as FontChoice) : 'mincho';
}
export function setFont(choice: FontChoice) {
  write('jle.font', choice);
  applyFont(choice);
}
export function applyFont(choice: FontChoice = getFont()) {
  document.documentElement.style.setProperty('--font-jp', FONTS[choice].family);
}

export const SPEEDS = [
  { value: 0.7, label: 'Slow · 0.7×' },
  { value: 0.85, label: 'A little slow · 0.85×' },
  { value: 1, label: 'Normal' },
] as const;

export function getSpeed(): number {
  const v = Number(read('jle.speed'));
  return v >= 0.5 && v <= 1.5 ? v : 1;
}
export function setSpeed(value: number) {
  write('jle.speed', String(value));
}

/** Text size scales the whole app (page zoom), so layout grows with the text. */
export const TEXT_SIZES = [
  { value: 0.9, label: 'Small' },
  { value: 1, label: 'Normal' },
  { value: 1.15, label: 'Large' },
  { value: 1.3, label: 'Larger' },
  { value: 1.5, label: 'Largest' },
] as const;

/** Furigana size, relative to its normal size, on top of the text size. */
export const FURIGANA_SIZES = [
  { value: 1, label: 'Normal' },
  { value: 1.25, label: 'Large' },
  { value: 1.5, label: 'Larger' },
  { value: 1.8, label: 'Largest' },
] as const;

const scale = (key: string, allowed: readonly { value: number }[], fallback: number) => {
  const v = Number(read(key));
  return allowed.some((a) => a.value === v) ? v : fallback;
};

export const getTextSize = () => scale('jle.textSize', TEXT_SIZES, 1);
export const getFuriganaSize = () => scale('jle.furiganaSize', FURIGANA_SIZES, 1);

export function setTextSize(value: number) {
  write('jle.textSize', String(value));
  applyDisplay();
}
export function setFuriganaSize(value: number) {
  write('jle.furiganaSize', String(value));
  applyDisplay();
}
export function applyDisplay() {
  const root = document.documentElement;
  root.style.setProperty('zoom', String(getTextSize()));
  root.style.setProperty('--furigana-scale', String(getFuriganaSize()));
}

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

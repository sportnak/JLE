import { useEffect, useState } from 'react';
import { inTauri, listVoices, speak, type VoiceOption } from './host';
import { FONTS, SPEEDS, getFont, getSpeed, getVoice, setFont, setSpeed, setVoice, type FontChoice } from './prefs';

export const SAMPLE = 'こんにちは。日本語を勉強しましょう。';
const DEFAULT_VOICE = 2;

/** Speech speed. Takes effect on the next thing spoken. */
export function SpeedChoice({ sample = SAMPLE }: { sample?: string }) {
  const [speed, set] = useState(getSpeed());
  return (
    <div className="jle-row" role="radiogroup" aria-label="Speech speed">
      {SPEEDS.map((s) => (
        <button
          key={s.value}
          type="button"
          role="radio"
          aria-checked={speed === s.value}
          className="jle-btn chip-btn"
          onClick={() => {
            setSpeed(s.value);
            set(s.value);
            void speak(sample, getVoice(), s.value);
          }}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

/** A compact voice picker for use mid-lesson. */
export function VoiceSelect({ onChange }: { onChange?: (id: number) => void }) {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [chosen, setChosen] = useState(getVoice() ?? DEFAULT_VOICE);
  useEffect(() => {
    listVoices().then(setVoices, () => setVoices([]));
  }, []);
  if (!inTauri) return <p className="t-body-sm jle-muted">The browser voice. Open the desktop app for VOICEVOX.</p>;
  if (voices.length === 0) return <p className="t-body-sm jle-muted">No voices found. Is VOICEVOX running?</p>;
  return (
    <select
      className="jle-input voice-select"
      aria-label="Voice"
      lang="ja"
      value={chosen}
      onChange={(e) => {
        const id = Number(e.target.value);
        setVoice(id);
        setChosen(id);
        onChange?.(id);
        void speak(SAMPLE, id);
      }}
    >
      {voices.map((v) => (
        <option key={v.id} value={v.id}>
          {v.name}（{v.style}）
        </option>
      ))}
    </select>
  );
}

/** The Japanese study font, as compact choices. Applies at once. */
export function FontChips() {
  const [choice, set] = useState<FontChoice>(getFont());
  return (
    <div className="jle-row" role="radiogroup" aria-label="Japanese font">
      {(Object.keys(FONTS) as FontChoice[]).map((key) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={choice === key}
          className="jle-btn chip-btn"
          onClick={() => {
            setFont(key);
            set(key);
          }}
        >
          <span style={{ fontFamily: FONTS[key].family }} lang="ja">
            あ
          </span>
          &nbsp;{FONTS[key].label}
        </button>
      ))}
    </div>
  );
}

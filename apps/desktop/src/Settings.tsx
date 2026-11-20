import type { Engine } from '@jle/engine';
import { useEffect, useState } from 'react';
import { LEARNER_ID } from './App';
import { apiKeyStatus, clearApiKey, exportLog, inTauri, listVoices, llmUsage, resetLog, setApiKey, speak, voiceInfo, voiceTerms, type RouteUsage, type VoiceInfo, type VoiceOption } from './host';
import { FuriganaSizeChips, SpeedChoice, TextSizeChips } from './Controls';
import { FONTS, getFont, getVoice, setFont, setVoice, type FontChoice } from './prefs';

const SAMPLE = 'こんにちは。日本語を勉強しましょう。';

export function Settings({ engine, onReset, onDemo }: { engine: Engine; onReset: () => void; onDemo: () => void }) {
  const [confirming, setConfirming] = useState(false);

  const download = async () => {
    const blob = new Blob([await exportLog(LEARNER_ID)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jle-events-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="page">
      <h1 className="t-title">Settings</h1>

      <VoiceSetting />
      <FontSetting />
      <SizeSetting />
      <ModelSetting onChange={onReset} />

      <div className="setting">
        <div>
          <h2 className="t-heading">Activities</h2>
          <p className="t-body jle-muted">Try every kind of activity the app has. Nothing you do there is saved.</p>
        </div>
        <button className="jle-btn" onClick={onDemo}>
          See all activities
        </button>
      </div>

      <div className="setting">
        <div>
          <h2 className="t-heading">Study log</h2>
          <p className="t-body jle-muted">
            {engine.log.length} events, kept {inTauri ? 'in a database on this computer' : 'in this browser'}. Everything
            the app knows about you is rebuilt from this log, so a copy of it is a full backup.
          </p>
        </div>
        <div className="jle-row">
          <button className="jle-btn" onClick={download}>
            Save a copy
          </button>
          <button
            className="jle-btn"
            onClick={() => {
              engine.rebuild();
              onReset();
            }}
          >
            Rebuild from log
          </button>
        </div>
      </div>

      <div className="setting">
        <div>
          <h2 className="t-heading">Start over</h2>
          <p className="t-body jle-muted">Deletes the study log. This cannot be undone.</p>
        </div>
        {confirming ? (
          <div className="jle-row">
            <button
              className="jle-btn danger"
              onClick={async () => {
                await resetLog();
                setConfirming(false);
                onReset();
              }}
            >
              Delete the log
            </button>
            <button className="jle-btn" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        ) : (
          <button className="jle-btn" onClick={() => setConfirming(true)}>
            Start over…
          </button>
        )}
      </div>
    </section>
  );
}

function VoiceSetting() {
  const [info, setInfo] = useState<VoiceInfo | null>(null);
  const [voices, setVoices] = useState<VoiceOption[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number | null>(getVoice());
  const [terms, setTerms] = useState<{ uuid: string; text: string } | null>(null);

  useEffect(() => {
    voiceInfo(chosen).then(setInfo, () => setInfo(null));
  }, [chosen]);
  useEffect(() => {
    listVoices().then(setVoices, (e) => {
      setVoices([]);
      setListError(String(e));
    });
  }, []);

  const selected = voices?.find((v) => v.id === (chosen ?? 2));
  const choose = (v: VoiceOption) => {
    setVoice(v.id);
    setChosen(v.id);
    setTerms(null);
  };
  const showTerms = async (v: VoiceOption) => {
    setTerms({ uuid: v.uuid, text: 'Loading…' });
    setTerms({ uuid: v.uuid, text: await voiceTerms(v.uuid).catch(() => 'Could not read the terms from the engine.') });
  };

  return (
    <div className="setting stacked">
      <div className="setting-head">
        <div>
          <h2 className="t-heading">Voice</h2>
          <p className="t-body jle-muted">
            {info?.engine === 'voicevox'
              ? `${info.speaker ?? 'VOICEVOX'}${info.style ? ` (${info.style})` : ''}, VOICEVOX ${info.version ?? ''}.`
              : inTauri
                ? 'The system voice. VOICEVOX is not running yet; it starts with the app.'
                : 'The browser voice. Open the desktop app for VOICEVOX.'}
          </p>
          {info?.credit && <p className="jle-caption">Voice: {info.credit}</p>}
        </div>
        <button className="jle-btn" onClick={() => void speak(SAMPLE, chosen)}>
          Play a sample
        </button>
      </div>

      <div className="setting-row">
        <span className="jle-label">SPEED</span>
        <SpeedChoice />
      </div>

      {inTauri && voices?.length === 0 && (
        <p className="t-body-sm jle-muted">
          {listError ? `Could not list the voices: ${listError}` : 'No voices found. Is VOICEVOX running?'}
        </p>
      )}

      {voices && voices.length > 0 && (
        <>
          <p className="t-body-sm jle-muted">
            Each voice is shown in its plain speaking style. Play a few and choose one to use in lessons.
          </p>
          <ul className="voice-list" role="radiogroup" aria-label="Voices">
            {voices.map((v) => {
              const on = v.id === (chosen ?? 2);
              return (
                <li key={v.id} className={`voice ${on ? 'on' : ''}`}>
                  <button
                    role="radio"
                    aria-checked={on}
                    className="voice-pick"
                    onClick={() => choose(v)}
                  >
                    <span className="t-body" lang="ja">
                      {v.name}
                    </span>
                    <span className="jle-caption" lang="ja">
                      {v.style}
                    </span>
                  </button>
                  <button className="jle-btn" aria-label={`Play ${v.name}`} onClick={() => void speak(SAMPLE, v.id)}>
                    Play
                  </button>
                </li>
              );
            })}
          </ul>
          {selected && (
            <div className="terms">
              <p className="t-body-sm">
                Using {selected.name}. The voice's terms ask for this credit wherever its audio is used:{' '}
                <span lang="ja">VOICEVOX:{selected.name}</span>.
              </p>
              {terms?.uuid === selected.uuid ? (
                <pre className="terms-text" lang="ja">
                  {terms.text}
                </pre>
              ) : (
                <button className="link-btn" onClick={() => void showTerms(selected)}>
                  Read this voice's terms
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const FONT_SAMPLES = {
  kana: 'きさそらりふ',
  katakana: 'ソンシツ',
  word: { written: '新しい', reading: 'あたらしい' },
  sentence: '昨日、友だちと映画を見ました。',
};

function FontSetting() {
  const [choice, setChoice] = useState<FontChoice>(getFont());
  const choose = (c: FontChoice) => {
    setFont(c);
    setChoice(c);
  };

  return (
    <div className="setting stacked">
      <div>
        <h2 className="t-heading">Japanese font</h2>
        <p className="t-body jle-muted">
          For the Japanese you study: kana, words, answers and examples. Titles keep their own face, and furigana stays
          in the sans face so it reads at small sizes.
        </p>
      </div>
      <div className="font-compare" role="radiogroup" aria-label="Japanese font">
        {(Object.keys(FONTS) as FontChoice[]).map((key) => {
          const f = FONTS[key];
          const on = key === choice;
          return (
            <button
              key={key}
              role="radio"
              aria-checked={on}
              className={`jle-card font-card ${on ? 'on' : ''}`}
              onClick={() => choose(key)}
            >
              <span className="jle-label">{f.label.toUpperCase()}</span>
              <span className="font-sample" style={{ fontFamily: f.family }} lang="ja">
                <span className="font-kana">{FONT_SAMPLES.kana}</span>
                <span className="font-kana small">{FONT_SAMPLES.katakana}</span>
                <span className="font-word">
                  <ruby>
                    {FONT_SAMPLES.word.written}
                    <rt>{FONT_SAMPLES.word.reading}</rt>
                  </ruby>
                </span>
                <span className="font-sentence">{FONT_SAMPLES.sentence}</span>
              </span>
              <span className="jle-caption">{f.note}</span>
              {on && <span className="t-body-sm font-chosen">In use</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The Anthropic API key for generated reading, and what the model has cost so far. The key stays in the keychain. */
function ModelSetting({ onChange }: { onChange: () => void }) {
  const [set, setSet] = useState<boolean | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<RouteUsage[]>([]);

  useEffect(() => {
    apiKeyStatus().then(setSet, () => setSet(false));
    llmUsage().then(setUsage, () => setUsage([]));
  }, []);

  if (!inTauri) {
    return (
      <div className="setting">
        <div>
          <h2 className="t-heading">Generated reading</h2>
          <p className="t-body jle-muted">Passages written for you need the desktop app.</p>
        </div>
      </div>
    );
  }

  const save = async () => {
    setError(null);
    try {
      await setApiKey(draft.trim());
      setDraft('');
      setSet(true);
      onChange();
    } catch (e) {
      setError(String(e));
    }
  };
  const remove = async () => {
    await clearApiKey();
    setSet(false);
    onChange();
  };
  const cost = usage.reduce((sum, u) => sum + u.costUsd, 0);
  const calls = usage.reduce((sum, u) => sum + u.calls, 0);

  return (
    <div className="setting stacked">
      <div>
        <h2 className="t-heading">Generated reading</h2>
        <p className="t-body jle-muted">
          Lessons include a short passage written for your level by Claude. It needs your Anthropic API key, which is
          kept in the macOS keychain and never shown again. Only your level and the words a passage is built around are
          sent, never your list of known words.
        </p>
      </div>
      {set ? (
        <div className="jle-row">
          <span className="t-body">An API key is saved.</span>
          <button className="jle-btn" onClick={() => void remove()}>
            Remove it
          </button>
        </div>
      ) : (
        <form
          className="jle-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void save();
          }}
        >
          <input
            className="jle-input"
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="sk-ant-…"
            aria-label="Anthropic API key"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="jle-btn jle-btn-primary" disabled={!draft.trim()}>
            Save key
          </button>
        </form>
      )}
      {error && <p className="t-body-sm jle-wrong">{error}</p>}
      {calls > 0 && (
        <p className="t-body-sm jle-muted">
          {calls} model {calls === 1 ? 'call' : 'calls'} so far, about ${cost.toFixed(2)} in total.
        </p>
      )}
    </div>
  );
}

/** Text size for the whole app and furigana size on its own, with a sample that updates as they change. */
function SizeSetting() {
  return (
    <div className="setting stacked">
      <div>
        <h2 className="t-heading">Text and furigana size</h2>
        <p className="t-body jle-muted">Text size scales everything. Furigana size makes the readings over kanji larger on their own.</p>
      </div>
      <div className="setting-row">
        <span className="jle-label">TEXT</span>
        <TextSizeChips />
      </div>
      <div className="setting-row">
        <span className="jle-label">FURIGANA</span>
        <FuriganaSizeChips />
      </div>
      <p className="t-reading size-sample" lang="ja">
        <ruby>
          昨日<rt className="t-furigana">きのう</rt>
        </ruby>
        、
        <ruby>
          友達<rt className="t-furigana">ともだち</rt>
        </ruby>
        と
        <ruby>
          映画<rt className="t-furigana">えいが</rt>
        </ruby>
        を
        <ruby>
          見<rt className="t-furigana">み</rt>
        </ruby>
        ました。
      </p>
    </div>
  );
}

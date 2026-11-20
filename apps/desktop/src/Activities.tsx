import { gradeDictation, type ActivitySpec, type ActivityView, type Engine, type Feedback, type MinimalPair, type Segment } from '@jle/engine';
import { useEffect, useRef, useState } from 'react';
import { toKana } from 'wanakana';
import { useEnter } from './hooks';
import { prepareSpeech, speak, speakSequence } from './host';
import { PlayButton } from './ui';

export interface ActivityProps {
  engine: Engine;
  activity: ActivityView;
  onNext: () => void;
}

type PairSpec = Extract<ActivitySpec, { type: 'minimal_pair' }>;
type DictationSpec = Extract<ActivitySpec, { type: 'dictation' }>;

const pairOf = (engine: Engine, id: string | undefined): MinimalPair | undefined =>
  engine.learner.catalog.pairs?.find((p) => p.id === id);

const sentenceReading = (segments: Segment[]) => segments.map((s) => s.reading).join('');

function Flag({ engine, activityId, onNext }: { engine: Engine; activityId: string; onNext: () => void }) {
  return (
    <button
      className="link-btn flag"
      onClick={async () => {
        await engine.flagContent(activityId, 'learner flag');
        onNext();
      }}
    >
      Flag as wrong or unnatural
    </button>
  );
}

function NextButton({ onNext }: { onNext: () => void }) {
  return (
    <button className="jle-btn jle-btn-primary wide-btn" onClick={onNext} autoFocus>
      Next
    </button>
  );
}

/** Both words of a pair with their meanings, each playable. */
function PairWords({ pair }: { pair: MinimalPair }) {
  return (
    <div className="pair-words">
      {[pair.a, pair.b].map((w) => (
        <div key={w.kana} className="pair-word">
          <span className="t-reading" lang="ja">
            {w.kana}
          </span>
          <span className="t-body-sm jle-muted">{w.gloss}</span>
          <PlayButton text={w.kana} />
        </div>
      ))}
    </div>
  );
}

/** A sound feature is taught with one pair: both words heard in turn, and what tells them apart. */
export function SoundIntro({ engine, activity, onNext }: ActivityProps) {
  const spec = activity.spec;
  const pair = pairOf(engine, spec.type === 'introduce' ? spec.pairId : undefined);
  useEnter(onNext);
  useEffect(() => {
    if (pair) void speakSequence([pair.a.kana, pair.b.kana]);
  }, [pair]);
  return (
    <div className="jle-stack">
      <span className="jle-label">NEW SOUND</span>
      <p className="cue-english">{activity.item.gloss[0]}</p>
      {pair && (
        <>
          <PairWords pair={pair} />
          <p className="t-body">
            <JaRun text={pair.difference} />
          </p>
          <div className="jle-row">
            <button className="jle-btn" onClick={() => speakSequence([pair.a.kana, pair.b.kana])}>
              Hear both
            </button>
          </div>
        </>
      )}
      <NextButton onNext={onNext} />
    </div>
  );
}

function JaRun({ text }: { text: string }) {
  return (
    <>
      {text.split(/([぀-ヿー]+)/).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} lang="ja">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** One word of a pair is played; the learner picks which of the two it was. */
export function MinimalPairPrompt({ engine, activity, onNext }: ActivityProps) {
  const spec = activity.spec as PairSpec;
  const pair = pairOf(engine, spec.pairId);
  const [chosen, setChosen] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const shownAt = useRef(performance.now());
  useEnter(feedback ? onNext : null);
  useEffect(() => {
    void prepareSpeech([...spec.options]).then(() => speak(spec.answer));
  }, [spec.answer, spec.options]);

  const send = async (choice: string | null) => {
    if (feedback) return;
    const latencyMs = Math.round(performance.now() - shownAt.current);
    setChosen(choice);
    const fb = await engine.recordInteraction(
      activity.activityId,
      choice === null ? { kind: 'dont_know', latencyMs } : { kind: 'choice', choice, latencyMs },
    );
    setFeedback(fb);
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const word = { '1': spec.options[0], '2': spec.options[1] }[e.key];
      if (word && !(e.target instanceof HTMLInputElement)) void sendRef.current(word);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [spec.options]);

  return (
    <div className="jle-stack">
      <span className="jle-label">WHICH DID YOU HEAR?</span>
      <div className="jle-row">
        <PlayButton text={spec.answer} label="Play again" />
      </div>
      <div className="jle-choices pair-choices" role="group" aria-label="The two words">
        {spec.options.map((word, i) => (
          <button
            key={word}
            className="jle-btn jle-choice"
            lang="ja"
            aria-pressed={chosen === word}
            aria-keyshortcuts={String(i + 1)}
            disabled={!!feedback}
            onClick={() => send(word)}
          >
            {word}
          </button>
        ))}
      </div>
      {!feedback && (
        <button type="button" className="jle-btn jle-btn-dk" onClick={() => send(null)}>
          I can't tell
        </button>
      )}
      {feedback && (
        <>
          <div className={`jle-note ${feedback.kind === 'correct' ? 'jle-note-good' : feedback.kind === 'revealed' ? 'jle-note-neutral' : 'jle-note-bad'}`} role="status">
            <b>{feedback.kind === 'correct' ? 'Yes.' : feedback.kind === 'revealed' ? 'Noted.' : 'Not quite.'}</b>
            <span>
              It was <span lang="ja">{spec.answer}</span>.
            </span>
          </div>
          {pair && (
            <>
              <PairWords pair={pair} />
              <p className="t-body-sm jle-muted">
                <JaRun text={pair.difference} />
              </p>
              <div className="jle-row">
                <button className="jle-btn" onClick={() => speakSequence([pair.a.kana, pair.b.kana])}>
                  Hear both
                </button>
              </div>
            </>
          )}
          <NextButton onNext={onNext} />
          <Flag engine={engine} activityId={activity.activityId} onNext={onNext} />
        </>
      )}
    </div>
  );
}

/** The sentence as written, with furigana on words in kanji and missed words marked. */
function Sentence({ segments, heard }: { segments: Segment[]; heard?: boolean[] }) {
  return (
    <span className="t-reading dict-sentence" lang="ja">
      {segments.map((s, i) => {
        const missed = heard && heard[i] === false;
        const body =
          s.itemId && s.text !== s.reading ? (
            <ruby>
              {s.text}
              <rt className="t-furigana">{s.reading}</rt>
            </ruby>
          ) : (
            s.text
          );
        return missed ? (
          <mark key={i} className="dict-missed">
            {body}
          </mark>
        ) : (
          <span key={i}>{body}</span>
        );
      })}
    </span>
  );
}

/** A short sentence of known words is played; the learner types it, and it is compared by reading. */
export function DictationPrompt({ engine, activity, onNext }: ActivityProps) {
  const spec = activity.spec as DictationSpec;
  const reading = sentenceReading(spec.segments);
  const [text, setText] = useState('');
  const [given, setGiven] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(performance.now());
  const input = useRef<HTMLInputElement>(null);
  useEnter(feedback ? onNext : null);
  useEffect(() => void speak(reading), [reading]);
  useEffect(() => input.current?.focus(), []);

  const send = async (kind: 'answer' | 'dont_know' | 'skip' | 'dispute') => {
    if (busy) return;
    setBusy(true);
    const latencyMs = Math.round(performance.now() - shownAt.current);
    const fb = await engine.recordInteraction(
      activity.activityId,
      kind === 'answer' ? { kind, text, latencyMs } : kind === 'dont_know' ? { kind, latencyMs } : { kind },
    );
    setBusy(false);
    if (kind === 'skip') return onNext();
    if (kind === 'dispute') return setFeedback({ kind: 'correct', expected: '', note: 'Counted as right.' });
    setGiven(kind === 'answer' ? text : '');
    setFeedback(fb);
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const composing = (e.nativeEvent as InputEvent).isComposing;
    setText(composing ? e.target.value : toKana(e.target.value, { IMEMode: true }));
  };

  const heard = feedback && feedback.kind !== 'correct' && given ? gradeDictation(spec.segments, given).heard : undefined;

  return (
    <div className="jle-stack">
      <span className="jle-label">WRITE WHAT YOU HEAR</span>
      <div className="jle-row">
        <PlayButton text={reading} label="Play again" />
      </div>
      {!feedback && (
        <form
          className="jle-stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void send('answer');
          }}
        >
          <input
            ref={input}
            className="jle-input"
            value={text}
            onChange={onChange}
            lang="ja"
            aria-label="What you heard"
            placeholder="Type it in kana"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <div className="answer-actions">
            <button type="submit" className="jle-btn jle-btn-primary" disabled={!text.trim() || busy}>
              Check
            </button>
            <button type="button" className="jle-btn jle-btn-dk" onClick={() => send('dont_know')} disabled={busy}>
              I didn't catch it
            </button>
          </div>
          <button type="button" className="link-btn skip" onClick={() => send('skip')} disabled={busy}>
            Skip
          </button>
        </form>
      )}
      {feedback && (
        <>
          <div className={`jle-note ${feedback.kind === 'correct' ? 'jle-note-good' : feedback.kind === 'revealed' ? 'jle-note-neutral' : 'jle-note-bad'}`} role="status">
            <b>{feedback.kind === 'correct' ? 'Yes.' : feedback.kind === 'revealed' ? 'Noted.' : 'Not quite.'}</b>
            <span>
              It was: <Sentence segments={spec.segments} {...(heard ? { heard } : {})} />
            </span>
          </div>
          {heard && (
            <p className="t-body-sm jle-muted">
              You typed{' '}
              <span className="jle-wrong" lang="ja">
                {given}
              </span>
              . Marked words were not heard.
            </p>
          )}
          {feedback.kind === 'incorrect' && feedback.canDispute && (
            <div className="jle-row">
              <button className="jle-btn" onClick={() => send('dispute')}>
                Count it as right
              </button>
            </div>
          )}
          <NextButton onNext={onNext} />
          <Flag engine={engine} activityId={activity.activityId} onNext={onNext} />
        </>
      )}
    </div>
  );
}

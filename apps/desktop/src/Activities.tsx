import { gradeDictation, sentencesOf, type ActivitySpec, type ActivityView, type Engine, type ErrorType, type Feedback, type Finding, type Item, type MinimalPair, type Segment, type StoredGrade } from '@jle/engine';
import { useEffect, useRef, useState } from 'react';
import { toKana } from 'wanakana';
import { useEnter } from './hooks';
import { prepareSpeech, speak, speakSequence } from './host';
import { PlayButton, Word } from './ui';

export interface ActivityProps {
  engine: Engine;
  activity: ActivityView;
  onNext: () => void;
}

type PairSpec = Extract<ActivitySpec, { type: 'minimal_pair' }>;
type DictationSpec = Extract<ActivitySpec, { type: 'dictation' }>;

const pairOf = (engine: Engine, id: string | undefined): MinimalPair | undefined =>
  id ? engine.learner.catalog.pair(id) : undefined;

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

const HAS_KANJI = /[㐀-鿿豈-﫿々〆]/;

/**
 * A passage written for the learner. Words not yet known get furigana; tapping a word shows its reading and meaning
 * and logs a lookup (a weak miss that queues the word for teaching). Done credits the words already met.
 */
export function ReadingPrompt({ engine, activity, onNext }: ActivityProps) {
  const spec = activity.spec;
  const content = spec.type === 'reading' ? engine.content(spec.contentId) : undefined;
  const [open, setOpen] = useState<number | null>(null);
  const [looked, setLooked] = useState<Set<number>>(new Set());
  // A passage reopened after Done (the lesson was left before Next) stays done: no more lookups are logged.
  const [done, setDone] = useState(() => engine.learner.activities.get(activity.activityId)?.outcome != null);
  const shownAt = useRef(performance.now());
  useEnter(done ? onNext : null);

  if (!content) {
    return (
      <div className="jle-stack">
        <p className="t-body">This passage could not be found.</p>
        <NextButton onNext={onNext} />
      </div>
    );
  }

  const known = (itemId: string | undefined) => {
    if (!itemId) return false;
    const s = engine.learner.state(itemId, 'read').status;
    return s === 'known' || s === 'maintained';
  };
  const spoken = content.tokens.map((t) => t.reading || t.surface).join('');
  const tapped = open !== null ? content.tokens[open] : undefined;
  const tappedItem = tapped?.itemId ? engine.learner.item(tapped.itemId) : undefined;

  const tap = async (i: number) => {
    setOpen((o) => (o === i ? null : i));
    if (looked.has(i) || done) return;
    setLooked((s) => new Set(s).add(i));
    await engine.lookup(activity.activityId, i);
  };

  const finish = async () => {
    if (done) return;
    setOpen(null);
    await engine.finishReading(activity.activityId, Math.round(performance.now() - shownAt.current));
    setDone(true);
  };

  return (
    <div className="jle-stack reading">
      <span className="jle-label">READ</span>
      <h2 className="t-heading" lang="ja">
        {content.title}
      </h2>
      <p className="t-reading reading-text" lang="ja">
        {content.tokens.map((t, i) => {
          const furigana = HAS_KANJI.test(t.surface) && !known(t.itemId) && t.reading && t.reading !== t.surface;
          const body = furigana ? (
            <ruby>
              {t.surface}
              <rt className="t-furigana">{t.reading}</rt>
            </ruby>
          ) : (
            t.surface
          );
          if (!t.itemId) return <span key={i}>{body}</span>;
          return (
            <button
              key={i}
              type="button"
              className={`reading-word ${looked.has(i) ? 'looked' : ''} ${open === i ? 'open' : ''} ${!done && engine.highlighted(t.itemId) ? 'fresh' : ''}`}
              aria-expanded={open === i}
              onClick={() => void tap(i)}
            >
              {body}
            </button>
          );
        })}
      </p>
      {tapped && (
        <div className="jle-note jle-note-neutral reading-lookup" role="status">
          {/* The word as it stands in the passage (行き, いき); its dictionary form below when that differs (行く). */}
          <span className="t-reading" lang="ja">
            {tapped.surface}
          </span>
          {tapped.reading && tapped.reading !== tapped.surface && (
            <span className="t-body-sm" lang="ja">
              {tapped.reading}
            </span>
          )}
          <span className="t-body-sm">{tappedItem?.gloss.slice(0, 4).join('; ')}</span>
          {tappedItem && tappedItem.written !== tapped.surface && (
            <span className="t-body-sm jle-muted">
              dictionary form{' '}
              <span lang="ja">
                {tappedItem.written}
                {tappedItem.reading && tappedItem.reading !== tappedItem.written ? ` (${tappedItem.reading})` : ''}
              </span>
            </span>
          )}
          <PlayButton text={tapped.reading || tapped.surface} />
        </div>
      )}
      <div className="jle-row">
        <PlayButton text={spoken} label="Listen" />
      </div>
      {!done ? (
        <>
          <p className="t-body-sm jle-muted">Words you are still meeting for the first times are marked. Tap any word you don't know; press Done when you've read it.</p>
          <button className="jle-btn jle-btn-primary wide-btn" onClick={() => void finish()}>
            Done
          </button>
        </>
      ) : (
        <>
          {content.translation ? (
            <div className="jle-note jle-note-good" role="status">
              <b>In English.</b>
              <span>{content.translation}</span>
            </div>
          ) : (
            <div className="jle-note jle-note-good" role="status">
              <b>Read.</b>
              <span>{content.series && content.series.part < content.series.of ? 'The next part follows.' : 'That was the whole text.'}</span>
            </div>
          )}
          {looked.size > 0 && (
            <p className="t-body-sm jle-muted">
              The words you looked up will be taught in a coming lesson.
            </p>
          )}
          <KeepSentences engine={engine} contentId={content.id} />
          <NextButton onNext={onNext} />
          <Flag engine={engine} activityId={activity.activityId} onNext={onNext} />
        </>
      )}
    </div>
  );
}

type QuestionSpec = Extract<ActivitySpec, { type: 'comprehension' }>;

/** A question on the passage just read: three options, keys 1–3, or "I'm not sure". */
export function ComprehensionPrompt({ engine, activity, onNext }: ActivityProps) {
  const spec = activity.spec as QuestionSpec;
  const content = engine.content(spec.contentId);
  const [chosen, setChosen] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const shownAt = useRef(performance.now());
  useEnter(feedback ? onNext : null);

  const send = async (choice: string | null) => {
    if (feedback) return;
    const latencyMs = Math.round(performance.now() - shownAt.current);
    setChosen(choice);
    setFeedback(
      await engine.recordInteraction(
        activity.activityId,
        choice === null ? { kind: 'dont_know', latencyMs } : { kind: 'choice', choice, latencyMs },
      ),
    );
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const option = spec.options[Number(e.key) - 1];
      if (option && !(e.target instanceof HTMLInputElement)) void sendRef.current(option);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [spec.options]);

  return (
    <div className="jle-stack">
      <span className="jle-label">ABOUT THE PASSAGE</span>
      {content && (
        <p className="t-body jle-muted reading-recall" lang="ja">
          {content.text}
        </p>
      )}
      <p className="cue-english">{spec.prompt}</p>
      <div className="jle-choices question-choices" role="group" aria-label="Answers">
        {spec.options.map((option, i) => (
          <button
            key={option}
            className="jle-btn jle-choice"
            aria-pressed={chosen === option}
            aria-keyshortcuts={String(i + 1)}
            disabled={!!feedback}
            onClick={() => void send(option)}
          >
            {option}
          </button>
        ))}
      </div>
      {!feedback && (
        <button type="button" className="jle-btn jle-btn-dk" onClick={() => void send(null)}>
          I'm not sure
        </button>
      )}
      {feedback && (
        <>
          <div className={`jle-note ${feedback.kind === 'correct' ? 'jle-note-good' : feedback.kind === 'revealed' ? 'jle-note-neutral' : 'jle-note-bad'}`} role="status">
            <b>{feedback.kind === 'correct' ? 'Yes.' : feedback.kind === 'revealed' ? 'Noted.' : 'Not quite.'}</b>
            <span>{feedback.kind === 'correct' ? '' : `It was: ${spec.answer}`}</span>
          </div>
          {spec.hinge && feedback.kind !== 'correct' && (
            <p className="t-body-sm jle-muted">
              It turns on <span lang="ja">{activity.item.written}</span> ({activity.item.gloss[0]}).
            </p>
          )}
          <NextButton onNext={onNext} />
          <Flag engine={engine} activityId={activity.activityId} onNext={onNext} />
        </>
      )}
    </div>
  );
}

type FormSpec = Extract<ActivitySpec, { type: 'transformation' }>;

/** Make a form of a known word: polite past of 食べる. Typed in kana (romaji turns into kana) and checked by the conjugator. */
export function TransformationPrompt({ engine, activity, onNext }: ActivityProps) {
  const spec = activity.spec as FormSpec;
  const { item } = activity;
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(performance.now());
  const input = useRef<HTMLInputElement>(null);
  useEnter(feedback ? onNext : null);
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
    if (kind === 'dispute') return setFeedback({ kind: 'correct', expected: spec.expected[0] ?? '', note: 'Counted as right.' });
    setFeedback(fb);
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const composing = (e.nativeEvent as InputEvent).isComposing;
    setText(composing ? e.target.value : toKana(e.target.value, { IMEMode: true }));
  };

  return (
    <div className="jle-stack">
      <span className="jle-label">MAKE THE {spec.form.toUpperCase()}</span>
      <span className="cue-word" lang="ja">
        <ruby>
          {item.written}
          {item.written !== item.reading && <rt className="t-furigana">{item.reading}</rt>}
        </ruby>
      </span>
      <p className="t-body-sm jle-muted">{item.gloss[0]}</p>
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
            aria-label={`The ${spec.form}`}
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
            <button type="button" className="jle-btn jle-btn-dk" onClick={() => void send('dont_know')} disabled={busy}>
              I don't know
            </button>
          </div>
          <button type="button" className="link-btn skip" onClick={() => void send('skip')} disabled={busy}>
            Skip
          </button>
        </form>
      )}
      {feedback && (
        <>
          <div className={`jle-note ${feedback.kind === 'correct' ? 'jle-note-good' : feedback.kind === 'revealed' ? 'jle-note-neutral' : 'jle-note-bad'}`} role="status">
            <b>{feedback.kind === 'correct' ? 'Yes.' : feedback.kind === 'revealed' ? 'Noted.' : 'Not quite.'}</b>
            <span lang="ja">{spec.expected.join(' / ')}</span>
          </div>
          {feedback.kind === 'incorrect' && feedback.canDispute && (
            <div className="jle-row">
              <button className="jle-btn" onClick={() => void send('dispute')}>
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

/** After reading: keep any sentence. A kept sentence comes back as a fill-in-the-blank cue for its words. */
function KeepSentences({ engine, contentId }: { engine: Engine; contentId: string }) {
  const content = engine.content(contentId);
  const [, bump] = useState(0);
  if (!content) return null;
  const sentences = sentencesOf(content).filter((s) => s.tokens.some((t) => t.itemId));
  if (sentences.length === 0) return null;
  const toggle = async (begin: number, end: number) => {
    if (engine.learner.kept.has(`${contentId}:${begin}`)) await engine.unkeepSentence(contentId, begin);
    else await engine.keepSentence(contentId, begin, end);
    bump((n) => n + 1);
  };
  return (
    <div className="keep-sentences">
      <span className="jle-label">KEEP A SENTENCE</span>
      <p className="t-body-sm jle-muted">Kept sentences come back later with a word blanked out.</p>
      <ul className="keep-list">
        {sentences.map((s) => {
          const kept = engine.learner.kept.has(`${contentId}:${s.begin}`);
          return (
            <li key={s.begin} className="keep-row">
              <span className="t-body" lang="ja">
                {s.text}
              </span>
              <button className={`jle-btn chip-btn ${kept ? 'on' : ''}`} aria-pressed={kept} onClick={() => void toggle(s.begin, s.end)}>
                {kept ? 'Kept' : 'Keep'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type ClozeSpec = Extract<ActivitySpec, { type: 'cloze' }>;

/** A kept sentence with one word blanked: type the word as it stands in the sentence. */
export function ClozePrompt({ engine, activity, onNext }: ActivityProps) {
  const spec = activity.spec as ClozeSpec;
  const chars = [...spec.sentence];
  const before = chars.slice(0, spec.blankBegin).join('');
  const missing = chars.slice(spec.blankBegin, spec.blankEnd).join('');
  const after = chars.slice(spec.blankEnd).join('');
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(performance.now());
  const input = useRef<HTMLInputElement>(null);
  useEnter(feedback ? onNext : null);
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
    if (kind === 'dispute') return setFeedback({ kind: 'correct', expected: missing, note: 'Counted as right.' });
    if (fb.kind !== 'correct') void speak(spec.sentence);
    setFeedback(fb);
  };
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const composing = (e.nativeEvent as InputEvent).isComposing;
    setText(composing ? e.target.value : toKana(e.target.value, { IMEMode: true }));
  };

  return (
    <div className="jle-stack">
      <span className="jle-label">FILL THE GAP</span>
      <p className="t-reading cloze-sentence" lang="ja">
        {before}
        <span className={`cloze-gap ${feedback ? 'filled' : ''}`}>{feedback ? missing : '＿＿'}</span>
        {after}
      </p>
      <p className="t-body-sm jle-muted">{activity.item.gloss.slice(0, 2).join('; ')}</p>
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
            aria-label="The missing word"
            placeholder="Type the missing word"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <div className="answer-actions">
            <button type="submit" className="jle-btn jle-btn-primary" disabled={!text.trim() || busy}>
              Check
            </button>
            <button type="button" className="jle-btn jle-btn-dk" onClick={() => void send('dont_know')} disabled={busy}>
              I don't know
            </button>
          </div>
          <button type="button" className="link-btn skip" onClick={() => void send('skip')} disabled={busy}>
            Skip
          </button>
        </form>
      )}
      {feedback && (
        <>
          <div className={`jle-note ${feedback.kind === 'correct' ? 'jle-note-good' : feedback.kind === 'revealed' ? 'jle-note-neutral' : 'jle-note-bad'}`} role="status">
            <b>{feedback.kind === 'correct' ? 'Yes.' : feedback.kind === 'revealed' ? 'Noted.' : 'Not quite.'}</b>
            <span lang="ja">{spec.answers.join(' / ')}</span>
          </div>
          <div className="jle-row">
            <PlayButton text={spec.sentence} label="Play the sentence" />
            {feedback.kind === 'incorrect' && feedback.canDispute && (
              <button className="jle-btn" onClick={() => void send('dispute')}>
                Count it as right
              </button>
            )}
          </div>
          <NextButton onNext={onNext} />
          <Flag engine={engine} activityId={activity.activityId} onNext={onNext} />
        </>
      )}
    </div>
  );
}

type ContrastSpec = Extract<ActivitySpec, { type: 'contrast' }>;

/** Two confusable forms for one gap. A wrong choice shows the point's approved fact sheet; drafts never reach here. */
export function ContrastPrompt({ engine, activity, onNext }: ActivityProps) {
  const spec = activity.spec as ContrastSpec;
  const point = engine.learner.catalog.grammar().find((p) => p.id === spec.pointId);
  const [before, after] = spec.sentence.split('＿');
  const [chosen, setChosen] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const shownAt = useRef(performance.now());
  useEnter(feedback ? onNext : null);

  const send = async (choice: string | null) => {
    if (feedback) return;
    const latencyMs = Math.round(performance.now() - shownAt.current);
    setChosen(choice);
    setFeedback(
      await engine.recordInteraction(
        activity.activityId,
        choice === null ? { kind: 'dont_know', latencyMs } : { kind: 'choice', choice, latencyMs },
      ),
    );
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const option = spec.options[Number(e.key) - 1];
      if (option && !(e.target instanceof HTMLInputElement)) void sendRef.current(option);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [spec.options]);

  return (
    <div className="jle-stack">
      <span className="jle-label">WHICH FITS?</span>
      <p className="t-reading cloze-sentence" lang="ja">
        {before}
        <span className={`cloze-gap ${feedback ? 'filled' : ''}`}>{feedback ? spec.answer : '＿＿'}</span>
        {after}
      </p>
      <div className="jle-choices pair-choices" role="group" aria-label="The two forms">
        {spec.options.map((option, i) => (
          <button
            key={option}
            className="jle-btn jle-choice"
            lang="ja"
            aria-pressed={chosen === option}
            aria-keyshortcuts={String(i + 1)}
            disabled={!!feedback}
            onClick={() => void send(option)}
          >
            {option}
          </button>
        ))}
      </div>
      {!feedback && (
        <button type="button" className="jle-btn jle-btn-dk" onClick={() => void send(null)}>
          I'm not sure
        </button>
      )}
      {feedback && (
        <>
          <div className={`jle-note ${feedback.kind === 'correct' ? 'jle-note-good' : feedback.kind === 'revealed' ? 'jle-note-neutral' : 'jle-note-bad'}`} role="status">
            <b>{feedback.kind === 'correct' ? 'Yes.' : feedback.kind === 'revealed' ? 'Noted.' : 'Not quite.'}</b>
            <span>{spec.translation}</span>
          </div>
          {feedback.kind !== 'correct' && point && (
            <div className="fact-sheet">
              <span className="jle-label">{point.label.toUpperCase()}</span>
              <p className="t-body">
                <JaRun text={point.factSheet.body} />
              </p>
            </div>
          )}
          {feedback.kind === 'incorrect' && engine.canExplain && <ExplainMistake engine={engine} activityId={activity.activityId} />}
          <NextButton onNext={onNext} />
          <Flag engine={engine} activityId={activity.activityId} onNext={onNext} />
        </>
      )}
    </div>
  );
}

/** Asks for an explanation of this mistake, written from the approved fact sheet (or read back if written before). */
function ExplainMistake({ engine, activityId }: { engine: Engine; activityId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (text) {
    return (
      <p className="t-body explanation">
        <JaRun text={text} />
      </p>
    );
  }
  return (
    <div className="jle-row">
      <button
        className="jle-btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setText(await engine.explain(activityId));
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Explaining…' : 'Explain my mistake'}
      </button>
      {error && <span className="t-body-sm jle-wrong">{error}</span>}
    </div>
  );
}

type WritingSpec = Extract<ActivitySpec, { type: 'writing' }>;

const ERROR_WORDS: Record<ErrorType, string> = {
  particle: 'Particle',
  conjugation: 'Verb or adjective form',
  word_choice: 'Word choice',
  spelling: 'Spelling',
  word_order: 'Word order',
  politeness: 'Politeness',
  missing_word: 'Missing word',
  extra_word: 'Extra word',
  other: 'Other',
};

/** The answer split into plain runs and marked findings (numbered as in the list). Overlapping spans keep the first. */
function markSpans(answer: string, findings: Finding[]) {
  const chars = [...answer];
  const spans = findings
    .map((f, n) => ({ n, begin: f.begin, end: f.end }))
    .filter((x): x is { n: number; begin: number; end: number } => x.begin !== null && x.end !== null && x.end > x.begin)
    .sort((a, b) => a.begin - b.begin || a.n - b.n);
  const parts: { text: string; n?: number }[] = [];
  let at = 0;
  for (const sp of spans) {
    if (sp.begin < at) continue;
    if (sp.begin > at) parts.push({ text: chars.slice(at, sp.begin).join('') });
    parts.push({ text: chars.slice(sp.begin, sp.end).join(''), n: sp.n });
    at = sp.end;
  }
  if (at < chars.length) parts.push({ text: chars.slice(at).join('') });
  return parts;
}

/** The graded answer: comment, marked text, each finding and the corrected version. */
function WritingFeedback({ grade, sample }: { grade: StoredGrade; sample: boolean }) {
  const parts = markSpans(grade.answer, grade.findings);
  const clean = grade.findings.length === 0;
  return (
    <>
      <div className={`jle-note writing-comment ${clean ? 'jle-note-good' : 'jle-note-neutral'}`} role="status">
        <b>{sample ? 'Sample feedback.' : clean ? 'Well written.' : 'Checked.'}</b>
        <span>{grade.comment}</span>
      </div>
      <div className="writing-block">
        <span className="jle-label">{sample ? 'THE SAMPLE ANSWER' : 'WHAT YOU WROTE'}</span>
        <p className="t-reading writing-answer" lang="ja">
          {parts.map((p, i) =>
            p.n === undefined ? (
              <span key={i}>{p.text}</span>
            ) : (
              <mark key={i} className={`writing-mark ${grade.findings[p.n]!.confidence === 'low' ? 'maybe' : ''}`}>
                {p.text}
                <sup className="writing-ref">{p.n + 1}</sup>
              </mark>
            ),
          )}
        </p>
      </div>
      {!clean && (
        <ol className="writing-findings">
          {grade.findings.map((f, n) => (
            <li key={n} className="writing-finding">
              <span className="writing-ref-num" aria-hidden="true">
                {n + 1}
              </span>
              <div className="writing-finding-body">
                <div className="writing-fix">
                  <span className={`t-body jle-wrong ${f.errorType === 'missing_word' ? '' : 'writing-quote'}`} lang="ja">
                    {f.quote}
                  </span>
                  <span className="jle-muted" aria-label="should be">
                    →
                  </span>
                  <span className="t-body writing-correction" lang="ja">
                    {f.correction}
                  </span>
                </div>
                <span className="jle-caption">
                  {ERROR_WORDS[f.errorType] ?? f.errorType}
                  {f.confidence === 'low' && <span className="writing-maybe">maybe</span>}
                  {f.begin === null && ' · not marked in the text'}
                </span>
                <p className="t-body-sm writing-explanation">
                  <JaRun text={f.explanation} />
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {!clean && grade.corrected !== grade.answer && (
        <div className="fact-sheet">
          <span className="jle-label">CORRECTED</span>
          <p className="t-reading writing-answer" lang="ja">
            {grade.corrected}
          </p>
          <div className="jle-row">
            <PlayButton text={grade.corrected} label="Listen" />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Free writing: a task and a few words to use, typed with the system's Japanese input (no romaji conversion here), then
 * graded by the model. `sample` shows a canned grade instead, for the activity list, without calling the model.
 */
export function WritingPrompt({ engine, activity, onNext, sample }: ActivityProps & { sample?: StoredGrade }) {
  const spec = activity.spec as WritingSpec;
  const { catalog } = engine.learner;
  const targets = spec.targets.map((id) => catalog.item(catalog.resolve(id))).filter((i): i is Item => !!i);
  const record = () => engine.learner.activities.get(activity.activityId);
  const [text, setText] = useState(() => record()?.answers.at(-1) ?? sample?.answer ?? '');
  const [grade, setGrade] = useState<StoredGrade | null>(() => {
    const id = record()?.gradeId;
    return (id && engine.grade(id)) || null;
  });
  // An answer logged but not graded (the model failed, or the app closed while checking) can be checked again.
  const [error, setError] = useState<string | null>(() =>
    !grade && (record()?.answers.length ?? 0) > 0 ? 'Your answer was saved but not checked yet.' : null,
  );
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(performance.now());
  const area = useRef<HTMLTextAreaElement>(null);
  useEnter(grade ? onNext : null);
  useEffect(() => area.current?.focus(), []);

  const run = async (job: () => Promise<StoredGrade>) => {
    setBusy(true);
    setError(null);
    try {
      setGrade(await job());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    if (busy || !text.trim()) return;
    if (sample) return setGrade(sample);
    void run(() => engine.submitWriting(activity.activityId, text, Math.round(performance.now() - shownAt.current)));
  };
  const skip = async () => {
    if (!sample) await engine.recordInteraction(activity.activityId, { kind: 'skip' });
    onNext();
  };
  const pending = error !== null && (record()?.answers.length ?? 0) > 0;
  const used = grade ? new Set(grade.targetsUsed.map(catalog.resolve)) : null;

  return (
    <div className="jle-stack writing">
      <span className="jle-label">WRITE</span>
      <p className="cue-english">{spec.task}</p>
      <p className="t-body-sm jle-muted">
        About {spec.sentences} sentences. Try to use {targets.length > 1 ? 'these words' : 'this word'}:
      </p>
      <ul className="writing-words">
        {targets.map((t) => (
          <li key={t.id} className="writing-word">
            <Word item={t} furigana />
            <span className="t-body-sm jle-muted">{t.gloss[0]}</span>
            {used && (
              <span className={`jle-chip writing-used ${used.has(catalog.resolve(t.id)) ? 'yes' : ''}`}>
                {used.has(catalog.resolve(t.id)) ? 'Used well' : 'Not used well'}
              </span>
            )}
          </li>
        ))}
      </ul>
      {grade ? (
        <>
          <WritingFeedback grade={grade} sample={!!sample} />
          <NextButton onNext={onNext} />
        </>
      ) : !engine.canWrite && !sample ? (
        <>
          <div className="jle-note jle-note-neutral writing-comment" role="status">
            <b>Not available here.</b>
            <span>Free writing is checked by Claude, so it needs the desktop app and an API key (Settings).</span>
          </div>
          <button className="jle-btn jle-btn-primary wide-btn" onClick={() => void skip()} autoFocus>
            Skip
          </button>
        </>
      ) : (
        <form
          className="jle-stack"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            ref={area}
            className="jle-input writing-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            lang="ja"
            aria-label="Your writing"
            placeholder="Write in Japanese"
            readOnly={busy || pending}
            rows={5}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {sample && <p className="t-body-sm jle-muted">Sample: Submit shows fixed feedback on this answer. Nothing is sent to Claude.</p>}
          {error && (
            <div className="jle-note jle-note-bad writing-comment" role="alert">
              <b>Not checked.</b>
              <span>{error}</span>
            </div>
          )}
          {pending ? (
            <div className="answer-actions">
              <button type="button" className="jle-btn jle-btn-primary" disabled={busy} onClick={() => void run(() => engine.regrade(activity.activityId))}>
                {busy ? 'Checking…' : 'Try again'}
              </button>
            </div>
          ) : (
            <div className="answer-actions">
              <button type="submit" className="jle-btn jle-btn-primary" disabled={!text.trim() || busy}>
                {busy ? 'Checking…' : 'Submit'}
              </button>
              {!busy && <span className="jle-caption">⌘ Enter to submit</span>}
            </div>
          )}
          {!busy && (
            <button type="button" className="link-btn skip" onClick={() => void skip()}>
              Skip
            </button>
          )}
        </form>
      )}
    </div>
  );
}

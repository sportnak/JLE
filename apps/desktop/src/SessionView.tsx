import type { ActivityView, Engine, Feedback, Item, SessionRecap } from '@jle/engine';
import { useEffect, useRef, useState } from 'react';
import { toKana } from 'wanakana';
import { speak } from './host';
import { FontChips, SpeedChoice, VoiceSelect } from './Controls';
import { JaText, PlayButton, StatusChip, Word, Zoom } from './ui';

interface Props {
  engine: Engine;
  sessionId: string;
  examples: Map<string, Item>;
  onExit: () => void;
  onKeepGoing: () => void;
}

export function SessionView({ engine, sessionId, examples, onExit, onKeepGoing }: Props) {
  const [activity, setActivity] = useState<ActivityView | null>(null);
  const [recap, setRecap] = useState<SessionRecap | null>(null);
  const session = engine.learner.sessions.get(sessionId);
  const clock = useSessionClock(engine, sessionId);
  const [panelOpen, setPanelOpen] = useState(false);

  const advance = async () => {
    const next = await engine.nextActivity(sessionId);
    if (next.done) setRecap(next.recap);
    else setActivity(next.activity);
  };

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const last = session?.activityIds.at(-1);
    if (last && !engine.learner.activities.get(last)?.completed) setActivity(engine.view(last));
    else void advance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const complete = async () => {
    if (activity) await engine.completeActivity(activity.activityId);
    await advance();
  };

  const endSession = async () => {
    if (activity && !engine.learner.activities.get(activity.activityId)?.completed) {
      await engine.completeActivity(activity.activityId);
    }
    onExit();
  };

  if (recap) return <Recap recap={recap} engine={engine} session={session} onDone={onExit} onKeepGoing={onKeepGoing} />;

  const totalMs = clock.minutes * 60_000;
  const leftMin = Math.max(0, Math.round(clock.remainingMs / 60_000));

  return (
    <section className="session">
      <header className="session-bar">
        <button className="jle-btn icon-btn" aria-label="End session" onClick={endSession}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <div
          className="session-track"
          role="progressbar"
          aria-label="Session time"
          aria-valuemin={0}
          aria-valuemax={clock.minutes}
          aria-valuenow={Math.round((clock.elapsedMs / 60_000) * 10) / 10}
        >
          <div className="session-fill" style={{ width: `${Math.min(100, (clock.elapsedMs / totalMs) * 100)}%` }} />
        </div>
        <span className="jle-caption">{leftMin <= 1 ? 'about a minute left' : `about ${leftMin} min left`}</span>
        <button
          className="jle-btn"
          aria-expanded={panelOpen}
          aria-controls="lesson-settings"
          onClick={() => setPanelOpen((o) => !o)}
        >
          Settings
        </button>
      </header>
      {panelOpen && <LessonSettings onClose={() => setPanelOpen(false)} />}
      {activity && (
        <div className="jle-card activity">
          {activity.spec.type === 'introduce' ? (
            <Introduce key={activity.activityId} item={activity.item} example={examples.get(activity.item.id)} onNext={complete} />
          ) : (
            <Retrieval
              key={activity.activityId}
              engine={engine}
              activity={activity}
              example={examples.get(activity.item.id)}
              onNext={complete}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** Speed, voice and font, changeable without leaving the lesson. Each applies at once. */
function LessonSettings({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <section id="lesson-settings" className="jle-card lesson-settings" aria-label="Lesson settings">
      <div className="setting-row">
        <span className="jle-label">SPEED</span>
        <SpeedChoice />
      </div>
      <div className="setting-row">
        <span className="jle-label">VOICE</span>
        <VoiceSelect />
      </div>
      <div className="setting-row">
        <span className="jle-label">JAPANESE FONT</span>
        <FontChips />
      </div>
      <button className="jle-btn lesson-settings-done" onClick={onClose}>
        Back to the lesson
      </button>
    </section>
  );
}

/** The session timer, re-read twice a second so the bar keeps moving between prompts. */
function useSessionClock(engine: Engine, sessionId: string) {
  const read = () => engine.sessionClock(sessionId);
  const [clock, setClock] = useState(read);
  useEffect(() => {
    const id = window.setInterval(() => setClock(read()), 500);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, sessionId]);
  return clock;
}

function KanaExample({ word }: { word: Item | undefined }) {
  if (!word) return null;
  return (
    <div className="example">
      <span className="jle-label">IN A WORD</span>
      <div className="jle-row">
        <Word item={word} furigana className="t-reading" />
        <span className="t-body-sm jle-muted">{word.gloss[0]}</span>
        <PlayButton text={word.reading} label="Play word" />
      </div>
    </div>
  );
}

function Introduce({ item, example, onNext }: { item: Item; example: Item | undefined; onNext: () => void }) {
  useEnter(onNext);
  useEffect(() => void speak(item.reading), [item.reading]);
  return (
    <div className="jle-stack">
      <span className="jle-label">NEW</span>
      {item.type === 'script' ? (
        <>
          <div className="glyph" lang="ja">
            {item.written}
          </div>
          <KanaExample word={example} />
        </>
      ) : (
        <>
          <Word item={item} furigana className="cue-word" />
          <p className="t-body">{item.gloss.join('; ')}</p>
        </>
      )}
      <div className="jle-row">
        <PlayButton text={item.reading} label="Play again" />
      </div>
      <button className="jle-btn jle-btn-primary wide-btn" onClick={onNext}>
        Next
      </button>
    </div>
  );
}

const LABELS = {
  kana_to_reading: 'HOW DOES THIS SOUND?',
  ja_to_en: 'WHAT DOES IT MEAN?',
  en_to_ja: 'IN JAPANESE',
} as const;

interface RetrievalProps {
  engine: Engine;
  activity: ActivityView;
  example: Item | undefined;
  onNext: () => void;
}

function Retrieval({ engine, activity, example, onNext }: RetrievalProps) {
  const spec = activity.spec;
  const { item } = activity;
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(performance.now());
  const input = useRef<HTMLInputElement>(null);
  const finished = feedback !== null && feedback.kind !== 'retry';
  useEffect(() => input.current?.focus(), [feedback]);
  useEnter(finished ? onNext : null);
  if (spec.type !== 'retrieval') return null;
  const cue = spec.cue;
  const liveKana = cue === 'en_to_ja';

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
    if (kind === 'dispute') return setFeedback({ kind: 'correct', expected: expectedOf(feedback), note: 'Counted as right.' });
    if (fb.kind === 'retry') setText('');
    if ((fb.kind === 'incorrect' || fb.kind === 'revealed') && cue !== 'ja_to_en') void speak(item.reading);
    setFeedback(fb);
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    const composing = (e.nativeEvent as InputEvent).isComposing;
    setText(liveKana && !composing ? toKana(value, { IMEMode: true }) : value);
  };

  return (
    <div className="jle-stack">
      <span className="jle-label">{LABELS[cue]}</span>
      {cue === 'kana_to_reading' && (
        <div className="glyph" lang="ja">
          {item.written}
        </div>
      )}
      {cue === 'ja_to_en' && <Word item={item} furigana={spec.showFurigana} className="cue-word" />}
      {cue === 'en_to_ja' && <p className="cue-english">{item.gloss.join('; ')}</p>}

      {!finished && (
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
            lang={cue === 'ja_to_en' ? 'en' : 'ja'}
            aria-label="Your answer"
            placeholder={cue === 'ja_to_en' ? 'Type the meaning in English' : cue === 'en_to_ja' ? 'Type it in Japanese' : 'Type the sound'}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {feedback?.kind === 'retry' && (
            <div className="jle-note jle-note-neutral" role="status">
              <b>Look again.</b>
              {feedback.message}
            </div>
          )}
          <div className="answer-actions">
            <button type="submit" className="jle-btn jle-btn-primary" disabled={!text.trim() || busy}>
              Check
            </button>
            <button type="button" className="jle-btn jle-btn-dk" onClick={() => send('dont_know')} disabled={busy}>
              I don't know
            </button>
          </div>
          <button type="button" className="link-btn skip" onClick={() => send('skip')} disabled={busy}>
            Skip
          </button>
        </form>
      )}

      {finished && feedback && (
        <>
          <Note feedback={feedback} item={item} cue={cue} />
          {cue === 'kana_to_reading' && feedback.kind !== 'correct' && <KanaExample word={example} />}
          {(cue !== 'ja_to_en' || (feedback.kind === 'incorrect' && feedback.canDispute)) && (
            <div className="jle-row">
              {cue !== 'ja_to_en' && <PlayButton text={item.reading} />}
              {feedback.kind === 'incorrect' && feedback.canDispute && (
                <button className="jle-btn" onClick={() => send('dispute')}>
                  Count it as right
                </button>
              )}
            </div>
          )}
          <button className="jle-btn jle-btn-primary wide-btn" onClick={onNext} autoFocus>
            Next
          </button>
          <button
            className="link-btn flag"
            onClick={async () => {
              await engine.flagContent(activity.activityId, 'learner flag');
              onNext();
            }}
          >
            Flag as wrong or unnatural
          </button>
        </>
      )}
    </div>
  );
}

function Note({ feedback, item, cue }: { feedback: Feedback; item: Item; cue: string }) {
  const answer =
    cue === 'ja_to_en' ? (
      <span>{expectedOf(feedback)}</span>
    ) : (
      <Zoom text={item.written} reading={item.reading}>
        <Word item={item} furigana />
      </Zoom>
    );
  if (feedback.kind === 'correct') {
    return (
      <div className="jle-note jle-note-good" role="status">
        <b>Yes.</b>
        <span>{answer}</span>
        {feedback.note && (
          <span className="note-why">
            <JaText text={feedback.note} />
          </span>
        )}
      </div>
    );
  }
  if (feedback.kind === 'revealed') {
    return (
      <div className="jle-note jle-note-neutral" role="status">
        <b>Noted.</b>
        <span>No guess needed. It is: {answer}</span>
      </div>
    );
  }
  return (
    <div className="jle-note jle-note-bad" role="status">
      <b>Not quite.</b>
      <span>It is: {answer}</span>
      {feedback.kind === 'incorrect' && feedback.note && (
        <span className="note-why">
          <JaText text={feedback.note} />
        </span>
      )}
    </div>
  );
}

function expectedOf(fb: Feedback | null): string {
  return fb && 'expected' in fb ? fb.expected : '';
}

function useEnter(handler: (() => void) | null) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || !ref.current) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLButtonElement || t instanceof HTMLSelectElement) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

interface RecapProps {
  recap: SessionRecap;
  engine: Engine;
  session: { startedAt: string; activityIds: string[] } | undefined;
  onDone: () => void;
  onKeepGoing: () => void;
}

function Recap({ recap, engine, session, onDone, onKeepGoing }: RecapProps) {
  useEnter(onDone);
  const [flagging, setFlagging] = useState(false);
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const item = (id: string) => engine.learner.items.get(id)!;
  const corrections = recap.corrections.slice(0, 3);
  const newItems = recap.newItems.map(item);
  const changes = recap.changes.filter((c, i, all) => all.findIndex((o) => o.itemId === c.itemId) === i);
  const minutes = session ? Math.max(1, Math.round((Date.now() - new Date(session.startedAt).getTime()) / 60_000)) : 0;
  const prompts = (session?.activityIds ?? [])
    .map((id) => engine.learner.activities.get(id))
    .filter((a): a is NonNullable<typeof a> => !!a && a.spec.type === 'retrieval');

  const flag = async (activityId: string) => {
    await engine.flagContent(activityId, 'learner flag from recap');
    setFlagged((f) => new Set(f).add(activityId));
  };

  return (
    <section className="page recap">
      <div>
        <h1 className="t-title">Recap</h1>
        <p className="t-body-sm jle-muted">
          {recap.activities} {recap.activities === 1 ? 'prompt' : 'prompts'}, {minutes} {minutes === 1 ? 'minute' : 'minutes'}.
        </p>
      </div>

      {corrections.length > 0 && (
        <div className="jle-card recap-card">
          <span className="jle-label">WORTH A SECOND LOOK</span>
          <ul className="jle-recap-list">
            {corrections.map((c) => {
              const it = item(c.itemId);
              return (
                <li key={c.itemId}>
                  <span className="jle-jp" lang="ja">
                    {c.given ? (
                      <>
                        <span className="jle-wrong">{c.given}</span> <span className="jle-arrow">→</span>{' '}
                      </>
                    ) : null}
                    <span className="jle-right">{it.type === 'vocab' ? it.written : c.expected}</span>
                  </span>
                  <span className="jle-caption">
                    {c.given ? '' : 'You said you did not know. '}
                    {it.type === 'vocab' ? `${it.reading} · ${it.gloss[0]}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {newItems.length > 0 && (
        <div className="jle-card recap-card">
          <span className="jle-label">NEW TODAY</span>
          <div className="jle-recap-items">
            {newItems.map((it) => (
              <span key={it.id} className="jle-item">
                <span className="jle-jp" lang="ja">
                  {it.written}
                </span>
                {it.type === 'vocab' && (
                  <span className="jle-caption">
                    {it.reading !== it.written ? `${it.reading} · ` : ''}
                    {it.gloss[0]}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {changes.length > 0 && (
        <div className="jle-card recap-card">
          <span className="jle-label">WHAT MOVED</span>
          <ul className="jle-recap-list">
            {changes.map((c) => (
              <li key={`${c.itemId}-${c.skill}`} className="jle-change">
                <span className="jle-jp" lang="ja">
                  {item(c.itemId).written}
                </span>
                <StatusChip status={c.from} />
                <span className="jle-arrow" aria-hidden>
                  →
                </span>
                <StatusChip status={c.to} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {prompts.length > 0 && (
        <div>
          <button className="link-btn flag" aria-expanded={flagging} onClick={() => setFlagging((f) => !f)}>
            Something looked wrong or unnatural? Flag it
          </button>
          {flagging && (
            <div className="flag-list">
              <p className="jle-caption">Choose the prompt. Anything you learned from it is set aside.</p>
              <div className="jle-row">
                {prompts.map((a) => (
                  <button
                    key={a.id}
                    className="jle-btn"
                    lang="ja"
                    disabled={flagged.has(a.id)}
                    onClick={() => flag(a.id)}
                  >
                    {item(a.spec.itemId).written}
                    {flagged.has(a.id) ? ' · flagged' : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="recap-actions">
        <button className="jle-btn jle-btn-primary wide-btn" onClick={onDone} autoFocus>
          Finish for today
        </button>
        <button className="jle-btn wide-btn" onClick={onKeepGoing}>
          Keep going for 10 minutes
        </button>
      </div>
    </section>
  );
}

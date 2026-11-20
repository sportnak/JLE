import { Engine, MemoryEventStore, type ActivitySpec, type ActivityView, type Catalog, type ContentToken, type Item, type StoredContent } from '@jle/engine';
import { useRef, useState } from 'react';
import { RENDERERS } from './SessionView';

interface Demo {
  key: string;
  title: string;
  about: string;
  spec: (catalog: Catalog, run: number) => ActivitySpec | null;
}

const vocab = (c: Catalog) =>
  c.clusters()
    .filter((k) => k.track === 'vocab')
    .sort((a, b) => a.order - b.order)
    .flatMap((k) => c.inCluster(k.id));
const kana = (c: Catalog) => c.inCluster('hiragana-basic');
const withKanji = (c: Catalog) => vocab(c).filter((i) => i.written !== i.reading);
const sounds = (c: Catalog) => c.inCluster('sound-features').filter((i) => c.pairsFor(i.id).length > 0);
const pick = <T,>(list: T[], run: number): T | undefined => list[run % Math.max(1, list.length)];

/** A fixed passage for the demo, so reading can be tried without an API key. Starter words are tracked. */
const SAMPLE: [surface: string, reading: string, word?: string][] = [
  ['私', 'わたし', '私'], ['は', 'は'], ['毎日', 'まいにち', '毎日'], ['コーヒー', 'こーひー', 'コーヒー'], ['を', 'を'],
  ['飲み', 'のみ', '飲む'], ['ます', 'ます'], ['。', ''], ['今日', 'きょう', '今日'], ['は', 'は'], ['友達', 'ともだち', '友達'],
  ['と', 'と'], ['学校', 'がっこう', '学校'], ['へ', 'へ'], ['行き', 'いき', '行く'], ['まし', 'まし'], ['た', 'た'], ['。', ''],
];

function sampleContent(catalog: Catalog): StoredContent {
  const words = vocab(catalog);
  let at = 0;
  const tokens: ContentToken[] = SAMPLE.map(([surface, reading, word]) => {
    const itemId = word ? words.find((w) => w.written === word)?.id : undefined;
    const t = { surface, reading, begin: at, end: at + [...surface].length, ...(itemId ? { itemId } : {}) };
    at = t.end;
    return t;
  });
  const items = [...new Set(tokens.flatMap((t) => (t.itemId ? [t.itemId] : [])))].map((id) => catalog.item(id)!);
  return {
    id: 'demo:reading',
    learnerId: 'demo',
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'learner',
    promptVersion: 'demo',
    model: 'none',
    title: '毎日',
    text: tokens.map((t) => t.surface).join(''),
    translation: 'I drink coffee every day. Today I went to school with a friend.',
    tokens,
    items,
    targets: items.slice(0, 1).map((i) => i.id),
    coverage: 1,
  };
}

/** Every activity the app has, and each way it can be shown. */
const DEMOS: Demo[] = [
  {
    key: 'introduce-kana',
    title: 'New kana',
    about: 'A kana is shown and heard before you are asked for it, with a word that uses it.',
    spec: (c, run) => {
      const k = pick(kana(c), run);
      return k ? { type: 'introduce', itemId: k.id } : null;
    },
  },
  {
    key: 'introduce-word',
    title: 'New word',
    about: 'A word you missed is taught: written form with furigana, meaning and sound.',
    spec: (c, run) => {
      const w = pick(withKanji(c), run);
      return w ? { type: 'introduce', itemId: w.id } : null;
    },
  },
  {
    key: 'introduce-sound',
    title: 'New sound',
    about: 'A sound feature such as vowel length is taught with one pair of words heard in turn.',
    spec: (c, run) => {
      const s = pick(sounds(c), run);
      const pair = s && pick(c.pairsFor(s.id), run);
      return s && pair ? { type: 'introduce', itemId: s.id, pairId: pair.id } : null;
    },
  },
  {
    key: 'kana-reading',
    title: 'Read a kana',
    about: 'Type the sound of a kana. A near miss gets a second try.',
    spec: (c, run) => {
      const k = pick(kana(c), run + 3);
      return k ? { type: 'retrieval', itemId: k.id, cue: 'kana_to_reading', purpose: 'practice', showFurigana: false } : null;
    },
  },
  {
    key: 'word-meaning',
    title: 'Meaning of a word',
    about: 'Type the English meaning of a Japanese word.',
    spec: (c, run) => {
      const w = pick(withKanji(c), run + 1);
      return w ? { type: 'retrieval', itemId: w.id, cue: 'ja_to_en', purpose: 'practice', showFurigana: true } : null;
    },
  },
  {
    key: 'word-japanese',
    title: 'Say it in Japanese',
    about: 'Type the Japanese for an English meaning. Romaji turns into kana as you type.',
    spec: (c, run) => {
      const w = pick(vocab(c), run + 2);
      return w ? { type: 'retrieval', itemId: w.id, cue: 'en_to_ja', purpose: 'practice', showFurigana: false } : null;
    },
  },
  {
    key: 'minimal-pair',
    title: 'Which did you hear?',
    about: 'One of two words that differ in a single sound is played; pick which one.',
    spec: (c, run) => {
      const s = pick(sounds(c), run);
      const pair = s && pick(c.pairsFor(s.id), run);
      if (!s || !pair) return null;
      const options: [string, string] = run % 2 ? [pair.b.kana, pair.a.kana] : [pair.a.kana, pair.b.kana];
      return { type: 'minimal_pair', itemId: s.id, purpose: 'practice', pairId: pair.id, options, answer: run % 3 ? pair.a.kana : pair.b.kana };
    },
  },
  {
    key: 'reading',
    title: 'Read a passage',
    about: 'A short passage with furigana on words you don\'t know yet. Tap a word to look it up. In lessons, passages are written for your level.',
    spec: (c) => {
      const content = sampleContent(c);
      return { type: 'reading', itemId: content.targets[0]!, purpose: 'practice', contentId: content.id, chars: [...content.text].length };
    },
  },
  {
    key: 'dictation',
    title: 'Write what you hear',
    about: 'A short sentence of words you know is played; type it in kana.',
    spec: (c, run) => {
      const sentences = vocab(c).flatMap((w) => c.sentencesWith(w.id).map((s) => ({ w, s })));
      const hit = pick(sentences, run * 7);
      return hit ? { type: 'dictation', itemId: hit.w.id, purpose: 'practice', sentenceId: hit.s.id, segments: hit.s.segments } : null;
    },
  },
];

/**
 * Every activity, one at a time, on a throwaway engine. Answers here are graded as usual but kept in memory only:
 * nothing reaches your study log.
 */
export function ActivityDemo({ catalog, examples, onBack }: { catalog: Catalog; examples: Map<string, Item>; onBack: () => void }) {
  const demo = useRef<{ engine: Engine; sessionId: string } | null>(null);
  const runs = useRef(new Map<string, number>());
  const [open, setOpen] = useState<{ title: string; activity: ActivityView } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async (d: Demo) => {
    setError(null);
    try {
      if (!demo.current) {
        const engine = await Engine.create({ catalog, store: new MemoryEventStore(), learnerId: 'demo' });
        const { sessionId } = await engine.startSession(60);
        demo.current = { engine, sessionId };
      }
      const run = runs.current.get(d.key) ?? 0;
      runs.current.set(d.key, run + 1);
      const spec = d.spec(catalog, run);
      if (!spec) return setError(`Nothing in the catalog to show "${d.title}" with.`);
      if (spec.type === 'reading') demo.current.engine.adoptContent(sampleContent(catalog));
      setOpen({ title: d.title, activity: await demo.current.engine.startActivity(demo.current.sessionId, spec, 'demo') });
    } catch (e) {
      setError(String(e));
    }
  };

  const close = async () => {
    if (open && demo.current) await demo.current.engine.completeActivity(open.activity.activityId);
    setOpen(null);
  };

  if (open && demo.current) {
    const { engine } = demo.current;
    return (
      <section className="page">
        <div className="demo-bar">
          <button className="jle-btn" onClick={() => void close()}>
            All activities
          </button>
          <span className="jle-caption">{open.title}. Not saved to your log.</span>
        </div>
        <div className="jle-card activity" key={open.activity.activityId}>
          {RENDERERS[open.activity.spec.type]({
            engine,
            activity: open.activity,
            example: examples.get(open.activity.item.id),
            onNext: () => void close(),
          })}
        </div>
      </section>
    );
  }

  return (
    <section className="page">
      <div className="demo-bar">
        <button className="jle-btn" onClick={onBack}>
          Back to settings
        </button>
      </div>
      <div>
        <h1 className="t-title">Activities</h1>
        <p className="t-body jle-muted">
          Every activity the app can give you. Try any of them: answers are checked as in a lesson, but nothing here is
          saved to your study log. Each try shows a different example.
        </p>
      </div>
      {error && <p className="t-body-sm jle-wrong">{error}</p>}
      <ul className="demo-list">
        {DEMOS.map((d) => (
          <li key={d.key} className="setting">
            <div>
              <h2 className="t-heading">{d.title}</h2>
              <p className="t-body-sm jle-muted">{d.about}</p>
            </div>
            <button className="jle-btn" onClick={() => void start(d)}>
              Try it
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

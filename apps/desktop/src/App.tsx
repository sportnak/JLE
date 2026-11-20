import { Engine } from '@jle/engine';
import { LIBRARY, buildCatalog, buildCatalogData } from '@jle/seed';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityDemo } from './Demo';
import { Home } from './Home';
import { Progress } from './Progress';
import { SessionView } from './SessionView';
import { Settings } from './Settings';
import { apiKeyStatus, contentStore, dictionary, inTauri, llm, store, tokenizer } from './host';
import { exampleWords } from './ui';

export const LEARNER_ID = 'local';
const catalog = buildCatalog();

type Screen = { name: 'home' } | { name: 'session'; sessionId: string } | { name: 'progress' } | { name: 'settings' } | { name: 'demo' };
const TABS = [
  { name: 'home', label: 'Today' },
  { name: 'progress', label: 'Progress' },
] as const;

export function App() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [version, setVersion] = useState(0);
  const examples = useMemo(() => exampleWords(buildCatalogData()), []);

  const load = useCallback(async () => {
    try {
      // Reading needs the host (tokenizer, dictionary, stored content). With an API key, passages are written for you;
      // without one, or offline, the best-fitting built-in passage is used.
      const reading = inTauri
        ? { tokenizer, dictionary, contents: contentStore, library: LIBRARY, ...((await apiKeyStatus()) ? { llm } : {}) }
        : {};
      const engine = await Engine.create({ catalog, store, learnerId: LEARNER_ID, ...reading });
      if (import.meta.env.DEV) (window as unknown as { jle: Engine }).jle = engine;
      setEngine(engine);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="jle shell-message">Could not open your study log: {error}</p>;
  if (!engine) return <p className="jle shell-message">Opening…</p>;
  const refresh = () => setVersion((v) => v + 1);
  const startSession = async (minutes: number) => {
    const { sessionId } = await engine.startSession(minutes);
    setScreen({ name: 'session', sessionId });
  };

  if (screen.name === 'session') {
    return (
      <div className="jle shell">
        <main className="main">
          <SessionView
            key={screen.sessionId}
            engine={engine}
            sessionId={screen.sessionId}
            examples={examples}
            onExit={() => {
              refresh();
              setScreen({ name: 'home' });
            }}
            onKeepGoing={() => void startSession(10)}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="jle shell with-tabs">
      <header className="topbar">
        <span className="app-name">Japanese Learning Engine</span>
        <nav className="tabs" aria-label="Main">
          {TABS.map((t) => (
            <button
              key={t.name}
              className="tab"
              aria-current={screen.name === t.name ? 'page' : undefined}
              onClick={() => setScreen({ name: t.name } as Screen)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button
          className="jle-btn"
          aria-current={screen.name === 'settings' || screen.name === 'demo' ? 'page' : undefined}
          onClick={() => setScreen({ name: 'settings' })}
        >
          Settings
        </button>
      </header>
      <main className="main">
        {screen.name === 'home' && <Home key={version} engine={engine} onStart={startSession} />}
        {screen.name === 'progress' && <Progress key={version} engine={engine} onChange={refresh} />}
        {screen.name === 'settings' && <Settings engine={engine} onReset={load} onDemo={() => setScreen({ name: 'demo' })} />}
        {screen.name === 'demo' && (
          <ActivityDemo catalog={catalog} examples={examples} onBack={() => setScreen({ name: 'settings' })} />
        )}
      </main>
    </div>
  );
}

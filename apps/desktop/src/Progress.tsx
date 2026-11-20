import type { Engine, ItemRow } from '@jle/engine';
import { useMemo, useState } from 'react';
import { StatusChip } from './ui';

const SKILL = { read: 'recognition', write: 'production', listen: 'listening', speak: 'speaking' } as const;

const STRANDS = [
  { key: 'input', label: 'Input', color: 'var(--indigo)' },
  { key: 'output', label: 'Output', color: 'var(--vermilion)' },
  { key: 'study', label: 'Deliberate study', color: 'var(--ochre)' },
  { key: 'fluency', label: 'Fluency', color: 'var(--moss)' },
] as const;

function startOfWeek(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export function Progress({ engine, onChange }: { engine: Engine; onChange: () => void }) {
  const state = engine.getLearnerState();
  const week = startOfWeek();
  const minutes = engine.strandMinutes(week);
  const totalMinutes = Object.values(minutes).reduce((a, b) => a + b, 0);
  const added = engine.knownAddedSince(week);
  const comingUp = engine.comingUp(3);
  const labels = new Map(engine.learner.catalog.clusters().map((c) => [c.id, c.label]));

  return (
    <section className="page">
      <h1 className="t-title">Progress</h1>

      <div className="jle-card stat-card">
        <span className="jle-label">NEW TEXT YOU HAVE NOT SEEN</span>
        <span className="big-number">–</span>
        <span className="jle-caption">
          The share of questions you answer correctly on new reading at your level. It appears once you have read
          some.
        </span>
      </div>

      <div className="jle-card stat-card">
        <span className="jle-label">THIS WEEK, BY STRAND</span>
        {totalMinutes > 0 ? (
          <div className="jle-strands">
            <div className="jle-strand-bar" role="img" aria-label="Minutes per strand this week">
              {STRANDS.filter((s) => minutes[s.key] > 0).map((s) => (
                <div
                  key={s.key}
                  className="jle-strand-seg"
                  style={{ flexGrow: (minutes[s.key] / totalMinutes) * 100, background: s.color }}
                />
              ))}
            </div>
            <div className="jle-strand-key">
              {STRANDS.map((s) => (
                <span key={s.key}>
                  <i style={{ background: s.color }} />
                  {s.label} {Math.round((minutes[s.key] / totalMinutes) * 100)}%
                </span>
              ))}
            </div>
          </div>
        ) : (
          <p className="t-body">No study yet this week.</p>
        )}
        <span className="jle-caption">
          {Math.round(totalMinutes)} {Math.round(totalMinutes) === 1 ? 'minute' : 'minutes'}. The first weeks lean toward
          study while kana and first words are built.
        </span>
      </div>

      <div className="jle-card stat-card">
        <span className="jle-label">KNOWN, ADDED THIS WEEK</span>
        <dl className="rows">
          {(
            [
              ['Kana', added.script],
              ['Words', added.vocab],
              ['Kanji', added.kanji],
              ['Grammar points', added.grammar],
            ] as const
          ).map(([label, n]) => (
            <div key={label} className="row">
              <dt className="t-body">{label}</dt>
              <dd className="jle-num">+{n ?? 0}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="jle-card stat-card">
        <span className="jle-label">COMING UP</span>
        {comingUp.length > 0 ? (
          <dl className="rows">
            {comingUp.map((it) => (
              <div key={it.id} className="row">
                <dt className="t-reading" lang="ja">
                  {it.written}
                </dt>
                <dd className="jle-caption">{labels.get(it.cluster)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="t-body">Everything in reach has been started.</p>
        )}
      </div>

      <details className="all-items">
        <summary className="t-heading">Every item</summary>
        <ItemTable engine={engine} state={state} onChange={onChange} />
      </details>
    </section>
  );
}

function ItemTable({
  engine,
  state,
  onChange,
}: {
  engine: Engine;
  state: ReturnType<Engine['getLearnerState']>;
  onChange: () => void;
}) {
  const [cluster, setCluster] = useState(state.placement[0]?.cluster ?? '');
  const threshold = engine.learner.config.model.knownThreshold;

  const rows = useMemo(() => {
    const byItem = new Map<string, { item: ItemRow['item']; skills: ItemRow[] }>();
    for (const row of engine.clusterRows(cluster)) {
      const entry = byItem.get(row.item.id) ?? { item: row.item, skills: [] };
      entry.skills.push(row);
      byItem.set(row.item.id, entry);
    }
    return [...byItem.values()];
  }, [engine, state, cluster]);

  const markKnown = async (itemId: string) => {
    await engine.overrideItem(itemId);
    onChange();
  };

  return (
    <div className="all-items-body">
      <div className="counts">
        {(['learning', 'known', 'maintained', 'introduced', 'leech'] as const).map((s) => (
          <div key={s} className="count">
            <span className="jle-num t-heading">{state.counts[s]}</span>
            <StatusChip status={s} />
          </div>
        ))}
      </div>
      {state.retention.n > 0 && (
        <p className="t-body-sm jle-muted">
          Over the last 7 days you recalled {Math.round(state.retention.rate * 100)}% of due items ({state.retention.n}{' '}
          reviews).
        </p>
      )}

      <div className="groups" role="tablist" aria-label="Groups">
        {state.placement.map((p) => (
          <button
            key={p.cluster}
            role="tab"
            aria-selected={p.cluster === cluster}
            className="jle-btn group"
            onClick={() => setCluster(p.cluster)}
          >
            <span>{p.label}</span>
            <span className="t-body-sm jle-muted">
              {p.placement === 'unplaced' ? 'Not placed yet' : p.placement === 'known' ? 'Probably known' : 'To learn'}
              {p.inferred ? ', inferred' : ''}
            </span>
          </button>
        ))}
      </div>

      <div className="table-scroll">
        <table className="items">
          <thead>
            <tr>
              <th className="jle-label">ITEM</th>
              <th className="jle-label">SKILL</th>
              <th className="jle-label">STATUS</th>
              <th className="jle-label">P_KNOWN</th>
              <th className="jle-label">NEXT REVIEW</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.flatMap(({ item, skills }) =>
              skills.map((s, i) => (
                <tr key={`${item.id}-${s.skill}`}>
                  {i === 0 && (
                    <td rowSpan={skills.length}>
                      <span className="t-reading" lang="ja">
                        {item.written}
                      </span>
                      {item.type === 'vocab' && <div className="t-body-sm jle-muted">{item.gloss[0]}</div>}
                    </td>
                  )}
                  <td className="t-body-sm">{SKILL[s.skill]}</td>
                  <td>
                    <StatusChip status={s.status} />
                  </td>
                  <td>
                    <div className="mini-meter" title={`Known at ${threshold}`}>
                      <div className="jle-meter-track">
                        <div
                          className={`jle-meter-fill ${s.pKnown >= threshold ? 'is-known' : ''}`}
                          style={{ width: `${Math.round(s.pKnown * 100)}%` }}
                        />
                        <div className="jle-meter-mark" style={{ left: `${threshold * 100}%` }} />
                      </div>
                      <span className="jle-num t-body-sm">{s.pKnown.toFixed(2)}</span>
                    </div>
                  </td>
                  <td className="t-body-sm jle-muted">{s.dueAt ? new Date(s.dueAt).toLocaleDateString() : '–'}</td>
                  {i === 0 && (
                    <td rowSpan={skills.length}>
                      {skills.every((k) => k.status !== 'known' && k.status !== 'maintained') && (
                        <button className="link-btn" onClick={() => markKnown(item.id)}>
                          I know this
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

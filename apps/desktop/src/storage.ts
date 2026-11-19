import type { EventStore, InteractionEvent } from '@jle/engine';

/**
 * Browser-only event store used until the Tauri SQLite store lands. Only the
 * append-only log is persisted; learner state is always rebuilt from it.
 */
export class LocalStorageEventStore implements EventStore {
  constructor(private readonly key = 'jle.events.v1') {}

  private read(): InteractionEvent[] {
    try {
      return JSON.parse(localStorage.getItem(this.key) ?? '[]') as InteractionEvent[];
    } catch {
      return [];
    }
  }

  async load(learnerId: string) {
    return this.read().filter((e) => e.learnerId === learnerId);
  }

  async append(event: InteractionEvent) {
    const events = this.read();
    events.push(event);
    localStorage.setItem(this.key, JSON.stringify(events));
  }

  exportJson(): string {
    return JSON.stringify(this.read(), null, 2);
  }

  clear() {
    localStorage.removeItem(this.key);
  }
}

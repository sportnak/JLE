import type { InteractionEvent } from './types';

export interface Clock {
  now(): Date;
}

export interface Ids {
  next(): string;
}

export interface EventStore {
  load(learnerId: string): Promise<InteractionEvent[]>;
  append(event: InteractionEvent): Promise<void>;
}

export type LlmRoute = 'generate' | 'grade' | 'tutor' | 'explain' | 'review';

/** The model, behind the host. One interface, five routes. No implementation yet; code-graded activities never see it. */
export interface Llm {
  call(route: LlmRoute, request: { promptVersion: string; input: unknown }): Promise<{ output: unknown; stopReason: string }>;
}

export const systemClock: Clock = { now: () => new Date() };

export const randomIds: Ids = { next: () => crypto.randomUUID() };

export class MemoryEventStore implements EventStore {
  events: InteractionEvent[] = [];
  async load(learnerId: string) {
    return this.events.filter((e) => e.learnerId === learnerId);
  }
  async append(event: InteractionEvent) {
    this.events.push(event);
  }
}

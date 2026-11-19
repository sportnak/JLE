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

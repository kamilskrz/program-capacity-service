/** The one place a use case reads the current instant (docs/PLAN.md 2.4). */
export interface Clock {
  now(): Date;
}

/** Injection token for {@link Clock}. */
export const CLOCK = Symbol('Clock');

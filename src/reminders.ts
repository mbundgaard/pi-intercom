/** Operator override for the coordinator reminder interval, in whole minutes. Process environment only; never stored or echoed. */
const REMINDER_MINUTES_ENV = 'PI_INTERCOM_REMINDER_MINUTES';
const MIN_REMINDER_MINUTES = 1;
/** floor(2147483647 / 60000): 35791 * 60000 = 2147460000 stays inside Node's signed 32-bit timeout ceiling, while 35792 * 60000 = 2147520000 overflows it to a near-immediate tick. */
const MAX_REMINDER_MINUTES = 35791;
export const REMINDER_INTERVAL_MS = 5 * 60 * 1000;
/** Fixed operator diagnostic for unusable nonblank input. It never contains the supplied value. */
export const REMINDER_INVALID_INPUT_WARNING = `${REMINDER_MINUTES_ENV} is invalid; using the 5-minute default`;

export interface ReminderInterval {
  intervalMs: number;
  /** True only for explicit nonblank unusable input; missing or blank input stays quiet. */
  invalidInput: boolean;
}

/**
 * Trimmed ASCII decimal whole minutes, leading zeros allowed, 1-35791 inclusive.
 * Unset or blank returns the default without the marker; zero, signs, fractions,
 * exponents, nondecimal forms, suffixes, non-ASCII digits and unsafe or
 * out-of-range values return the default with it. No throw, clamp or disable, no
 * raw value in the result, and no notification side effect in this parser.
 */
export function parseReminderInterval(raw: string | undefined): ReminderInterval {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return { intervalMs: REMINDER_INTERVAL_MS, invalidInput: false };
  const digits = /^[0-9]+$/.test(trimmed);
  const minutes = digits ? Number(trimmed) : NaN;
  if (!digits || !Number.isSafeInteger(minutes) || minutes < MIN_REMINDER_MINUTES || minutes > MAX_REMINDER_MINUTES) {
    return { intervalMs: REMINDER_INTERVAL_MS, invalidInput: true };
  }
  return { intervalMs: minutes * 60 * 1000, invalidInput: false };
}

/** Production environment read. Callers snapshot once per runtime start and never reread while that runtime runs. */
export function readReminderMinutesEnv(): string | undefined { return process.env[REMINDER_MINUTES_ENV]; }

export const REMINDER_TEXT = 'Intercom reminder: Review outstanding delegated work and worker reports. If follow-up is needed, take the next appropriate action. Do not assume workers have finished or stopped.\n\nIf there is genuinely nothing to follow up on, call intercom_stop_reminders. Otherwise, reminders continue at the configured interval; a new worker call resets the timer.\n\nThis reminder does not authorize new work, retries, worker closure, or publication.';

export interface ReminderClock {
  schedule(callback: () => void, milliseconds: number): () => void;
}
const clock: ReminderClock = {
  schedule(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
interface ReminderHost {
  isCoordinator(): Promise<boolean>;
  busy(): boolean;
  deliver(text: string): void;
}
/** Ephemeral reminder only: never worker actions, network retries or a backlog. */
export class CoordinatorReminders {
  private generation = 0;
  private tick = 0;
  private checking = false;
  private disposed = false;
  private cancel?: () => void;
  private detachOwner?: () => void;
  /** intervalMs comes from a validated start-local snapshot; the scheduler receives milliseconds only and never revalidates operator input. */
  constructor(private readonly host: ReminderHost, private readonly timer: ReminderClock = clock, private readonly intervalMs: number = REMINDER_INTERVAL_MS) {}
  arm(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted) return;
    this.stop();
    const generation = this.generation;
    if (signal) {
      const abort = () => { if (this.generation === generation) this.stop(); };
      signal.addEventListener('abort', abort, { once: true });
      this.detachOwner = () => signal.removeEventListener('abort', abort);
    }
    this.schedule(generation);
  }
  stop(): void {
    this.generation++; this.tick++;
    this.cancel?.(); this.cancel = undefined;
    this.detachOwner?.(); this.detachOwner = undefined;
  }
  dispose(): void { this.stop(); this.disposed = true; }
  private current(generation: number, tick: number): boolean {
    return !this.disposed && this.generation === generation && this.tick === tick;
  }
  private schedule(generation: number): void {
    this.cancel = this.timer.schedule(() => {
      if (this.disposed || generation !== this.generation) return;
      this.cancel = undefined;
      const tick = ++this.tick;
      this.schedule(generation);
      // A slow role read never creates concurrent reads or a queued reminder.
      // Advancing tick also invalidates any read from the preceding interval.
      if (this.checking) return;
      this.checking = true;
      void (async () => {
        try {
          const coordinator = await this.host.isCoordinator();
          if (!this.current(generation, tick)) return;
          if (!coordinator) { this.stop(); return; }
          if (!this.host.busy()) this.host.deliver(REMINDER_TEXT);
        } catch { /* Unknown role/read/delivery outcome: no blind immediate replay. */ }
        finally { this.checking = false; }
      })();
    }, this.intervalMs);
  }
}

/**
 * Bounded read retry — the ceiling a dashboard read is allowed (#aisix-spa-e2e 08).
 *
 * Every dashboard read used to be a bare `fetch()` whose failure was reported by
 * raising a toast. On the AISIX static export that combination was a
 * self-sustaining loop, not a slow page:
 *
 *   1. the read 404s (the export ships no `/api/**` layer at all);
 *   2. the effect raises a toast;
 *   3. the toast mutates the global notification store, so the unselectored
 *      `useNotificationStore()` object the effect depended on is a NEW reference;
 *   4. the effect re-arms and re-issues the same GET — which 404s again.
 *
 * Measured on the deployed artifact: 47 repeats of one URL inside 5 s, ~70 req/s
 * aggregate, 1 933 requests by 27 s, and a renderer too starved to answer
 * `page.evaluate(() => 1)`. The loop had no ceiling, so the only honest fix is to
 * give a read one.
 *
 * THE POLICY — two outcomes, not one:
 *
 *   - `unsupported` (404/405) is PERMANENT BY ARCHITECTURE. A retry lands on the
 *     same 404, so a read in this class is issued ONCE and settles. On the static
 *     export the caller is expected not to issue it at all (see
 *     `resolveAisixSurfaceSupport`); this class is the backstop that makes a
 *     single fetch enough even when a caller does fire one.
 *   - `transient` (network failure, 5xx) is genuinely worth retrying, and gets
 *     bounded exponential backoff with jitter and a HARD attempt ceiling. It
 *     stops for good at `maxAttempts` — the ceiling is what makes "eventually"
 *     a fact rather than a hope.
 *   - `signedOut` (401/403) and `permanent` (any other 4xx) are settled after one
 *     attempt. 401/403 is a signed-out state owned by the session layer; a retry
 *     cannot mint a credential, and re-reporting it every second is noise.
 *
 * `null` data is never a substitute for zero: it means "not reported", and the
 * caller renders an honest refusal rather than an empty success.
 *
 * @module shared/utils/boundedReadRetry
 */

/**
 * How a single read attempt is classified. Kept as a string union so the
 * classification is legible in evidence output and in a test's expectation.
 */
export type BoundedReadClass =
  /** 2xx with a usable body. */
  | "ok"
  /** 404/405 — the endpoint is absent from this build. Never retried. */
  | "unsupported"
  /** 401/403 — signed out. Owned by the session layer, never retried here. */
  | "signedOut"
  /** Any other 4xx — the request itself is wrong; a retry cannot fix it. */
  | "permanent"
  /** Network failure (no response) or 5xx — the only class worth retrying. */
  | "transient";

/** The minimum an attempt has to report for the policy to classify it. */
export interface BoundedReadAttempt {
  ok: boolean;
  /** 404/405, as `fetchAisixJson` reports it. */
  missing: boolean;
  /** HTTP status, or `0` when the request never produced a response. */
  status: number;
  /** Transport/detail message for a non-2xx answer, or `null`. */
  error?: string | null;
  data?: unknown;
}

export interface BoundedReadPolicy {
  /**
   * Hard ceiling on total attempts, first try included. `1` disables retry
   * entirely. There is no code path that attempts more than this.
   */
  maxAttempts: number;
  /** Delay before the first retry; doubled per subsequent attempt. */
  baseDelayMs: number;
  /** Ceiling on the computed delay, applied before jitter. */
  maxDelayMs: number;
  /**
   * Fraction of the computed delay that jitter may add or remove, `0`–`1`. Two
   * tabs whose reads fail at the same instant must not retry in lockstep.
   */
  jitterRatio: number;
}

export const DEFAULT_BOUNDED_READ_POLICY: BoundedReadPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  jitterRatio: 0.5,
};

function sanitizePolicy(policy: BoundedReadPolicy): BoundedReadPolicy {
  const maxAttempts = Number.isFinite(policy.maxAttempts)
    ? Math.max(1, Math.floor(policy.maxAttempts))
    : 1;
  const baseDelayMs = Number.isFinite(policy.baseDelayMs) ? Math.max(0, policy.baseDelayMs) : 0;
  const maxDelayMs = Number.isFinite(policy.maxDelayMs)
    ? Math.max(baseDelayMs, policy.maxDelayMs)
    : baseDelayMs;
  const jitterRatio = Number.isFinite(policy.jitterRatio)
    ? Math.min(1, Math.max(0, policy.jitterRatio))
    : 0;
  return { maxAttempts, baseDelayMs, maxDelayMs, jitterRatio };
}

/**
 * Classify one attempt. `unsupported` is decided by the caller's `missing` flag
 * (which is where `fetchAisixJson` records 404/405) and only falls back to the
 * status, so a `missing: true` answer is never mistaken for transient.
 */
export function classifyBoundedRead(attempt: BoundedReadAttempt): BoundedReadClass {
  if (attempt.ok) return "ok";
  if (attempt.missing || attempt.status === 404 || attempt.status === 405) return "unsupported";
  if (attempt.status === 401 || attempt.status === 403) return "signedOut";
  if (attempt.status === 0) return "transient";
  if (attempt.status >= 500) return "transient";
  return "permanent";
}

/**
 * Delay before the retry that follows the failed `attempt` (1-based). Doubles
 * per attempt, capped at `maxDelayMs`, then jittered by ±`jitterRatio` and
 * clamped to `[0, maxDelayMs]`. `random` is injectable so the ceiling is
 * assertable without a clock.
 */
export function boundedReadBackoffDelayMs(
  attempt: number,
  policy: BoundedReadPolicy = DEFAULT_BOUNDED_READ_POLICY,
  random: () => number = Math.random
): number {
  const p = sanitizePolicy(policy);
  const failed = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  // `failed - 1` so the first failure waits `baseDelayMs`, not `2 * base`.
  const uncapped = p.baseDelayMs * 2 ** Math.min(failed - 1, 20);
  const capped = Math.min(p.maxDelayMs, uncapped);
  if (capped <= 0 || p.jitterRatio === 0) return Math.max(0, Math.round(capped));
  const roll = Math.min(1, Math.max(0, random()));
  // Map [0,1) → [-jitter, +jitter]: 0.5 leaves the delay unchanged.
  const spread = 1 + (roll * 2 - 1) * p.jitterRatio;
  return Math.max(0, Math.min(p.maxDelayMs, Math.round(capped * spread)));
}

/** A read is retried only if it is transient AND the ceiling leaves room. */
export function shouldRetryBoundedRead(
  attempt: BoundedReadAttempt,
  attemptNumber: number,
  policy: BoundedReadPolicy = DEFAULT_BOUNDED_READ_POLICY
): boolean {
  if (classifyBoundedRead(attempt) !== "transient") return false;
  return attemptNumber < sanitizePolicy(policy).maxAttempts;
}

export interface BoundedReadOutcome<T> {
  /** Parsed body on success, `null` on every other path. */
  data: T | null;
  ok: boolean;
  classification: BoundedReadClass;
  /** How many attempts were actually issued. Never exceeds `maxAttempts`. */
  attempts: number;
  status: number;
  error: string | null;
}

/**
 * The slice of `AbortSignal` this module observes. Structural on purpose: a test
 * may pass a plain `{ aborted: false }`, and a real `AbortController.signal`
 * satisfies it with no cast. The listener methods are what make a pending backoff
 * CANCELLABLE rather than merely checked between attempts.
 */
export interface BoundedReadAbortSignal {
  aborted: boolean;
  addEventListener?: (type: "abort", listener: () => void) => void;
  removeEventListener?: (type: "abort", listener: () => void) => void;
}

export interface BoundedReadHooks {
  /**
   * Backoff wait. The default is cancellable through `signal` (see `realSleep`);
   * a caller-supplied one receives the signal as a second argument and may ignore
   * it, in which case the loop's own checks bound the wait the same way.
   */
  sleep?: (ms: number, signal?: BoundedReadAbortSignal) => Promise<void>;
  random?: () => number;
  /** Aborting settles the read at the attempt in flight instead of continuing. */
  signal?: BoundedReadAbortSignal;
}

/**
 * The default backoff wait, and it is CANCELLABLE. A bare
 * `new Promise((resolve) => setTimeout(resolve, ms))` is not, and that was the
 * defect: the signal was forwarded to this loop, and nothing here ever observed
 * it, so a caller that gave up 1 ms into a 250 ms backoff still waited out the
 * remaining 249 ms before the next `aborted` check could fire.
 *
 * That is not a theoretical wait. The consuming card renders a skeleton while a
 * read is in flight, so those 249 ms are a stuck skeleton for a run whose result
 * can no longer be retained by anyone. The timer is therefore cleared and the
 * wait settles the moment the signal aborts; the loop's own check then breaks
 * out before another attempt is issued.
 */
const realSleep = (ms: number, signal?: BoundedReadAbortSignal): Promise<void> => {
  // Already aborted, or nothing to wait for: resolving now is what keeps a
  // superseded run from paying a backoff it has no use for.
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setTimeout>;
  // Detached on BOTH paths: one listener per backoff would otherwise pile up on
  // a long-lived signal, and this module may be driving several runs from it.
  const settle = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", settle);
    resolve();
  };
  // `timer` is assigned before the listener is attached, and an already-aborted
  // signal never fires on attach, so `settle` cannot observe it unset.
  timer = setTimeout(settle, ms);
  signal?.addEventListener?.("abort", settle);
  return promise;
};

/**
 * Run one read under the policy above and settle for good.
 *
 * Contract, in the order a caller cares about:
 *   - a `transient` failure is retried with backoff up to `maxAttempts`; the
 *     loop cannot run longer, whatever the caller does afterwards;
 *   - every other class is settled after ONE attempt;
 *   - the result is a value, never a throw — the caller's load path cannot leave
 *     an unhandled rejection behind.
 */
export async function readWithBoundedRetry<T>(
  read: (attemptNumber: number) => Promise<BoundedReadAttempt>,
  parse: (raw: unknown) => T,
  policy: BoundedReadPolicy = DEFAULT_BOUNDED_READ_POLICY,
  hooks: BoundedReadHooks = {}
): Promise<BoundedReadOutcome<T>> {
  const p = sanitizePolicy(policy);
  const sleep = hooks.sleep ?? realSleep;
  const random = hooks.random ?? Math.random;

  let attemptNumber = 0;
  let last: BoundedReadAttempt = {
    ok: false,
    missing: false,
    status: 0,
    error: "no attempt was made",
  };

  while (attemptNumber < p.maxAttempts) {
    // Abort is checked BEFORE the attempt as well as after it, so a caller that
    // gave up while a backoff was pending does not get one more request on top.
    if (hooks.signal?.aborted) break;
    attemptNumber++;
    last = await read(attemptNumber);
    const classification = classifyBoundedRead(last);
    if (classification === "ok") {
      return {
        data: parse(last.data),
        ok: true,
        classification,
        attempts: attemptNumber,
        status: last.status,
        error: null,
      };
    }
    // Checked HERE as well as at the top of the loop, and this is the branch that
    // decides: an abort observed the moment this attempt settled must stop the
    // run outright. Falling through to `shouldRetryBoundedRead` would classify a
    // retry worth taking and enter the backoff, spending wait and attempt budget
    // on a run that has already been superseded, before the next iteration's
    // guard noticed and unwound the damage.
    if (hooks.signal?.aborted) break;
    if (!shouldRetryBoundedRead(last, attemptNumber, p)) break;
    // The signal reaches the wait, so a pending backoff ends on the abort rather
    // than after the delay a superseded run can no longer use.
    await sleep(boundedReadBackoffDelayMs(attemptNumber, p, random), hooks.signal);
  }

  return {
    data: null,
    ok: false,
    classification: classifyBoundedRead(last),
    attempts: attemptNumber,
    status: last.status,
    error: last.error ?? null,
  };
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  boundedReadBackoffDelayMs,
  classifyBoundedRead,
  DEFAULT_BOUNDED_READ_POLICY,
  readWithBoundedRetry,
  shouldRetryBoundedRead,
  type BoundedReadAttempt,
  type BoundedReadPolicy,
} from "../../../src/shared/utils/boundedReadRetry";

/**
 * The ceiling a dashboard read gets — asserted without a browser, a clock or a
 * network, because the failure this defends against is a request that never
 * stops and the only honest defence is a number.
 *
 * The two behaviours that matter are opposite, and conflating them is the bug:
 *
 *   - an `unsupported` read (404/405 — the AISIX static export ships no
 *     `/api/**` layer, so this is PERMANENT BY ARCHITECTURE) must issue exactly
 *     ONE request and settle. Retrying it can only land on the same 404.
 *   - a `transient` read (network failure, 5xx) must be retried, with
 *     exponential backoff and jitter, and must then STOP for good.
 *
 * On the deployed artifact the first rule was missing: 47 repeats of one URL
 * inside 5 s, ~70 req/s aggregate, 1 933 requests by 27 s, and a renderer too
 * starved to answer `page.evaluate(() => 1)`.
 */

const ok = (): BoundedReadAttempt => ({ ok: true, missing: false, status: 200, data: { a: 1 } });
const notFound = (): BoundedReadAttempt => ({ ok: false, missing: true, status: 404 });
const methodNotAllowed = (): BoundedReadAttempt => ({
  ok: false,
  missing: true,
  status: 405,
});
const unauthorized = (): BoundedReadAttempt => ({ ok: false, missing: false, status: 401 });
const forbidden = (): BoundedReadAttempt => ({ ok: false, missing: false, status: 403 });
const badRequest = (): BoundedReadAttempt => ({ ok: false, missing: false, status: 400 });
const serverError = (): BoundedReadAttempt => ({
  ok: false,
  missing: false,
  status: 503,
  error: "HTTP 503",
});
const networkFailure = (): BoundedReadAttempt => ({
  ok: false,
  missing: false,
  status: 0,
  error: "Failed to fetch",
});

/** Records how many attempts were issued and how long each wait was. */
function countingReader(...results: BoundedReadAttempt[]) {
  const state = { calls: 0 };
  const read = async (): Promise<BoundedReadAttempt> => {
    const result = results[Math.min(state.calls, results.length - 1)];
    state.calls++;
    return result;
  };
  return { read, state };
}

const noSleep = async (): Promise<void> => undefined;
const identity = (raw: unknown) => raw;

describe("classifyBoundedRead", () => {
  it("routes 2xx to ok", () => {
    assert.equal(classifyBoundedRead(ok()), "ok");
  });

  it("routes 404/405 to unsupported, whether flagged or read off the status", () => {
    assert.equal(classifyBoundedRead(notFound()), "unsupported");
    assert.equal(classifyBoundedRead(methodNotAllowed()), "unsupported");
    // A caller that forgets to set `missing` must still get the permanent class.
    assert.equal(classifyBoundedRead({ ok: false, missing: false, status: 404 }), "unsupported");
  });

  it("routes 401/403 to signedOut — a session state, not a retryable read", () => {
    assert.equal(classifyBoundedRead(unauthorized()), "signedOut");
    assert.equal(classifyBoundedRead(forbidden()), "signedOut");
  });

  it("routes other 4xx to permanent — a retry cannot fix a bad request", () => {
    assert.equal(classifyBoundedRead(badRequest()), "permanent");
    assert.equal(classifyBoundedRead({ ok: false, missing: false, status: 422 }), "permanent");
  });

  it("routes 5xx and a missing response to transient — the only retryable class", () => {
    assert.equal(classifyBoundedRead(serverError()), "transient");
    assert.equal(classifyBoundedRead(networkFailure()), "transient");
    assert.equal(classifyBoundedRead({ ok: false, missing: false, status: 500 }), "transient");
  });
});

describe("shouldRetryBoundedRead", () => {
  it("never retries an unsupported read, however many attempts are left", () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      assert.equal(
        shouldRetryBoundedRead(notFound(), attempt, {
          ...DEFAULT_BOUNDED_READ_POLICY,
          maxAttempts: 10,
        }),
        false,
        `a 404 must not be retried (attempt ${attempt})`
      );
    }
  });

  it("never retries signedOut, permanent or ok", () => {
    const roomy = { ...DEFAULT_BOUNDED_READ_POLICY, maxAttempts: 10 };
    assert.equal(shouldRetryBoundedRead(unauthorized(), 1, roomy), false);
    assert.equal(shouldRetryBoundedRead(forbidden(), 1, roomy), false);
    assert.equal(shouldRetryBoundedRead(badRequest(), 1, roomy), false);
    assert.equal(shouldRetryBoundedRead(ok(), 1, roomy), false);
  });

  it("retries a transient read only while attempts remain", () => {
    const policy = { ...DEFAULT_BOUNDED_READ_POLICY, maxAttempts: 3 };
    assert.equal(shouldRetryBoundedRead(serverError(), 1, policy), true);
    assert.equal(shouldRetryBoundedRead(serverError(), 2, policy), true);
    assert.equal(shouldRetryBoundedRead(serverError(), 3, policy), false, "the ceiling holds");
  });

  it("with maxAttempts 1 retrying is off entirely", () => {
    const once = { ...DEFAULT_BOUNDED_READ_POLICY, maxAttempts: 1 };
    assert.equal(shouldRetryBoundedRead(serverError(), 1, once), false);
  });
});

describe("boundedReadBackoffDelayMs", () => {
  const noJitter: BoundedReadPolicy = { ...DEFAULT_BOUNDED_READ_POLICY, jitterRatio: 0 };

  it("doubles per attempt, starting at the base delay", () => {
    assert.equal(boundedReadBackoffDelayMs(1, noJitter), 250);
    assert.equal(boundedReadBackoffDelayMs(2, noJitter), 500);
    assert.equal(boundedReadBackoffDelayMs(3, noJitter), 1000);
    assert.equal(boundedReadBackoffDelayMs(4, noJitter), 2000);
  });

  it("clamps at maxDelayMs instead of growing without bound", () => {
    assert.equal(boundedReadBackoffDelayMs(20, noJitter), noJitter.maxDelayMs);
    assert.equal(boundedReadBackoffDelayMs(200, noJitter), noJitter.maxDelayMs);
  });

  it("jitters within the configured ratio and never below zero", () => {
    const policy = { ...DEFAULT_BOUNDED_READ_POLICY, jitterRatio: 0.5 };
    // random() at 0 → -50 %, at 1 → +50 %, and 0.5 leaves the delay unchanged.
    assert.equal(
      boundedReadBackoffDelayMs(1, policy, () => 0),
      125
    );
    assert.equal(
      boundedReadBackoffDelayMs(1, policy, () => 0.5),
      250
    );
    assert.equal(
      boundedReadBackoffDelayMs(1, policy, () => 1),
      375
    );
    // A hostile/garbage roll must not produce a negative wait.
    assert.equal(
      boundedReadBackoffDelayMs(1, policy, () => -5),
      125
    );
  });

  it("applies jitter to the CAPPED delay, so the ceiling is a real ceiling", () => {
    const policy: BoundedReadPolicy = {
      maxAttempts: 5,
      baseDelayMs: 250,
      maxDelayMs: 1_000,
      jitterRatio: 1,
    };
    for (const roll of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = boundedReadBackoffDelayMs(9, policy, () => roll);
      assert.ok(
        delay <= policy.maxDelayMs && delay >= 0,
        `jittered delay ${delay} escaped [0, ${policy.maxDelayMs}]`
      );
    }
  });

  it("survives a nonsense policy instead of hanging or looping", () => {
    const broken: BoundedReadPolicy = {
      maxAttempts: Number.NaN,
      baseDelayMs: -50,
      maxDelayMs: -1,
      jitterRatio: 42,
    };
    const delay = boundedReadBackoffDelayMs(1, broken, () => 0.5);
    assert.equal(delay, 0);
  });
});

describe("readWithBoundedRetry — unsupported reads", () => {
  it("issues EXACTLY ONE request for a 404 and settles", async () => {
    const { read, state } = countingReader(notFound());
    const outcome = await readWithBoundedRetry(read, identity, undefined, { sleep: noSleep });

    assert.equal(state.calls, 1, "a 404 must not be re-issued even once");
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.classification, "unsupported");
    assert.equal(outcome.status, 404);
    assert.equal(outcome.data, null, "null data is never a substitute for an empty success");
  });

  it("waits ZERO time before settling a 404 — there is nothing to wait for", async () => {
    const waits: number[] = [];
    const { read } = countingReader(notFound());
    await readWithBoundedRetry(read, identity, undefined, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    assert.deepEqual(waits, []);
  });

  it("settles a 401 after one request — signing out is not a retryable read", async () => {
    const { read, state } = countingReader(unauthorized());
    const outcome = await readWithBoundedRetry(read, identity, undefined, { sleep: noSleep });
    assert.equal(state.calls, 1);
    assert.equal(outcome.classification, "signedOut");
  });
});

describe("readWithBoundedRetry — transient reads", () => {
  it("retries a 5xx up to the ceiling and then STOPS for good", async () => {
    const { read, state } = countingReader(serverError());
    const outcome = await readWithBoundedRetry(read, identity, undefined, { sleep: noSleep });

    assert.equal(state.calls, 3, "default ceiling is 3 attempts total");
    assert.equal(outcome.attempts, 3);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.classification, "transient");
  });

  it("retries a network failure and stops at the ceiling", async () => {
    const { read, state } = countingReader(networkFailure());
    const outcome = await readWithBoundedRetry(read, identity, undefined, { sleep: noSleep });
    assert.equal(state.calls, 3);
    assert.equal(outcome.classification, "transient");
    assert.equal(outcome.error, "Failed to fetch");
  });

  it("returns as soon as a retry succeeds, without spending the rest of the budget", async () => {
    const { read, state } = countingReader(serverError(), serverError(), ok());
    const outcome = await readWithBoundedRetry(read, identity, undefined, { sleep: noSleep });
    assert.equal(state.calls, 3);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 3);
    assert.deepEqual(outcome.data, { a: 1 });
  });

  it("backs off between retries and hands the parse function the body", async () => {
    const waits: number[] = [];
    const policy: BoundedReadPolicy = {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      jitterRatio: 0,
    };
    const { read } = countingReader(serverError());
    await readWithBoundedRetry(read, (raw) => (raw as { count: number }).count, policy, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    assert.deepEqual(waits, [100, 200], "one wait per retry, doubling");
  });

  it("succeeds on the first attempt without ever sleeping", async () => {
    const waits: number[] = [];
    const { read, state } = countingReader(ok());
    const outcome = await readWithBoundedRetry(read, identity, undefined, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    assert.equal(state.calls, 1);
    assert.equal(outcome.attempts, 1);
    assert.deepEqual(waits, []);
  });

  it("honours a caller-supplied ceiling of 1 (retry off)", async () => {
    const { read, state } = countingReader(serverError());
    await readWithBoundedRetry(
      read,
      identity,
      { ...DEFAULT_BOUNDED_READ_POLICY, maxAttempts: 1 },
      {
        sleep: noSleep,
      }
    );
    assert.equal(state.calls, 1);
  });

  it("settles at the attempt in flight when the caller aborts mid-backoff", async () => {
    const { read, state } = countingReader(serverError());
    const signal = { aborted: false };
    const outcome = await readWithBoundedRetry(read, identity, undefined, {
      sleep: async () => {
        signal.aborted = true;
      },
      signal,
    });
    assert.equal(state.calls, 1, "no further attempt once the caller has aborted");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.classification, "transient");
  });

  it("never exceeds the ceiling no matter what the reader does", async () => {
    for (const maxAttempts of [1, 2, 3, 4, 7]) {
      const { read, state } = countingReader(serverError());
      const outcome = await readWithBoundedRetry(
        read,
        identity,
        { ...DEFAULT_BOUNDED_READ_POLICY, maxAttempts },
        { sleep: noSleep }
      );
      assert.ok(
        state.calls <= maxAttempts,
        `ceiling ${maxAttempts} was exceeded: ${state.calls} attempts`
      );
      assert.ok(outcome.attempts <= maxAttempts);
    }
  });
});

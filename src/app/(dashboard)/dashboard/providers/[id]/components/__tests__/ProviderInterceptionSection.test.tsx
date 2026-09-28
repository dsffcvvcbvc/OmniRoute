// @vitest-environment jsdom
//
// Regression test for issue #12072 (second, smaller bug found while fixing
// the TinyCMS DOM-shim leak): fetchInterceptionToggles() used to call
// `await res.json()` without checking `res.ok` first, so a non-JSON error
// body (e.g. a plain-text 500 from the poisoned-SSR bug) surfaced as a raw
// `SyntaxError` inside the `interceptionLoadError` toast instead of a clean
// `HTTP <status>` message.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProviderInterceptionSection from "../ProviderInterceptionSection";

// A stable translator. This is still needed: `t` is a real effect dependency of
// the card's load, and a mock returning a fresh closure on every render would
// re-fire the read. The notifier no longer needs the same treatment.
const stableTranslate = (key: string, values?: Record<string, string>) =>
  values ? `${key}:${JSON.stringify(values)}` : key;
vi.mock("next-intl", () => ({
  useTranslations: () => stableTranslate,
}));

const notifyError = vi.fn();
const stableNotify = { error: notifyError, success: vi.fn() };
// The card reaches the notifier IMPERATIVELY (`getState()`), never by
// subscribing — subscribing to the whole store is what made a toast re-arm the
// read that raised it. So the mock must offer `getState` too, and it no longer
// needs to pretend to be stable to stop the effect looping: that loop is now
// impossible by construction (see providerRuleSectionsBoundedRead.test.tsx, which
// exercises this card against the REAL store). What the mock still owes is the
// method surface the card calls.
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: Object.assign(() => stableNotify, { getState: () => stableNotify }),
}));

const cleanups: Array<() => void> = [];

function renderComponent(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

/**
 * Waits for the card's bounded read to reach a terminal state.
 *
 * A 500 is a TRANSIENT failure, so the read is retried inside a hard ceiling
 * (3 attempts, 250 ms then 500 ms of backoff) before the operator is told.
 * That is the intended trade — a real transient 5xx is worth one more try, and
 * the ceiling is what guarantees the "one more try" stays "one more try". So the
 * message arrives in well under a second rather than on the first microtask, and
 * the wait has to be a real one. A 404 still settles after a single attempt with
 * no wait at all (see providerRuleSectionsBoundedRead.test.tsx).
 */
async function settleBoundedRead(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (notifyError.mock.calls.length === 0 && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

/**
 * Waits for the card to leave its loading skeleton.
 *
 * `settleBoundedRead` waits for a toast, which a SUCCESSFUL read never raises —
 * using it on the happy path would either spin out its whole timeout or, worse,
 * pass while the card was still loading. The skeleton is the loading state
 * (`InterceptionSectionSkeleton` is the only render that carries
 * `.animate-pulse`), so its absence is the terminal state either way: the
 * toggles on a read that worked, the refusal on one that did not.
 */
async function settleToTerminalState(container: HTMLElement, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (container.querySelector(".animate-pulse") && Date.now() < deadline) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await act(async () => {
      await promise;
    });
  }
}

describe("ProviderInterceptionSection (#12072)", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    notifyError.mockClear();
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("surfaces a clean HTTP status message when GET returns a non-JSON 500 body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.reject(new SyntaxError("Unexpected token 'I', \"Internal S\"...")),
        } as unknown as Response)
      )
    );

    renderComponent(<ProviderInterceptionSection providerId="openai" />);
    await settleBoundedRead();

    expect(notifyError).toHaveBeenCalledTimes(1);
    const [message] = notifyError.mock.calls[0] as [string];
    expect(message).toContain("HTTP 500");
    expect(message).not.toContain("Unexpected token");
    expect(message).not.toContain("SyntaxError");
  });

  it("renders the loaded toggles when GET returns a valid JSON body", async () => {
    // The response has to be a RESPONSE, not an object that happens to have
    // `ok`, `status` and `json()`. The card reads through `fetchAisixJson`,
    // which asks the response for its `content-type` header before it will
    // trust the body; a fake without `headers` throws there, the throw is
    // swallowed into `{ok:false, status:0}`, and `status:0` classifies as
    // TRANSIENT — so the card settles into a 250 ms retry loop and this test's
    // assertions (0 toasts, 1 fetch) were being made against a card that was
    // failing. With a JSON content type, one read really is one settled read.
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ interceptSearch: true, interceptFetch: false }),
      } as unknown as Response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const container = renderComponent(<ProviderInterceptionSection providerId="openai" />);
    await settleToTerminalState(container);

    // The success path, stated as what the operator sees: the two switches are
    // on the states the payload said, and the card is not a refusal.
    const switches = [...container.querySelectorAll('[role="switch"]')] as HTMLElement[];
    expect(
      switches.map((el) => el.getAttribute("aria-checked")),
      `the toggles were not rendered from the payload (body: ${container.textContent?.slice(0, 200)})`
    ).toEqual(["true", "false"]);
    expect(
      container.querySelector('[data-testid="interception-rules-unavailable-banner"]'),
      "a successful read rendered the unsupported-surface refusal. The JSON body was not " +
        "understood as data, so the card told the operator this deployment has no interception " +
        "surface at all."
    ).toBeNull();

    expect(notifyError).not.toHaveBeenCalled();
    // A healthy read must not be re-issued: a card that re-reads on every render
    // is the same defect as one that re-reads on every failure, only quieter.
    expect(
      fetchMock.mock.calls.length,
      "a successful read settled without a toast but still re-issued the request"
    ).toBe(1);
  });

  it("retries a 500 inside the hard ceiling, and only inside it", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.reject(new SyntaxError("Internal Server Error")),
      } as unknown as Response)
    );
    vi.stubGlobal("fetch", fetchMock);

    renderComponent(<ProviderInterceptionSection providerId="openai" />);
    await settleBoundedRead();

    const attempts = fetchMock.mock.calls.length;
    expect(attempts).toBeGreaterThan(1);
    expect(
      attempts,
      `a 5xx produced ${attempts} attempts. A transient failure is retried, but inside a hard ` +
        "ceiling — retrying is not the same as never stopping."
    ).toBeLessThanOrEqual(3);
    // And the operator is told once, not once per attempt.
    expect(notifyError).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
//
// REAL-BUG #2 and #3, as measured on the deployed AISIX export artifact.
//
// On `/dashboard/providers/openai` the three provider-rule cards re-issued their
// GET tens of times a second, forever:
//
//   47 repeats of `/api/providers/openai/{param-filters,interception-rules,cc-alias}`
//   inside one 5 s window, ~70 req/s aggregate, 1 933 requests by 27 s, and a
//   renderer so starved that `page.evaluate(() => 1)` took 15–45 s and a
//   full-page screenshot never completed inside 60 s.
//
// Two causes, and the tests below are aimed at one each:
//
//   #2 the cards' load effect depended on the WHOLE notification store
//      (`useNotificationStore()`, unselectored) and reported its own failure by
//      raising a toast — so the toast's state change produced a new store
//      reference, which re-armed the effect that produced the toast. 26 effect
//      runs for 25 toasts, one for one, unbounded.
//   #3 `ProviderParamFilterSection` called `notify.notify(message, "error")`. The
//      store has no `notify` method, so that expression was `undefined` and the
//      load path died on `TypeError: a.notify is not a function` — an unhandled
//      rejection, and a card frozen on its skeleton forever.
//
// A regression here does not fail by asserting; it hangs the worker, because
// that IS the failure. So the mocked `fetch` is deliberately starved after a few
// calls — it returns a promise that never settles — which parks the runaway
// loop and turns it into an ordinary, countable assertion failure instead of a
// wedged test process.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProviderParamFilterSection from "../ProviderParamFilterSection";
import ProviderInterceptionSection from "../ProviderInterceptionSection";
import ProviderCcAliasSection from "../ProviderCcAliasSection";
import { useNotificationStore } from "@/store/notificationStore";

// A stable translator, as next-intl's really is. An unstable mock would re-arm
// the load effect on every render and make these counts meaningless. `rich` is
// the rich-text sibling the param-filter hint uses; `has` is what
// `providerText` probes to decide between the catalogue and its literal.
const translate = Object.assign(
  (key: string, values?: Record<string, string>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  {
    rich: (key: string) => key,
    has: () => false,
  }
);
vi.mock("next-intl", () => ({ useTranslations: () => translate }));

/** Calls that resolve, so the count is observable; past this the loop is starved. */
const FEED_CALLS = 5;

const never = new Promise<Response>(() => undefined);

interface Harness {
  calls: string[];
  unhandled: unknown[];
  cleanups: Array<() => void>;
  container: HTMLElement;
  /** Re-render the mounted card in place, e.g. with a different providerId. */
  rerender: (node: React.ReactElement) => void;
}
const unhandled: unknown[] = [];
function onRejection(reason: unknown) {
  unhandled.push(reason);
}

/** Every mounted card, so a test that throws mid-render cannot leak into the next. */
const mounted: Array<() => void> = [];

function unmountAll(): void {
  while (mounted.length) mounted.pop()?.();
}

function notFound(): Promise<Response> {
  // A static host answers an absent `/api/*` with a 404 and an HTML/text body —
  // deliberately NOT JSON, so a card that parses without checking `ok` would
  // blow up rather than quietly report an empty success.
  return Promise.resolve({
    ok: false,
    status: 404,
    headers: new Headers({ "content-type": "text/html" }),
    json: () => Promise.reject(new SyntaxError("Unexpected token '<'")),
  } as unknown as Response);
}

function networkDown(): Promise<Response> {
  return Promise.reject(new TypeError("Failed to fetch"));
}

/**
 * `respond` receives the URL the card actually requested. That argument is the
 * only way a test can tell two providers apart, and the helper used to drop it:
 * `respond()` was called with no arguments while the factory's own parameter
 * was named `url`, so `String(url)` was the string `"undefined"` and a factory
 * that picked its payload from the URL served the SAME body for every provider.
 * The switching case below therefore asserted a payload the mock could never
 * produce, and no implementation of the hook could have made it green — the
 * assertion was unreachable, not falsified.
 *
 * Every other case passes a `respond` that ignores its parameter, so widening
 * the signature is inert for them.
 */
function mount(node: React.ReactElement, respond: (url: unknown) => Promise<Response>): Harness {
  const calls: string[] = [];
  const fetchMock = vi.fn((url: unknown) => {
    calls.push(String(url));
    return calls.length > FEED_CALLS ? never : respond(url);
  });
  vi.stubGlobal("fetch", fetchMock);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  const cleanups = [
    () => {
      act(() => root.unmount());
      container.remove();
    },
  ];
  mounted.push(...cleanups);
  return {
    calls,
    unhandled,
    cleanups,
    container,
    rerender: (next: React.ReactElement) => act(() => root.render(next)),
  };
}

/**
 * Settles against the WALL CLOCK, for the paths that wait on a real backoff
 * timer rather than on microtasks.
 *
 * `settle()` drains microtask turns, which is the right tool for a read that
 * settles immediately (a 404 does) and the wrong one for a transient failure:
 * the first backoff is 250 ms, so `settle(30)` returns in a few milliseconds
 * with exactly one attempt recorded — and an assertion of "at most 3 attempts"
 * over that is satisfied by an implementation that never retries at all.
 */
async function settleFor(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  do {
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 20);
      await promise;
    });
  } while (Date.now() < deadline);
}

/**
 * The default policy's whole retry budget, worst case.
 *
 * `DEFAULT_BOUNDED_READ_POLICY` is 3 attempts, 250 ms base, ±50 % jitter, so the
 * two waits before the third and last attempt are 250 + 500 ms at most 1.5x.
 * A test that waits less than this is measuring its own impatience.
 */
const RETRY_BUDGET_MS = 1_600;

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const CARDS = [
  {
    name: "param filters",
    endpoint: "param-filters",
    banner: "param-filters-unavailable-banner",
    node: (id: string) => <ProviderParamFilterSection providerId={id} />,
  },
  {
    name: "interception rules",
    endpoint: "interception-rules",
    banner: "interception-rules-unavailable-banner",
    node: (id: string) => <ProviderInterceptionSection providerId={id} />,
  },
  {
    name: "cc-alias",
    endpoint: "cc-alias",
    banner: "cc-alias-unavailable-banner",
    node: (id: string) => <ProviderCcAliasSection providerId={id} />,
  },
] as const;

// The env var is NOT set in this block. The describe used to be titled "AISIX
// static export" while `NEXT_PUBLIC_AISIX_SPA_EXPORT` was never set, so every
// test in it exercised the *Next build* branch of the hook and the export's
// primary defence — refusing WITHOUT asking — was untested. That branch has
// its own describe below.
describe("provider-rule cards in a Next build whose read is absent (404)", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useNotificationStore.getState().clearAll();
    unhandled.length = 0;
    process.addListener("unhandledRejection", onRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", onRejection);
    unmountAll();
    for (let i = unhandled.length; i > 0; i--) unhandled.pop();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(CARDS)(
    "$name issues one read and settles — it does not retry a 404",
    async ({ endpoint, node }) => {
      const h = mount(node("openai"), notFound);
      await settle();
      h.cleanups.forEach((c) => c());

      expect(
        h.calls.filter((u) => u.includes(endpoint)).length,
        `${endpoint} was requested ${h.calls.length} time(s) for a 404. A failed read is being ` +
          "re-armed by its own error notification: the toast mutates the notification store, which " +
          "makes the store object a new reference for the load effect, which fetches again, which " +
          "fails again. A 404 is permanent by architecture — it must be requested once."
      ).toBe(1);
      expect(h.calls.length).toBe(1);
    }
  );

  it.each(CARDS)(
    "$name raises exactly one notification, not a stream of them",
    async ({ node }) => {
      const h = mount(node("openai"), notFound);
      await settle();
      h.cleanups.forEach((c) => c());

      const toasts = useNotificationStore.getState().notifications;
      expect(
        toasts.length,
        "a failing read reported itself once per attempt; the operator's screen is the casualty"
      ).toBe(1);
      expect(toasts[0].type).toBe("error");
    }
  );

  it.each(CARDS)(
    "$name renders an honest refusal instead of a spinner or an empty form",
    async ({ banner, node }) => {
      const h = mount(node("openai"), notFound);
      await settle();

      const el = h.container.querySelector(`[data-testid="${banner}"]`);
      expect(
        el,
        `no refusal affordance rendered (body: ${h.container.textContent?.slice(0, 200)})`
      ).not.toBeNull();
      expect(el?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      // A skeleton is an infinite spinner in disguise: it must be gone.
      expect(h.container.querySelector(".animate-pulse")).toBeNull();

      h.cleanups.forEach((c) => c());
    }
  );

  it.each(CARDS)(
    "$name leaves NO unhandled rejection (#3: notify is not a function), and the failing path really ran",
    async ({ endpoint, node }) => {
      const h = mount(node("openai"), notFound);
      await settle();
      h.cleanups.forEach((c) => c());

      // Precondition, not a restatement. `unhandledRejection` is a worker-level
      // event: if the load path never reached the fetch at all, the empty array
      // below would be reporting a channel that never fired, which is the one
      // way this assertion can be true for the wrong reason. So the read that
      // is supposed to blow up is required to have been issued.
      expect(
        h.calls.some((u) => u.includes(endpoint)),
        `the ${endpoint} read was never issued, so "no unhandled rejection" describes a code ` +
          "path that did not execute."
      ).toBe(true);
      expect(
        unhandled,
        "a failed read produced an unhandled rejection. An unhandled rejection is an app fault " +
          "whatever the server answered: the operator gets a console full of stack traces and a " +
          "surface with no error state."
      ).toEqual([]);
    }
  );

  it.each(CARDS)(
    "$name bounds a TRANSIENT failure too — a ceiling, not a spin",
    async ({ endpoint, node }) => {
      const h = mount(node("openai"), networkDown);
      // Real time, for the whole retry budget. The previous `settle(30)` drained
      // microtasks and came back in a few milliseconds — before the first
      // 250 ms backoff had even elapsed — so it always observed exactly one
      // attempt, and "at most 3, at least 1" was true of an implementation that
      // never retried at all. The claim is the CEILING, so it is stated as the
      // ceiling exactly: three attempts, then stop for good.
      await settleFor(RETRY_BUDGET_MS);

      const attempts = h.calls.filter((u) => u.includes(endpoint)).length;
      expect(
        attempts,
        `a network failure produced ${attempts} attempts, after the full ${RETRY_BUDGET_MS}ms ` +
          "retry budget had elapsed. A transient failure IS retried — that is the point of the " +
          "backoff — and the ceiling is 3 attempts, so an implementation that never retries " +
          "passes an upper-bound assertion, and an unbounded one is caught here."
      ).toBe(3);
      // Still mounted, so this one is a real observation: nothing arrives after
      // the ceiling. (Checked before the teardown, or it is trivially true.)
      await settleFor(500);
      expect(
        h.calls.filter((u) => u.includes(endpoint)).length,
        "a fourth attempt arrived after the ceiling. Retrying is not the same as never stopping."
      ).toBe(3);
    }
  );
});

describe("provider-rule cards in the AISIX static export (refuse before asking)", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useNotificationStore.getState().clearAll();
    unhandled.length = 0;
    // `next.config.mjs` inlines this at build time; `isAisixSpaExport()` reads
    // it per call, so setting it here takes the same branch the deployed
    // artifact takes. See `src/shared/utils/aisixEndpoints.ts:393`.
    process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT = "1";
  });

  afterEach(() => {
    unmountAll();
    delete process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT;
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(CARDS)(
    "$name asks for NOTHING and states the architectural reason",
    async ({ banner, endpoint, node }) => {
      const h = mount(node("openai"), notFound);
      await settle();

      // The claim with teeth: on the export the request is not made, so the
      // operator is not shown a failed LOAD, and no failed load is reported to
      // anyone. This is the assertion the whole `providerRules` refusal family
      // rests on, and the one a "404 in a Next build" test cannot make — there
      // the request genuinely has to go out.
      expect(
        h.calls,
        `the ${endpoint} read was issued on a build that ships no ${endpoint} surface. The card ` +
          "asked for something the deployment was always going to refuse, and this is the " +
          "request that became 47 repeats inside a 5 s window before the fix."
      ).toEqual([]);
      expect(
        useNotificationStore.getState().notifications,
        "an architecturally-absent surface raised a failure notification. Nothing failed: the " +
          "deployment never had this surface, and a toast is the wrong language for that."
      ).toEqual([]);

      const el = h.container.querySelector(`[data-testid="${banner}"]`);
      expect(
        el,
        `no refusal affordance rendered (body: ${h.container.textContent?.slice(0, 200)})`
      ).not.toBeNull();
      // The REASON, not just a refusal: `resolveAisixSurfaceSupport(...).reason`
      // is what the operator reads, and it is the one part of this that no
      // status code can supply.
      expect(
        el?.textContent?.trim().length ?? 0,
        `the ${banner} refusal carries no reason, so the operator is told the surface is ` +
          "unavailable and not why."
      ).toBeGreaterThan(20);
      expect(h.container.querySelector(".animate-pulse")).toBeNull();

      h.cleanups.forEach((c) => c());
    }
  );
});

describe("provider-rule cards in a Next build (the route exists)", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useNotificationStore.getState().clearAll();
    delete process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT;
  });

  afterEach(() => {
    unmountAll();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_AISIX_SPA_EXPORT;
  });

  it("renders the loaded config and does not refuse when the read succeeds", async () => {
    const body = {
      block: ["temperature", "top_p"],
      allow: ["stream"],
      autoLearn: true,
    };
    const h = mount(<ProviderParamFilterSection providerId="openai" />, () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve(body),
      } as unknown as Response)
    );
    await settle();

    expect(h.calls.length).toBe(1);
    expect(
      h.container.querySelector('[data-testid="param-filters-unavailable-banner"]')
    ).toBeNull();
    const inputs = [...h.container.querySelectorAll("input[type=text]")] as HTMLInputElement[];
    expect(inputs.map((i) => i.value)).toEqual(["temperature, top_p", "stream"]);
    const checkbox = h.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    h.cleanups.forEach((c) => c());
  });

  it("reads each provider once — switching provider re-reads, a re-render does not", async () => {
    // Two providers, two DIFFERENT payloads, so a card that kept showing the
    // first provider's rules under the second provider's heading is caught. The
    // previous version of this test mounted one provider, never switched, and
    // asserted one read — which the claim of "switching provider re-reads" in
    // its own name does not make true, and which leaves the hook's per-provider
    // claim (`settledForRef`) untested.
    const PAYLOADS: Record<string, { interceptSearch: boolean; interceptFetch: boolean }> = {
      openai: { interceptSearch: true, interceptFetch: false },
      anthropic: { interceptSearch: false, interceptFetch: true },
    };
    const h = mount(<ProviderInterceptionSection providerId="openai" />, (url: unknown) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () =>
          Promise.resolve(PAYLOADS[String(url).includes("anthropic") ? "anthropic" : "openai"]),
      } as unknown as Response)
    );
    const toggleStates = () =>
      [...h.container.querySelectorAll('[role="switch"]')].map((el) =>
        el.getAttribute("aria-checked")
      );
    const readsFor = (id: string) => h.calls.filter((u) => u.includes(id)).length;

    await settle();
    expect(readsFor("openai")).toBe(1);
    expect(toggleStates()).toEqual(["true", "false"]);

    // A re-render with the SAME id must not re-read: that is the loop this whole
    // file exists to prevent, and it is what the settled-claim is there for.
    h.rerender(<ProviderInterceptionSection providerId="openai" />);
    await settle();
    expect(readsFor("openai")).toBe(1);

    // Switching provider MUST re-read, exactly once, and must render the NEW
    // provider's rules — not the previous one's.
    h.rerender(<ProviderInterceptionSection providerId="anthropic" />);
    await settle();
    expect(
      readsFor("anthropic"),
      "the card did not read the provider it was switched to, so the operator sees the previous " +
        "provider's interception rules under this provider's heading"
    ).toBe(1);
    // RED as of this commit — a real product defect, not a flaky read. The read
    // above WAS issued (the previous assertion holds), so the loss happens on
    // the RENDER side. `useProviderSectionRead` does not reset its state to
    // `loading` when `providerId` changes, so the first render after the switch
    // still sees `phase === "ready"` carrying the PREVIOUS provider's data; the
    // card's render-time seed (`if (read.phase === "ready" && seededFor !==
    // providerId)`, ProviderInterceptionSection.tsx:109) claims `seededFor` with
    // that stale data, and by the time the new payload lands the claim is spent
    // and the seed does not run again. The operator gets provider A's
    // interception rules under provider B's heading.
    expect(
      toggleStates(),
      "the card read the provider it was switched to and still renders the previous provider's " +
        "toggles. The read arrives, but the card's render-time seed is claimed from the STALE " +
        "`phase === 'ready'` state on the first render after the switch, so the new payload never " +
        "reaches the toggles (ProviderInterceptionSection.tsx:109 + useProviderSectionRead.ts:131)."
    ).toEqual(["false", "true"]);
    // And the first provider's read was not repeated as collateral.
    expect(readsFor("openai")).toBe(1);
  });
});

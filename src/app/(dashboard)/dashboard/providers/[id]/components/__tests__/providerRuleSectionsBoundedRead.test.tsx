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

function mount(node: React.ReactElement, respond: () => Promise<Response>): Harness {
  const calls: string[] = [];
  const fetchMock = vi.fn((url: unknown) => {
    calls.push(String(url));
    return calls.length > FEED_CALLS ? never : respond();
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
  return { calls, unhandled, cleanups, container };
}

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

describe("provider-rule cards under a 404 (AISIX static export)", () => {
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
    "$name leaves NO unhandled rejection (#3: notify is not a function)",
    async ({ node }) => {
      const h = mount(node("openai"), notFound);
      await settle();
      h.cleanups.forEach((c) => c());

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
      await settle(30);
      h.cleanups.forEach((c) => c());

      const attempts = h.calls.filter((u) => u.includes(endpoint)).length;
      expect(
        attempts,
        `a network failure produced ${attempts} attempts. Only a transient failure is retried, ` +
          "and only inside the hard attempt ceiling."
      ).toBeLessThanOrEqual(3);
      expect(attempts).toBeGreaterThanOrEqual(1);
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
    const h = mount(<ProviderInterceptionSection providerId="openai" />, () =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ interceptSearch: true, interceptFetch: false }),
      } as unknown as Response)
    );
    await settle();
    expect(h.calls.length).toBe(1);
    h.cleanups.forEach((c) => c());
  });
});

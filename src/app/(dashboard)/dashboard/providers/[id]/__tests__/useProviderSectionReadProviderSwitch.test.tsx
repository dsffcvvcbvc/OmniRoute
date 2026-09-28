// @vitest-environment jsdom
//
// Switching provider must never leave one provider's payload on screen under
// another's heading.
//
// The read state is per-PROVIDER: a body parsed for "openai" is not an answer
// about "anthropic". The hook kept ONE state for the whole mount, so the first
// render after a switch still carried the previous provider's `ready` payload
// until the new read settled. Every card seeds its editable copy from
// `phase === "ready"` against the current `providerId`
// (`seededFor !== providerId`), so that single render was enough to show
// provider A's rules under provider B's heading — and to spend the seed claim
// on A's data, after which B's real payload was ignored. An operator toggling a
// rule would then be writing the wrong provider's configuration.
//
// Two properties have to hold at once, and "fix" the leak by re-reading more
// easily trades one false claim for the other:
//
//   1. after a switch, NO render may expose the previous provider's data; and
//   2. a plain re-render of the SAME provider still costs no request, because
//      the retry storm this hook exists to end is a re-read on every render.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useProviderSectionRead } from "../hooks/useProviderSectionRead";
import type { ProviderMessageTranslator } from "../providerPageHelpers";

vi.mock("@/shared/utils/aisixEndpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/utils/aisixEndpoints")>();
  return {
    ...actual,
    // Supported here on purpose: the subject is what the hook does with a
    // providerId change, not the static-export refusal, which has its own suite.
    resolveAisixSurfaceSupport: () => ({ supported: true, reason: null }),
  };
});

const translate: ProviderMessageTranslator = Object.assign((key: string) => `en:${key}`, {
  rich: (key: string) => key,
  has: () => true,
});

/** The payload a provider answers with — deliberately different per provider. */
type Payload = { provider: string; rule: string };

type Attempt = { ok: boolean; missing: boolean; status: number; data: unknown };

interface PendingRead {
  providerId: string;
  settle: (payload: Payload) => void;
}

let pending: PendingRead[] = [];
/** Every render the card produced, in order: which provider, which payload. */
let renders: Array<{ providerId: string; phase: string; dataProvider?: string }> = [];

function Harness({ providerId }: { providerId: string }) {
  const state = useProviderSectionRead<Payload>({
    providerId,
    read: (id) => {
      const { promise, resolve } = Promise.withResolvers<Attempt>();
      pending.push({
        providerId: id,
        settle: (payload) => resolve({ ok: true, missing: false, status: 200, data: payload }),
      });
      return promise;
    },
    parse: (raw) => raw as Payload,
    domain: "providerRules",
    failureMessageKey: "ruleUnavailable",
    failureFallback: "This surface is unavailable.",
    translate,
  });
  renders.push({
    providerId,
    phase: state.phase,
    dataProvider: state.phase === "ready" ? state.data.provider : undefined,
  });
  return (
    <div data-testid="body">{state.phase === "ready" ? state.data.provider : state.phase}</div>
  );
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function readsFor(providerId: string): number {
  return pending.filter((entry) => entry.providerId === providerId).length;
}

/** Renders that showed one provider's payload while the heading said another. */
function crossProviderLeaks(): Array<{ providerId: string; dataProvider?: string }> {
  return renders.filter(
    (entry) => entry.dataProvider !== undefined && entry.dataProvider !== entry.providerId
  );
}

function bodyText(): string {
  return container.querySelector("[data-testid='body']")?.textContent ?? "";
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  renders = [];
  pending = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useProviderSectionRead — the answer belongs to the provider it was read for", () => {
  it("switching providers shows the new provider's data, and never the old one's", async () => {
    act(() => root.render(<Harness providerId="openai" />));
    await settle();
    expect(readsFor("openai"), "the first provider must be read").toBe(1);
    pending[0].settle({ provider: "openai", rule: "openai-rule" });
    await settle();
    expect(bodyText()).toBe("openai");

    // The switch. Nothing from here on may expose openai's payload.
    renders = [];
    act(() => root.render(<Harness providerId="anthropic" />));
    await settle();

    expect(
      crossProviderLeaks(),
      "the previous provider's payload was rendered under the new provider's heading"
    ).toEqual([]);

    // And the read for the new provider really was issued, exactly once.
    expect(readsFor("anthropic"), "switching provider must re-read").toBe(1);
    expect(readsFor("openai"), "switching provider must not re-read the old one").toBe(1);

    pending[1].settle({ provider: "anthropic", rule: "anthropic-rule" });
    await settle();

    // The end state is the NEW provider's payload, and nothing of the old one
    // survives in the card.
    expect(bodyText()).toBe("anthropic");
    const last = renders.at(-1);
    expect(last?.phase).toBe("ready");
    expect(last?.dataProvider).toBe("anthropic");
  });

  it("the card returns to its skeleton on a switch instead of keeping the old answer", async () => {
    act(() => root.render(<Harness providerId="openai" />));
    await settle();
    pending[0].settle({ provider: "openai", rule: "openai-rule" });
    await settle();
    expect(bodyText()).toBe("openai");

    // One render, no settling: the first render after the switch is the one the
    // seed claim was being spent on.
    renders = [];
    act(() => root.render(<Harness providerId="anthropic" />));
    await settle(1);

    expect(crossProviderLeaks()).toEqual([]);
    expect(
      renders.some((entry) => entry.providerId === "anthropic" && entry.phase === "loading"),
      "the card kept the previous provider's answer while the new read was in flight"
    ).toBe(true);
  });

  it("a plain re-render of the same provider still costs no request", async () => {
    act(() => root.render(<Harness providerId="openai" />));
    await settle();
    pending[0].settle({ provider: "openai", rule: "openai-rule" });
    await settle();
    expect(readsFor("openai")).toBe(1);

    // Re-renders that change nothing the hook depends on: a new element
    // identity, no providerId change. This is the property the retry storm is
    // made of, and the one a naive "reset on every effect run" fix destroys.
    for (let i = 0; i < 5; i++) {
      act(() => root.render(<Harness providerId="openai" />));
      await settle(1);
    }
    expect(readsFor("openai"), "a re-render re-read the same provider").toBe(1);
    // And the answer survived those re-renders rather than being reset away.
    expect(bodyText()).toBe("openai");
  });

  it("switching back re-reads, because the claim is per provider", async () => {
    act(() => root.render(<Harness providerId="openai" />));
    await settle();
    pending[0].settle({ provider: "openai", rule: "openai-rule" });
    await settle();

    act(() => root.render(<Harness providerId="anthropic" />));
    await settle();
    pending[1].settle({ provider: "anthropic", rule: "anthropic-rule" });
    await settle();
    expect(bodyText()).toBe("anthropic");

    act(() => root.render(<Harness providerId="openai" />));
    await settle();
    expect(readsFor("openai"), "switching back must read the first provider again").toBe(2);
    pending[2].settle({ provider: "openai", rule: "openai-rule-2" });
    await settle();
    expect(bodyText()).toBe("openai");
    expect(crossProviderLeaks()).toEqual([]);
  });
});

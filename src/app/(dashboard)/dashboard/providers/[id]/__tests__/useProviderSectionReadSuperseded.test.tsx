// @vitest-environment jsdom
//
// A read that React SUPERSEDED mid-flight must not leave the card on its
// skeleton forever.
//
// The three provider-rule cards read through `useProviderSectionRead`, which
// aborts whatever it started when a dependency changes and refuses to re-read a
// providerId it has already claimed. Those two rules used to cancel each other
// out on a dependency change that landed while a read was still in flight:
//
//   cleanup   → controller.abort()             (the read is dead)
//   re-run #2 → `claimedForRef === providerId` (a no-op — never reads)
//   run #1    → resumes, sees `aborted`        (returns WITHOUT setState)
//
// Nobody called `setState`, so the card stayed `phase: "loading"` permanently:
// the refusal never rendered, the write controls never mounted, and because the
// claim was never released it could never recover for that providerId.
//
// The trigger is ordinary, not exotic. `translate` is `useTranslations(...)`,
// and use-intl memoises it over `allMessages` — so switching locale mid-read
// replaces `messages` and changes `t`'s identity while the request is on the
// wire. `reactStrictMode` double-invokes mount effects in `next dev`, which does
// the same thing on every mount.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useProviderSectionRead } from "../hooks/useProviderSectionRead";
import type { ProviderMessageTranslator } from "../providerPageHelpers";
import { useNotificationStore } from "@/store/notificationStore";

vi.mock("@/shared/utils/aisixEndpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/utils/aisixEndpoints")>();
  return {
    ...actual,
    // The read is supported here on purpose: the subject of these cases is the
    // effect's own lifecycle, not the static-export refusal, which has its own
    // suite.
    resolveAisixSurfaceSupport: () => ({ supported: true, reason: null }),
  };
});

/** A translator whose identity the test controls, as `use-intl` really is. */
function makeTranslate(locale: string): ProviderMessageTranslator {
  return Object.assign((key: string) => `${locale}:${key}`, {
    rich: (key: string) => key,
    // `providerText` only calls the translator for a key the catalogue HAS, and
    // otherwise interpolates into the English fallback — so the wording of the
    // refusal is what says which locale produced it.
    has: () => true,
  });
}

/** One in-flight read, released by the test rather than by a timer. */
interface PendingRead {
  promise: Promise<{ ok: boolean; missing: boolean; status: number; data?: unknown }>;
  settle: () => void;
}

function pendingRead(succeed: boolean): PendingRead {
  const { promise, resolve } = Promise.withResolvers<{
    ok: boolean;
    missing: boolean;
    status: number;
    data?: unknown;
  }>();
  return {
    promise,
    settle: () =>
      resolve(
        succeed
          ? { ok: true, missing: false, status: 200, data: "payload" }
          : { ok: false, missing: true, status: 404 }
      ),
  };
}

const parse = (value: unknown) => value;

let currentTranslate: ProviderMessageTranslator;
let pending: PendingRead[] = [];
let renders: Array<{ phase: string; reason?: string }> = [];

function Harness({
  providerId,
  enabled = true,
  succeed = false,
}: {
  providerId: string;
  enabled?: boolean;
  succeed?: boolean;
}) {
  const state = useProviderSectionRead<unknown>({
    providerId,
    // Each attempt parks in its own slot so the test decides when a read lands.
    read: () => {
      const next = pendingRead(succeed);
      pending.push(next);
      return next.promise;
    },
    parse,
    domain: "providerRules",
    failureMessageKey: "ruleUnavailable",
    failureFallback: "This surface is unavailable.",
    translate: currentTranslate,
    enabled,
  });
  renders.push(
    state.phase === "refused"
      ? { phase: state.phase, reason: state.reason }
      : { phase: state.phase }
  );
  return <div data-testid="phase">{state.phase}</div>;
}

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

let container: HTMLDivElement;
let root: Root;

function lastPhase(): string {
  return container.querySelector("[data-testid='phase']")?.textContent ?? "";
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  useNotificationStore.getState().clearAll();
  renders = [];
  pending = [];
  currentTranslate = makeTranslate("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useProviderSectionRead — a superseded read still reaches a state", () => {
  it("a locale switch mid-read ends in a refusal, not on the skeleton forever", async () => {
    // Mount: run #1 claims the providerId and parks on an unanswered read.
    act(() => root.render(<Harness providerId="openai" />));
    await settle(2);
    expect(pending.length, "the card must have issued its read").toBe(1);
    expect(lastPhase(), "the card starts on its skeleton").toBe("loading");

    // A locale switch replaces `messages`, so `t` is a new function while the
    // request is in flight. React cleans up (aborting run #1) and re-runs.
    currentTranslate = makeTranslate("pt-BR");
    act(() => root.render(<Harness providerId="openai" />));
    await settle(2);
    // The re-run has to actually read, or nothing is left to settle the card.
    expect(
      pending.length,
      "the re-run was swallowed by the claim, so no read would ever settle this card"
    ).toBe(2);

    // Run #1 is dead: React aborted it and it must not write. Only the read that
    // is still on the wire — run #2's — may land.
    pending[0].settle();
    await settle();
    expect(lastPhase(), "an aborted read wrote to a card the re-run now owns").toBe("loading");

    pending[1].settle();
    await settle();

    // THE assertion that can fail. Before the fix, the aborted run returned at
    // the `aborted` check without calling setState and the re-run was a no-op at
    // the claim, so this is `loading` — permanently, and the card can never
    // recover for this providerId.
    expect(lastPhase(), "the card is still on its skeleton: the refusal will never render").toBe(
      "refused"
    );
    // And it is the honest refusal, in the locale that is current now.
    expect(renders.at(-1)?.reason).toBe("pt-BR:ruleUnavailable");
  });

  it("a settled card is never re-read, whatever the dependencies do afterwards", async () => {
    act(() => root.render(<Harness providerId="openai" />));
    await settle(2);
    pending[0].settle();
    await settle();
    expect(lastPhase()).toBe("refused");

    // The other half of the same lifecycle, and the one the fix must not have
    // broken: releasing the claim on every cleanup would put a read behind every
    // render, which is the request storm the module was written to end.
    currentTranslate = makeTranslate("de");
    act(() => root.render(<Harness providerId="openai" />));
    await settle();
    expect(pending.length, "a settled providerId was re-read on a dependency change").toBe(1);
    currentTranslate = makeTranslate("fr");
    act(() => root.render(<Harness providerId="openai" />));
    await settle();
    expect(pending.length, "a settled providerId was re-read again").toBe(1);
    expect(useNotificationStore.getState().notifications.length).toBe(1);
  });

  it("a read that was never superseded is unaffected", async () => {
    act(() => root.render(<Harness providerId="openai" />));
    await settle(2);
    pending[0].settle();
    await settle();
    expect(lastPhase()).toBe("refused");
    expect(renders.at(-1)?.reason).toBe("en:ruleUnavailable");
  });

  it("a card mounted disabled reads nothing, and reads the moment it is enabled", async () => {
    // The other half of "a claim belongs to a run that will really read". The
    // `enabled` gate used to sit BELOW the claim, so a card that mounted
    // disabled had already spent its claim on a read that was never going to
    // happen. When the card was later allowed to read, the effect returned at
    // the claim test and it stayed on its empty refusal for the rest of the
    // mount — a state that says "unavailable" about a surface that is about to
    // answer, with nothing on screen to say otherwise.
    act(() => root.render(<Harness providerId="openai" enabled={false} succeed />));
    await settle();
    expect(pending.length, "a disabled card fired a request").toBe(0);
    expect(lastPhase()).toBe("refused");

    act(() => root.render(<Harness providerId="openai" enabled succeed />));
    await settle();
    expect(pending.length, "enabling the card did not read: the claim was already spent").toBe(1);
    pending[0].settle();
    await settle();
    expect(lastPhase()).toBe("ready");
  });
});

"use client";

/**
 * useProviderSectionRead — the load half of a provider-detail config card, with
 * a real ceiling.
 *
 * The three cards that read a per-provider rule row (param filters, web
 * interception rules, the Claude Code discovery-alias gate) each used to own a
 * private `useEffect` that re-issued its GET whenever its dependencies changed
 * identity. On the AISIX static export there is no `/api/**` layer, so every
 * read 404s; the effect reported the 404 by raising a toast, and the toast
 * mutated the global notification store — which made the unselectored
 * `useNotificationStore()` object it depended on a NEW reference, which re-armed
 * the effect. 47 repeats of one URL inside 5 s, ~70 req/s, and a renderer too
 * starved to answer `page.evaluate(() => 1)`.
 *
 * THE INVARIANT: every piece of per-provider bookkeeping is keyed by the
 * providerId it belongs to, and the CLAIM and the ANSWER are the same fact seen
 * from two sides — "this providerId is being read, or has been" and "here is
 * what that read produced". Nothing may be keyed by anything else, and neither
 * may be RETAINED past the moment its key stops matching.
 *
 * Three defects on this file were three ways of breaking that one rule, and
 * they are listed here as the consequences that keep it true:
 *
 *   1. A run may only claim a read it is actually going to perform. The
 *      `!enabled` gate and the claim test therefore run BEFORE the claim is
 *      taken. Claiming first meant a card that mounted disabled had already
 *      spent its claim on a read that would never happen, so the run that
 *      finally became eligible returned at the claim test and the card sat on
 *      its `refused` state for the rest of the mount — silently, because
 *      nothing about the state said "waiting" or "disabled".
 *
 *   2. A claim belongs to a LIVE run. The effect aborts whatever it started
 *      when its dependencies change, and `reactStrictMode` double-invokes
 *      mount effects, so a run is routinely killed mid-flight and superseded by
 *      the re-run React performs immediately afterwards. A claim that outlived
 *      its run turned that re-run into a no-op, and since the killed run was
 *      aborted it never called `setStored` either: nobody left to settle the
 *      card, which sat on `phase: "loading"` forever with the claim still
 *      spent and no way to recover for that providerId. A run that DID settle
 *      keeps its claim — that is what makes the request ceiling hold — so the
 *      release is conditional on "never settled", and only by the run that
 *      actually took the claim.
 *
 *   3. The published ANSWER is re-derived, not retained, when the key changes.
 *      A `ready` payload is an answer about one provider; every card seeds its
 *      editable copy from `phase === "ready"` against the CURRENT providerId
 *      (`seededFor !== providerId`), so even one render carrying the previous
 *      provider's payload shows the wrong provider's rules under the new
 *      provider's heading and spends the seed claim on the wrong data.
 *      Invalidating inside the effect is too late — the children have already
 *      rendered — so it happens during render, which re-runs the component
 *      before anything is committed.
 *
 * On top of that, three properties make a request storm impossible:
 *
 *   4. `resolveAisixSurfaceSupport(domain, "read")` decides BEFORE any request
 *      is issued. On the static export the read is known-unsupported, so zero
 *      requests are fired and the card renders the honest refusal. This is the
 *      same mechanism the radar/costs/logs/relay cards already use — not a
 *      second one.
 *   5. What is left runs under `readWithBoundedRetry`: an `unsupported` answer
 *      settles after one attempt, and only a network/5xx failure is retried,
 *      with backoff and a hard attempt ceiling.
 *   6. The effect depends on nothing the effect itself can change. The
 *      notifier is read imperatively with `useNotificationStore.getState()`
 *      (the same pattern `HomePageClient` uses for notify-from-async) instead
 *      of subscribing, so a toast can no longer re-arm the read.
 *
 * The claim is deliberately a single SLOT rather than a per-provider cache: it
 * is a ceiling on requests for the provider on screen, not a store of answers.
 * So a plain re-render of the same provider reads nothing, and switching
 * providers always reads the new one — even a provider seen before, whose
 * configuration may have changed while the operator was on the other one.
 *
 * @module app/(dashboard)/dashboard/providers/[id]/hooks/useProviderSectionRead
 */

import { useEffect, useRef, useState } from "react";

import {
  resolveAisixSurfaceSupport,
  type AisixUnsupportedDomain,
} from "@/shared/utils/aisixEndpoints";
import {
  readWithBoundedRetry,
  type BoundedReadAttempt,
  type BoundedReadPolicy,
} from "@/shared/utils/boundedReadRetry";
import { useNotificationStore } from "@/store/notificationStore";
import { providerText, type ProviderMessageTranslator } from "../providerPageHelpers";

export type ProviderSectionReadState<T> =
  /** First read for this providerId is in flight. */
  | { phase: "loading"; attempts: 0 }
  /** A body came back and parsed. */
  | { phase: "ready"; data: T; attempts: number }
  /**
   * No body, and none is coming: the surface is absent on this build, or the
   * read failed for good. `reason` is what the card shows — never a spinner,
   * never a silent empty form.
   */
  | { phase: "refused"; reason: string; attempts: number };

/**
 * The answer as STORED: a {@link ProviderSectionReadState} plus the providerId
 * it is about. Tagging it is what lets the hook publish an answer that is
 * ALWAYS about the provider currently on screen — see the derivation below the
 * `useState`, which is also why resetting the state during render is not an
 * equivalent substitute.
 */
type StoredRead<T> = ProviderSectionReadState<T> & { providerId: string };

export interface ProviderSectionReadOptions<T> {
  providerId: string;
  /** Module-level, so the effect's dependency is stable by construction. */
  read: (providerId: string) => Promise<BoundedReadAttempt>;
  /** Module-level for the same reason. */
  parse: (raw: unknown) => T;
  /** The `aisixEndpoints` unsupported family these rules belong to. */
  domain: AisixUnsupportedDomain;
  /**
   * The catalogue key for a read that failed WITHOUT an architectural reason to
   * quote (a 404 on a build that does ship the route, a transport failure). It
   * takes an `{error}` placeholder. The architectural reason always wins when
   * there is one, so this is never what an operator sees on a static host.
   */
  failureMessageKey: string;
  /**
   * The namespace translator. Module-stable in next-intl, so it is a safe effect
   * dependency — unlike a closure built inline from `t`, which would be a new
   * function object on every render.
   */
  translate: ProviderMessageTranslator;
  /**
   * Literal used for `failureMessageKey` when the catalogue has no such key
   * (`providerText` semantics). Cards whose messages predate the catalogue pass
   * it; a card whose key always exists may omit it.
   */
  failureFallback?: string;
  policy?: BoundedReadPolicy;
  /** Skip the read entirely (e.g. the write-only side of the card). */
  enabled?: boolean;
}

export function useProviderSectionRead<T>(
  options: ProviderSectionReadOptions<T>
): ProviderSectionReadState<T> {
  const {
    providerId,
    read,
    parse,
    domain,
    failureMessageKey,
    failureFallback,
    translate,
    policy,
    enabled = true,
  } = options;
  // The stored answer, tagged with the providerId it was read FOR, and the
  // answer as PUBLISHED — deliberately different, and the gap between them is
  // the third consequence of the module invariant.
  //
  // `state` alone was the bug: a `ready` payload about one provider, still
  // sitting there on the first render after a switch. Resetting it during
  // render does NOT close that hole, and the reason matters: the cards adjust
  // their own state during render too
  // (`if (read.phase === "ready" && seededFor !== providerId) { setSeededFor(…);
  // setToggles(read.data) }`), and a render-phase update is APPLIED, not
  // discarded — so that pass would spend the seed claim on the previous
  // provider's data and the real payload would arrive to find the claim
  // already spent. The fix is not to CLEAR the answer, it is to never RETURN
  // it.
  //
  // `!enabled` is derived here for the same reason: "this card is not allowed
  // to read" is a fact about the options, not an answer from the network, so
  // storing it wrote a fresh object on every effect run — and a card whose
  // `read` identity is not the stable module function the contract asks for
  // re-ran the effect on every commit, so the write fed itself. Deriving it
  // leaves the effect with nothing to write but a real answer, and a disabled
  // card costs no request and no render.
  //
  // Keyed on `providerId` and `enabled` alone: a plain re-render passes the same
  // keys and is handed the stored answer untouched, so it neither resets the
  // card nor costs a re-read.
  const [stored, setStored] = useState<StoredRead<T>>({
    providerId,
    phase: "loading",
    attempts: 0,
  });
  const state: ProviderSectionReadState<T> = !enabled
    ? { phase: "refused", reason: "", attempts: 0 }
    : stored.providerId === providerId
      ? stored
      : { phase: "loading", attempts: 0 };
  // The claim: the providerId whose read is in flight, or already finished. A
  // single SLOT, not a per-provider cache — a ceiling on requests for the
  // provider on screen. It is taken synchronously, before the first request
  // goes out, because marking it only on settle left a window in which any
  // re-render during the in-flight read re-entered the effect and issued a
  // SECOND request for data that was already on its way.
  //
  // Two rules keep it honest, and both are consequences of the module
  // invariant: only a run that will really read may take it (1), and a run that
  // dies without settling hands it back (2) — otherwise a superseded read
  // would turn its own replacement into a no-op. A run that DID settle keeps
  // it, which is what makes this the hard ceiling: a given providerId gets at
  // most `maxAttempts` requests after it settles, no matter how often the
  // effect is re-entered and whatever its dependencies turn out to be. A
  // different providerId re-reads, as it must.
  const claimedForRef = useRef<string | null>(null);

  // `resolveAisixSurfaceSupport` is a pure build-time branch, so this is a stable
  // boolean rather than an object identity the effect would have to chase.
  const supported = resolveAisixSurfaceSupport(domain, "read").supported;

  useEffect(() => {
    // Created synchronously so the cleanup below can abort it. Without this a
    // card that unmounts mid-backoff (client navigation away from the provider
    // page) keeps issuing retries for a page nobody is looking at.
    const controller = new AbortController();
    // Whether THIS run reached a terminal state, and whether it is the run that
    // holds the claim. Both are per-run, and the cleanup needs both — see it.
    let settled = false;
    let ownsClaim = false;
    // Async continuation — the compiler rejects a synchronous call to a
    // setter-capturing path from the effect body (react-hooks/set-state-in-effect).
    void (async () => {
      // Deliberately ABOVE the claim. `enabled` is a RUNTIME condition — a card
      // mounted before it has a providerId to read — so a claim taken here
      // belongs to a run that will never read, and it would be held for the rest
      // of the mount: when `enabled` finally flips true the effect returns at the
      // claim check and the card sits on an empty refusal forever. The
      // `!supported` branch below is the opposite case, a build-time constant,
      // so claiming it costs nothing and saves a redundant state write on every
      // dependency change.
      if (!enabled) return;
      if (claimedForRef.current === providerId) return;
      claimedForRef.current = providerId;
      ownsClaim = true;
      if (!supported) {
        // Known-unsupported by architecture: refuse WITHOUT firing the request.
        // The reason comes from the same `aisixUnsupportedRead` table every other
        // gateway-only surface quotes, so the operator reads one consistent story.
        settled = true;
        setStored({
          providerId,
          phase: "refused",
          reason: resolveAisixSurfaceSupport(domain, "read").reason,
          attempts: 0,
        });
        return;
      }

      const outcome = await readWithBoundedRetry(() => read(providerId), parse, policy, {
        signal: controller.signal,
      });
      // Superseded mid-flight. The re-run this cleanup unblocked is what now
      // owns the state, and reporting a result React has already abandoned is
      // how a card ends up rendering the answer to a question it stopped asking.
      if (controller.signal.aborted) return;
      if (outcome.ok) {
        settled = true;
        setStored({
          providerId,
          phase: "ready",
          data: outcome.data as T,
          attempts: outcome.attempts,
        });
        return;
      }

      // A failed read is reported ONCE. This notification is read imperatively:
      // subscribing to the store here is what turned a 404 into a 70 req/s loop,
      // because the toast made the store object a new reference for this effect.
      const detail =
        outcome.classification === "signedOut"
          ? "signed out"
          : `HTTP ${outcome.status || 0}`.trim() || (outcome.error ?? "request failed");
      const reason = providerText(
        translate,
        failureMessageKey,
        failureFallback ?? failureMessageKey,
        { error: detail }
      );
      useNotificationStore.getState().error(reason);
      settled = true;
      setStored({ providerId, phase: "refused", reason, attempts: outcome.attempts });
    })();

    return () => {
      // A run that never settled is dead: it was aborted, it will not call
      // `setStored`, and the effect is about to run again for the same
      // providerId (a dependency changed, or React double-invoked the mount
      // effect).
      // Handing the claim back is what lets that re-run actually read. A run
      // that DID settle keeps it, so the request ceiling still holds.
      //
      // The `ownsClaim` guard is not defensive: a run that returned at the
      // claim check holds nothing, and clearing the ref on its behalf would
      // hand a SETTLED card's claim to the next dependency change — which is
      // how "release the claim" turns back into a read behind every render.
      if (ownsClaim && !settled) claimedForRef.current = null;
      controller.abort();
    };
  }, [
    providerId,
    read,
    parse,
    domain,
    failureMessageKey,
    failureFallback,
    translate,
    policy,
    supported,
    enabled,
  ]);
  return state;
}

/**
 * The write half of the same card. Returns a refusal instead of sending a
 * request the deployment cannot answer, so the operator is told at the click
 * rather than after a guaranteed 404.
 */
export function useProviderSectionWrite(domain: AisixUnsupportedDomain) {
  const support = resolveAisixSurfaceSupport(domain, "write");
  return {
    supported: support.supported,
    reason: support.supported ? null : support.reason,
    refuse: (action: string): boolean => {
      if (support.supported) return false;
      useNotificationStore.getState().error(`${action}: ${support.reason}`);
      return true;
    },
  };
}

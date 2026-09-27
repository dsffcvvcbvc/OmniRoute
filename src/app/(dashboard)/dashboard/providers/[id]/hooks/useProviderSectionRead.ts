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
 * Three properties make that impossible here:
 *
 *   1. `resolveAisixSurfaceSupport(domain, "read")` decides BEFORE any request
 *      is issued. On the static export the read is known-unsupported, so zero
 *      requests are fired and the card renders the honest refusal. This is the
 *      same mechanism the radar/costs/logs/relay cards already use — not a
 *      second one.
 *   2. What is left runs under `readWithBoundedRetry`: an `unsupported` answer
 *      settles after one attempt, and only a network/5xx failure is retried,
 *      with backoff and a hard attempt ceiling.
 *   3. The effect depends on nothing the effect itself can change. The
 *      notifier is read imperatively with `useNotificationStore.getState()`
 *      (the same pattern `HomePageClient` uses for notify-from-async) instead of
 *      subscribing, so a toast can no longer re-arm the read. `settledForRef`
 *      is the backstop: a providerId that has already reached a terminal state
 *      is not re-read, so even a future unstable dependency degrades to "stale"
 *      rather than to "loop".
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
  const [state, setState] = useState<ProviderSectionReadState<T>>({
    phase: "loading",
    attempts: 0,
  });
  // The providerId whose read has been CLAIMED — claimed, not "settled": the
  // claim is taken synchronously, before the first request goes out, and is not
  // released. Marking it only on settle left a window in which any re-render
  // during the in-flight read re-entered the effect and issued a SECOND request
  // for data that was already on its way.
  //
  // This is the hard ceiling, and it is the one that holds unconditionally: a
  // given providerId gets at most `maxAttempts` requests for the lifetime of the
  // mount, no matter how often the effect is re-entered and whatever its
  // dependencies turn out to be. An unstable dependency can now only make a card
  // stale, never make it loop. A different providerId re-reads, as it must.
  const claimedForRef = useRef<string | null>(null);

  // `resolveAisixSurfaceSupport` is a pure build-time branch, so this is a stable
  // boolean rather than an object identity the effect would have to chase.
  const supported = resolveAisixSurfaceSupport(domain, "read").supported;

  useEffect(() => {
    // Created synchronously so the cleanup below can abort it. Without this a
    // card that unmounts mid-backoff (client navigation away from the provider
    // page) keeps issuing retries for a page nobody is looking at.
    const controller = new AbortController();
    // Async continuation — the compiler rejects a synchronous call to a
    // setter-capturing path from the effect body (react-hooks/set-state-in-effect).
    void (async () => {
      if (claimedForRef.current === providerId) return;
      claimedForRef.current = providerId;
      if (!enabled) {
        setState({ phase: "refused", reason: "", attempts: 0 });
        return;
      }
      if (!supported) {
        // Known-unsupported by architecture: refuse WITHOUT firing the request.
        // The reason comes from the same `aisixUnsupportedRead` table every other
        // gateway-only surface quotes, so the operator reads one consistent story.
        setState({
          phase: "refused",
          reason: resolveAisixSurfaceSupport(domain, "read").reason,
          attempts: 0,
        });
        return;
      }

      const outcome = await readWithBoundedRetry(() => read(providerId), parse, policy, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (outcome.ok) {
        setState({ phase: "ready", data: outcome.data as T, attempts: outcome.attempts });
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
      setState({ phase: "refused", reason, attempts: outcome.attempts });
    })();

    return () => controller.abort();
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

"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  getAisixSessionEpoch,
  getAisixSessionState,
  isAisixSignedOut,
  subscribeAisixSessionEpoch,
  subscribeAisixSignedOut,
  type AisixSessionState,
} from "@/shared/utils/aisixAdminAuth";

/**
 * `true` once an admin request has answered 401, until a successful exchange.
 *
 * Edge-triggered, so this flips once per signed-out episode rather than once per
 * 401: a page that fires five admin reads in parallel, or a surface that keeps
 * re-reading while signed out, does not storm the operator with state changes.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect`: the source of
 * truth is a module, not this component, and the store can be read at subscribe
 * time — which matters because the 401 that signed the operator out may have
 * landed before this component mounted, and an effect-seeded `false` would then
 * render a stale "signed in" strip over a signed-out dashboard.
 */
export function useAisixSignedOut(): boolean {
  return useSyncExternalStore(subscribeAisixSignedOut, isAisixSignedOut, isAisixSignedOut);
}

/**
 * The three-valued session state — see `AisixSessionState`.
 *
 * Subscribes to BOTH stores on purpose. Every transition that matters is
 * announced by one of them: a 401 fires the signed-out edge, and a successful
 * exchange or an explicit sign-out fires the epoch. The one change neither
 * announces is `hasSession` being learned from a 2xx read, and that is safe to
 * miss because it can only move the state from `anonymous` to `active` — the two
 * values a guard treats identically. The snapshot is derived fresh from the two
 * booleans on every call, so it cannot be stale by more than one notification.
 */
export function useAisixSessionState(): AisixSessionState {
  const subscribe = useCallback((onChange: () => void) => {
    const unsubscribeSignedOut = subscribeAisixSignedOut(onChange);
    const unsubscribeEpoch = subscribeAisixSessionEpoch(onChange);
    return () => {
      unsubscribeSignedOut();
      unsubscribeEpoch();
    };
  }, []);
  return useSyncExternalStore(subscribe, getAisixSessionState, getAisixSessionState);
}

/**
 * The session epoch: a number that changes once per successful exchange.
 *
 * Put it in a `useEffect` dependency array to make a surface read again after a
 * login. The alternative — a refetch on a timer, or leaving the surface showing
 * its withheld 401 state until the operator reloads by hand — is the behaviour
 * this exists to remove.
 *
 * `getSnapshot` returns a number, so the identity is stable between epochs and
 * React does not re-render on every store notification.
 */
export function useAisixSessionEpoch(): number {
  const subscribe = useCallback((onChange: () => void) => subscribeAisixSessionEpoch(onChange), []);
  return useSyncExternalStore(subscribe, getAisixSessionEpoch, getAisixSessionEpoch);
}

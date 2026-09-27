"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  getAisixSessionEpoch,
  isAisixSignedOut,
  subscribeAisixSessionEpoch,
  subscribeAisixSignedOut,
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
  const subscribe = useCallback(
    (onChange: () => void) => subscribeAisixSessionEpoch(onChange),
    []
  );
  return useSyncExternalStore(subscribe, getAisixSessionEpoch, getAisixSessionEpoch);
}

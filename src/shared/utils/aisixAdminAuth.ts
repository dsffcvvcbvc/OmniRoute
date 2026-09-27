/**
 * AISIX admin-plane auth — the ONE module every admin read and write goes
 * through.
 *
 * ## Why the exchange exists
 *
 * `POST /admin/v1/auth/session` exchanges an admin key for an `HttpOnly`
 * session cookie. The SPA and the Admin API share an origin (the binary serves
 * the static export itself), so that cookie rides along on every `/admin/v1/*`
 * request without the page doing anything. That is the only reason the browser
 * can read the admin plane at all: the alternative — keeping the key in the
 * page — puts the admin credential in a `localStorage` entry every script on
 * the origin can read, which is exactly what the admin key is not for.
 *
 * Contract, read off `aisix-admin/src/session.rs` + `auth.rs`:
 *
 *   POST   /admin/v1/auth/session  {"admin_key": "…"}
 *     204  success, NO body. The browser now holds the cookie.
 *     400  THE REQUEST SHAPE was refused (not a JSON object, a missing or
 *          empty `admin_key`, or an unknown field) — NOT a wrong key.
 *     401  the key is not in `config.admin.admin_keys`. Re-prompt.
 *     403  the browser sent a cross-origin `Origin`. Same-origin cannot
 *          produce this, so it is a client bug, not an operator problem.
 *
 *   Any other admin read:
 *     401  the session is gone — 8h absolute TTL, revoked by logout, or the
 *          gateway restarted (sessions are in-process). Back to the prompt.
 *     403  the same-origin guard refused a mutation. Client bug.
 *
 *   DELETE /admin/v1/auth/session
 *     204  revoked and the cookie cleared.
 *     401  already signed out — there was no session left to revoke. Read it
 *          as success: the observable outcome (no session) holds either way.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not store the key. The admin key lives as a local variable inside
 * `exchangeAdminKeyForSession` for the duration of one request and is then
 * gone: not in `localStorage`, not in `sessionStorage`, not in a JS-readable
 * cookie, not in the URL, not in any store. `tests/unit/aisix-admin-key-not-persisted.test.ts`
 * is the mechanical guard on that claim.
 *
 * It does not read the session cookie either. The cookie is `HttpOnly`, so
 * there is nothing for JS to read; `hasReadableSessionCookie()` exists only to
 * prove that in a test and is never used to make a decision.
 *
 * ## The one signal
 *
 * `subscribeAisixSignedOut` is the single "you are signed out" notification the
 * whole dashboard listens to. It is EDGE-triggered: `noteAdminResponseStatus`
 * only fires on a transition into the signed-out state, so the five parallel
 * admin reads a page fires do not produce five prompts, and a page that keeps
 * polling a dead session does not re-prompt on every poll. That is also what
 * makes "never retry in a loop on 401" true by construction — nothing here
 * retries at all; it observes.
 *
 * `subscribeAisixSessionEpoch` is the companion "a new session exists, go read
 * again" notification, bumped once per successful exchange so surfaces can
 * refetch without polling.
 */

import { fetchWithTimeout } from "./fetchTimeout";
import { getAisixAdminBase } from "./aisixTransportBase";

/**
 * `true` when a URL is on the native admin base (`:3001`).
 *
 * The auth policies — the cookie, the header rule, the 401 signal — apply to the
 * ADMIN plane only. `:9090` and `:3000` are unauthenticated by construction, and
 * in a normal Next build a `/api/*` URL is OmniRoute's own surface with its own
 * 401 that has nothing to do with a gateway session. Routing those through this
 * transport would make an unrelated 401 open a gateway login prompt, so the
 * chokepoint asks this first and leaves everything else on the plain path.
 */
export function isAisixAdminUrl(url: string): boolean {
  const base = getAisixAdminBase().toLowerCase().replace(/\/+$/, "");
  return url.toLowerCase().startsWith(`${base}/`);
}

/** The admin session endpoints, built from the same base every admin read uses. */
export function aisixSessionUrl(): string {
  return `${getAisixAdminBase()}/admin/v1/auth/session`;
}

/**
 * How a non-2xx admin answer is classified. These are four DIFFERENT operator
 * situations and collapsing them is how a UI ends up saying "bad key" for a
 * request it built wrong:
 *
 *   `unauthorized` — 401. No valid credential. On the exchange it means the key
 *                    was refused; on any other read it means the session is gone.
 *   `forbidden`    — 403. The same-origin guard refused the request. A client
 *                    bug: a same-origin dashboard never produces this.
 *   `bad_request`  — 400. The request SHAPE was refused. Never reported as a
 *                    wrong key — the key was never even compared.
 *   `missing`      — 404/405. The route is not on this gateway build. Final.
 */
export type AisixAdminFailureKind = "unauthorized" | "forbidden" | "bad_request" | "missing";

/**
 * The classification, by status. `null` for 2xx and for every other status
 * (5xx, network failure), because those are not a credential problem and
 * classifying them as one would send the operator to the wrong fix.
 *
 * 404/405 counts as `missing` here rather than being left to
 * `isAisixMissingEndpointStatus`: a single table is what keeps "does this
 * status mean the surface is absent" from being answered twice, differently.
 */
export function classifyAisixAdminStatus(status: number): AisixAdminFailureKind | null {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 400) return "bad_request";
  if (status === 404 || status === 405) return "missing";
  return null;
}

/** Per-request options every admin call may pass. */
export interface AisixAdminRequestOptions extends Omit<RequestInit, "credentials"> {
  /**
   * An admin key to present as `Authorization: Bearer`. ONLY a caller that
   * already holds a key sets this — an ingress-injected header, or the
   * integration suite. The browser login path never sets it: it exchanges the
   * key once and then relies on the cookie, so a key is never in a header a
   * redirect or an error report could echo.
   *
   * Precedence on the server is strict — a PRESENT `Authorization` decides and
   * the cookie is not consulted — so sending a stale key would break a valid
   * cookie session. That is why the default is "no header at all".
   */
  adminKey?: string;
  /** Bound on the request. Defaults to the tolerant-read bound. */
  timeoutMs?: number;
  /**
   * Alternative fetch implementation. Exists so the callers that already had an
   * injectable `fetchImpl` seam keep it; production callers never set it, which
   * is why the default is `globalThis.fetch` rather than something looked up.
   */
  fetchFn?: typeof globalThis.fetch;
}

const DEFAULT_ADMIN_TIMEOUT_MS = 15_000;

/** `Authorization` when — and only when — the caller explicitly supplied a key. */
function adminAuthHeader(adminKey: string | undefined): Record<string, string> {
  const key = typeof adminKey === "string" ? adminKey.trim() : "";
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// ─── the signed-out signal ───────────────────────────────────────────────

type SignedOutListener = () => void;
type SessionEpochListener = () => void;

const signedOutListeners = new Set<SignedOutListener>();
const sessionEpochListeners = new Set<SessionEpochListener>();

/** `true` once any admin request has answered 401, until an exchange succeeds. */
let signedOut = false;
/** Bumped once per successful exchange. Surfaces refetch on a change. */
let sessionEpoch = 0;

/**
 * Subscribe to "the admin session is gone". Returns the unsubscribe function.
 *
 * Fires at most once per signed-out episode, not once per 401 — see the module
 * doc. A page that mounts several admin readers therefore opens the prompt
 * once, and a surface that re-reads while signed out does not fight the
 * operator's own typing with a stream of notifications.
 */
export function subscribeAisixSignedOut(listener: SignedOutListener): () => void {
  signedOutListeners.add(listener);
  return () => {
    signedOutListeners.delete(listener);
  };
}

/** Subscribe to "a new session exists — read again". Returns the unsubscribe. */
export function subscribeAisixSessionEpoch(listener: SessionEpochListener): () => void {
  sessionEpochListeners.add(listener);
  return () => {
    sessionEpochListeners.delete(listener);
  };
}

/** `true` when an admin request has answered 401 since the last successful exchange. */
export function isAisixSignedOut(): boolean {
  return signedOut;
}

/** The current session epoch. Changes only on a successful exchange. */
export function getAisixSessionEpoch(): number {
  return sessionEpoch;
}

/**
 * Record the outcome of an admin response and emit the signed-out signal on a
 * 401. The only place the signal is raised from — every admin path funnels
 * through `aisixAdminFetch`, so the edge is in one place.
 *
 * Edge-triggered on purpose: `signedOut` is already `true` for the five other
 * reads in the same page load, so only the first one notifies.
 */
export function noteAisixAdminStatus(status: number): AisixAdminFailureKind | null {
  const failure = classifyAisixAdminStatus(status);
  if (failure !== "unauthorized") return failure;
  if (signedOut) return failure;
  signedOut = true;
  for (const listener of [...signedOutListeners]) {
    try {
      listener();
    } catch {
      // One broken subscriber must not stop the others from being told.
    }
  }
  return failure;
}

/** Called by a successful exchange: the session exists, so clear the state and bump the epoch. */
function markAisixSignedIn(): void {
  signedOut = false;
  sessionEpoch += 1;
  for (const listener of [...sessionEpochListeners]) {
    try {
      listener();
    } catch {
      // Same reasoning as above.
    }
  }
}

/** Drop all module state. Test-only, and named for what it protects: a shared
 * module-level `signedOut` that leaks between tests would make the edge
 * behaviour unobservable.
 */
export function __resetAisixAdminAuthForTests(): void {
  signedOutListeners.clear();
  sessionEpochListeners.clear();
  loginRequestedListeners.clear();
  signedOut = false;
  sessionEpoch = 0;
}

// ─── "open the prompt" ────────────────────────────────────────────────────

type LoginRequestedListener = () => void;

const loginRequestedListeners = new Set<LoginRequestedListener>();

/**
 * Ask the dashboard to show the key prompt, without a signed-out event.
 *
 * The per-surface 401 states (`provider-keys-denied`, `preset-providers-denied`,
 * `combos-admin-key-required`) keep their own honest "withheld, not empty"
 * banner — that is the state a reader lands on and it must not be replaced. This
 * is the button ON that banner: the operator has decided to act, and the prompt
 * belongs to the one component that owns it, so the banner asks for it rather
 * than owning a second copy of the form.
 */
export function requestAdminLogin(): void {
  for (const listener of [...loginRequestedListeners]) {
    try {
      listener();
    } catch {
      // One broken subscriber must not stop the others from being told.
    }
  }
}

/** Subscribe to "show the key prompt now". Returns the unsubscribe function. */
export function subscribeAisixLoginRequested(listener: LoginRequestedListener): () => void {
  loginRequestedListeners.add(listener);
  return () => {
    loginRequestedListeners.delete(listener);
  };
}

// ─── the transport ────────────────────────────────────────────────────────

/**
 * The single admin-plane transport.
 *
 * Every admin read and write in the dashboard goes through here, so three
 * policies cannot drift apart:
 *
 *   1. `credentials: "include"` always. Same-origin needs no CORS and no
 *      explicit include for the cookie to ride along, but sending it is
 *      harmless and is the correct-by-default spelling for a request that
 *      carries a credential — it keeps the client honest if an ingress in
 *      front of `:3001` ever makes the origin non-coincident.
 *   2. `Authorization` only when the caller passed `adminKey`. See
 *      `AisixAdminRequestOptions.adminKey` for why the default must be "no
 *      header": a present header DECIDES on the server and short-circuits the
 *      cookie.
 *   3. A 401 raises the signed-out signal exactly once per episode.
 *
 * Never throws for a status; a network failure or timeout propagates to the
 * caller, which is what every existing caller already handles.
 */
export async function aisixAdminFetch(
  url: string,
  options: AisixAdminRequestOptions = {}
): Promise<Response> {
  const { adminKey, timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS, fetchFn, headers, ...init } = options;
  const response = await fetchWithTimeout(url, {
    ...init,
    credentials: "include",
    headers: { ...adminAuthHeader(adminKey), ...(headers as Record<string, string> | undefined) },
    timeoutMs,
    fetchFn: fetchFn ?? (globalThis.fetch as typeof fetch),
  });
  noteAisixAdminStatus(response.status);
  return response;
}

// ─── the exchange ─────────────────────────────────────────────────────────

/**
 * What the exchange can conclude. `signed_in` is only ever returned after a
 * confirming read, never straight off the 204 — see below.
 */
export type AdminSessionOutcome =
  /** The key was accepted AND a follow-up admin read succeeded: a usable session. */
  | { ok: true }
  /**
   * The key was not in `admin.admin_keys`. Re-prompt; this is the only outcome
   * that is the operator's key being wrong.
   */
  | { ok: false; failure: "unauthorized"; errorMsg: string | null }
  /**
   * The gateway refused the REQUEST SHAPE (400). The key was never compared, so
   * saying "wrong key" here would be a lie about what the server checked. A
   * client bug, reported as one.
   */
  | { ok: false; failure: "bad_request"; errorMsg: string | null }
  /**
   * The same-origin guard refused the request (403). A same-origin dashboard
   * cannot produce this; a client bug, reported as one.
   */
  | { ok: false; failure: "forbidden"; errorMsg: string | null }
  /**
   * The exchange answered 204 and a follow-up admin read still answered 401.
   *
   * This is the `Secure`-cookie-over-plain-HTTP failure mode, and it is why
   * the exchange does not stop at the 204. The gateway marks the cookie
   * `Secure` exactly when the admin listener terminates TLS (`admin.tls`), and
   * a browser DROPS a `Secure` cookie received over plain HTTP — so on such a
   * deployment the login appears to do nothing at all. Reporting "signed in"
   * on the 204 alone would be the optimistic lie the contract forbids; instead
   * the outcome names the real cause instead of spinning and re-prompting for
   * a key that was accepted.
   */
  | { ok: false; failure: "session_not_kept"; errorMsg: string | null }
  /** The exchange never produced a response (network failure or timeout). */
  | { ok: false; failure: "unreachable"; errorMsg: string | null };

/**
 * The gateway's `{"error_msg": "…"}` envelope, or `null`. Read tolerantly: a
 * missing or non-JSON body must not turn a readable refusal into a crash, and
 * the message is only ever an extra detail beside the classification.
 */
async function readErrorMsg(response: Response): Promise<string | null> {
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const value = (payload as Record<string, unknown>).error_msg;
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  } catch {
    // No readable envelope; the status is the whole answer.
  }
  return null;
}

/**
 * Confirm a session by making ONE bounded admin read.
 *
 * Skipped entirely when the caller passes an explicit `adminKey`: that path is
 * the ingress / integration-suite case, where the caller already has a working
 * credential and its reads are authenticated by the header — a cookie check
 * would report a false `session_not_kept` for a request that is in fact
 * authorized. The browser path (no key) is the one that needs proving.
 */
async function confirmSession(adminKey: string | undefined): Promise<AdminSessionOutcome> {
  if (typeof adminKey === "string" && adminKey.trim().length > 0) {
    markAisixSignedIn();
    return { ok: true };
  }
  const probe = await aisixAdminFetch(`${getAisixAdminBase()}/admin/v1/models`);
  if (probe.ok) {
    markAisixSignedIn();
    return { ok: true };
  }
  const errorMsg = await readErrorMsg(probe);
  if (probe.status === 401) return { ok: false, failure: "session_not_kept", errorMsg };
  if (probe.status === 403) return { ok: false, failure: "forbidden", errorMsg };
  return { ok: false, failure: "session_not_kept", errorMsg };
}

/**
 * Exchange an admin key for a session cookie.
 *
 * The key is sent once, in the request body — never a query string, because a
 * key in a URL lands in access logs, `Referer` headers and browser history. It
 * is never echoed back, never logged, and never retained: it is an argument,
 * it lives in one `JSON.stringify` and one `fetch` body, and this function
 * returns no reference to it in any outcome.
 */
export async function exchangeAdminKeyForSession(
  adminKey: string,
  options: AisixAdminRequestOptions = {}
): Promise<AdminSessionOutcome> {
  const key = typeof adminKey === "string" ? adminKey.trim() : "";
  if (key.length === 0) {
    // Never sent: the server answers 400 for an empty `admin_key`, and a
    // round-trip to be told the field we already know is empty is a request
    // that teaches the operator nothing.
    return { ok: false, failure: "bad_request", errorMsg: null };
  }

  let response: Response;
  try {
    response = await aisixAdminFetch(aisixSessionUrl(), {
      ...options,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admin_key: key }),
    });
  } catch {
    return { ok: false, failure: "unreachable", errorMsg: null };
  }

  // 204 carries no body by contract. The ONLY thing the caller needs is the
  // `Set-Cookie`, so nothing here parses a success body — doing so would be
  // the classic "log in appears to fail because the response had no JSON".
  if (response.status === 204 || response.ok) {
    return confirmSession(options.adminKey);
  }

  const errorMsg = await readErrorMsg(response);
  if (response.status === 401) return { ok: false, failure: "unauthorized", errorMsg };
  if (response.status === 403) return { ok: false, failure: "forbidden", errorMsg };
  if (response.status === 400) return { ok: false, failure: "bad_request", errorMsg };
  return { ok: false, failure: "unreachable", errorMsg };
}

/**
 * Revoke the session and clear the cookie.
 *
 * `401` here is SUCCESS: it means the presented session was already expired or
 * revoked, so there was nothing to revoke, and the outcome the caller asked
 * for — no live session — holds either way. The server clears the cookie on
 * both answers, so there is no local cookie state to clean up: the cookie is
 * `HttpOnly` and this module deliberately keeps no copy of it.
 *
 * Always returns, and never throws: signing out must work when the gateway is
 * already unreachable, or the operator could not escape a signed-in state.
 */
export async function revokeAdminSession(options: AisixAdminRequestOptions = {}): Promise<void> {
  try {
    await aisixAdminFetch(aisixSessionUrl(), { ...options, method: "DELETE" });
  } catch {
    // A logout that cannot reach the gateway still drops local state below; the
    // cookie dies with the browser session and the server-side record is gone
    // with the process.
  }
  // Clear the local signed-out state either way: the operator asked to be
  // signed out, and we are not in a position to argue about it.
  signedOut = true;
  sessionEpoch += 1;
}

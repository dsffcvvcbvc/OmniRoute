"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import Button from "./Button";
import Modal from "./Modal";
import {
  useAisixSessionEpoch,
  useAisixSessionState,
  useAisixSignedOut,
} from "@/shared/hooks/useAisixAdminSession";
import { isAisixSpaExport } from "@/shared/utils/aisixEndpoints";
import {
  exchangeAdminKeyForSession,
  revokeAdminSession,
  subscribeAisixLoginRequested,
  type AdminSessionOutcome,
} from "@/shared/utils/aisixAdminAuth";

/**
 * The gateway key prompt, and the one place the dashboard speaks about the
 * session's lifetime.
 *
 * ## Why one component for every admin surface
 *
 * The providers list, the provider-key editor, the preset catalog and the
 * combos screen each have their own honest 401 state — "withheld, not empty" —
 * and those banners stay where they are. This component adds the thing every
 * one of them was missing: a way to ACT on the refusal. It listens to the one
 * shared signed-out signal, so a 401 anywhere opens exactly one prompt, and it
 * renders the prompt, so no page has to own a second copy of the form.
 *
 * ## The three outcomes it can report, and why they are three
 *
 *   wrong key (401)   — the operator's key is not in `admin.admin_keys`. Re-prompt.
 *   bad shape (400)   — the gateway refused the REQUEST, so the key was never
 *                      even compared. Saying "wrong key" would be a lie about
 *                      what was checked, so this is reported as a client bug.
 *   session not kept  — the exchange answered 204 and a follow-up admin read
 *                      still answered 401. That is the `Secure`-cookie-over-
 *                      plain-HTTP failure mode: the gateway marks the cookie
 *                      `Secure` exactly when the admin listener terminates TLS
 *                      (`admin.tls`), and a browser drops such a cookie received
 *                      over plain HTTP. The message names that instead of
 *                      spinning or re-prompting for a key the gateway accepted.
 *
 * There is no retry and no polling anywhere in this file. A 401 sends the
 * operator here; nothing here sends another request on its own.
 */

/** English fallbacks, following the page idiom in `combos/page.tsx`. */
const TEXT = {
  title: "Sign in to the gateway",
  intro:
    "The dashboard reads the gateway's admin API. Enter the admin key from admin.admin_keys in the gateway configuration.",
  keyLabel: "Admin key",
  keyHint:
    "The key is sent once and never stored in this browser: the gateway sets an HttpOnly session cookie that page scripts cannot read.",
  submit: "Sign in",
  cancel: "Cancel",
  signingIn: "Signing in…",
  signingOut: "Signing out…",
  emptyKey: "Enter the admin key.",
  wrongKey:
    "That key was not accepted. Check admin.admin_keys in the gateway configuration and try again.",
  badRequest:
    "The gateway rejected the request itself (400) — not the key. That is a dashboard defect; please report it.",
  forbidden:
    "The gateway refused this request as cross-origin (403). A dashboard served by the same gateway cannot produce that; please report it.",
  sessionNotKept:
    "The gateway accepted the key, but the browser did not keep the session cookie, so the dashboard is still signed out. This is what happens when the gateway marks the cookie Secure over a plain-HTTP connection: configure admin.tls on the admin listener, or serve the dashboard over HTTPS.",
  unreachable: "The gateway did not answer. Check that it is running, then try again.",
  signedIn: "Signed in to the gateway.",
  lifetimeNote:
    "A session lasts up to 8 hours and is held in the gateway process, so it ends at the next restart or redeploy. You will be asked for the key again then.",
  signOut: "Sign out",
  signInAction: "Sign in",
  endedNote:
    "Your session ended. Gateway sessions last up to 8 hours and do not survive a restart, so being asked again is expected.",
} as const;

/** The gateway's own `error_msg`, appended only when it adds something. */
function withServerDetail(base: string, detail: string | null): string {
  const trimmed = typeof detail === "string" ? detail.trim() : "";
  return trimmed.length > 0 ? `${base} (${trimmed})` : base;
}

export default function AdminSessionGate() {
  const t = useTranslations("adminAuth");
  const text = useCallback(
    (key: keyof typeof TEXT, fallback: string) => {
      try {
        if (typeof t.has === "function" && !t.has(key)) return fallback;
      } catch {}
      const out = t(key, fallback);
      return typeof out === "string" && out.length > 0 ? out : fallback;
    },
    [t]
  );

  const signedOut = useAisixSignedOut();
  const sessionState = useAisixSessionState();
  const sessionEpoch = useAisixSessionEpoch();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSignedOut, setJustSignedOut] = useState(false);
  const inputId = useId();
  const errorId = `${inputId}-error`;
  // The operator's own typing outranks an automatic prompt: a modal that
  // re-opens mid-sentence because another surface read fired a 401 is worse
  // than a prompt that waits.
  const dismissedRef = useRef(false);

  // The one global signal → one prompt. The per-surface banners keep their own
  // honest "withheld" state; this is the shared way out of it.
  //
  // Only `ended` opens it automatically. A browser that has never held a
  // credential is `anonymous`, and its 401 is the expected answer rather than a
  // lost session: opening "Your session ended" there would be a claim about an
  // event that did not happen. That operator still has a way in — the per-surface
  // "Sign in" buttons request the prompt explicitly, which is the honest
  // affordance for "you have not signed in yet".
  useEffect(() => {
    if (sessionState !== "ended" || dismissedRef.current) return;
    setJustSignedOut(true);
    setOpen(true);
  }, [sessionState]);

  // The per-surface "Sign in" buttons ask for the prompt explicitly.
  useEffect(
    () =>
      subscribeAisixLoginRequested(() => {
        dismissedRef.current = false;
        setError(null);
        setOpen(true);
      }),
    []
  );

  const close = useCallback(() => {
    dismissedRef.current = true;
    setJustSignedOut(false);
    setOpen(false);
    setError(null);
    // The value is dropped with the prompt. It is not kept in a ref, a store or
    // an effect so that closing the dialog cannot leave a copy of the key
    // anywhere JS can reach.
    setKey("");
  }, []);

  const submit = useCallback(async () => {
    const value = key.trim();
    if (value.length === 0) {
      setError(text("emptyKey", TEXT.emptyKey));
      return;
    }
    setBusy(true);
    setError(null);
    const outcome: AdminSessionOutcome = await exchangeAdminKeyForSession(value);
    // Overwrite the local copy before doing anything else with the outcome, so
    // the key is not still sitting in component state while the promise settles
    // and resolves.
    setKey("");
    setBusy(false);
    if (outcome.ok) {
      setOpen(false);
      setJustSignedOut(false);
      dismissedRef.current = false;
      return;
    }
    setError(describeFailure(outcome, text));
  }, [key, text]);

  const signOut = useCallback(async () => {
    setBusy(true);
    await revokeAdminSession();
    setBusy(false);
  }, []);

  // The Next build has its own login; the gateway prompt has nothing to say to
  // it, and mounting it there would put a second, meaningless sign-in control on
  // every page.
  if (!isAisixSpaExport()) return null;

  return (
    <>
      {/* Signed-in strip: the session's existence, its honest lifetime, and the
          only way out of it. Rendered on every dashboard page, because the
          session is a property of the origin and not of any one screen. */}
      {!signedOut && sessionEpoch > 0 && (
        <div
          role="status"
          data-testid="admin-session-strip"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-black/8 dark:border-white/8 bg-black/[0.02] dark:bg-white/[0.02] px-3 py-2 text-[11px] text-text-muted"
        >
          <span
            className="material-symbols-outlined text-[15px] text-green-600 shrink-0"
            aria-hidden="true"
          >
            verified_user
          </span>
          <span className="font-medium text-text-main">{text("signedIn", TEXT.signedIn)}</span>
          <span className="flex-1 min-w-[200px]">{text("lifetimeNote", TEXT.lifetimeNote)}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void signOut()}
            disabled={busy}
            data-testid="admin-session-sign-out"
          >
            {busy ? text("signingOut", TEXT.signingOut) : text("signOut", TEXT.signOut)}
          </Button>
        </div>
      )}

      <Modal
        isOpen={open}
        onClose={close}
        title={text("title", TEXT.title)}
        size="sm"
        showCloseButton
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-[13px] text-text-muted">{text("intro", TEXT.intro)}</p>

          {justSignedOut && (
            <p
              role="status"
              data-testid="admin-session-ended-note"
              className="text-[12px] text-text-muted"
            >
              {text("endedNote", TEXT.endedNote)}
            </p>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor={inputId} className="text-[12px] font-medium text-text-main">
              {text("keyLabel", TEXT.keyLabel)}
            </label>
            <input
              id={inputId}
              name="admin-key"
              type="password"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              disabled={busy}
              data-testid="admin-key-input"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-text-main outline-none focus:border-primary disabled:opacity-60"
            />
            {error ? (
              <p
                id={errorId}
                role="alert"
                data-testid="admin-key-error"
                className="text-[12px] text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            ) : (
              <p className="text-[11px] text-text-muted">{text("keyHint", TEXT.keyHint)}</p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={close}
              disabled={busy}
              data-testid="admin-key-cancel"
            >
              {text("cancel", TEXT.cancel)}
            </Button>
            <Button type="submit" loading={busy} data-testid="admin-key-submit">
              {busy ? text("signingIn", TEXT.signingIn) : text("submit", TEXT.submit)}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/**
 * Turn an exchange outcome into the one sentence the operator needs.
 *
 * Each branch names a DIFFERENT problem on purpose — the whole point of the
 * classification is that "wrong key" is only ever said about a 401.
 */
function describeFailure(
  outcome: Extract<AdminSessionOutcome, { ok: false }>,
  text: (key: keyof typeof TEXT, fallback: string) => string
): string {
  switch (outcome.failure) {
    case "unauthorized":
      return withServerDetail(text("wrongKey", TEXT.wrongKey), outcome.errorMsg);
    case "bad_request":
      return withServerDetail(text("badRequest", TEXT.badRequest), outcome.errorMsg);
    case "forbidden":
      return withServerDetail(text("forbidden", TEXT.forbidden), outcome.errorMsg);
    case "session_not_kept":
      return withServerDetail(text("sessionNotKept", TEXT.sessionNotKept), outcome.errorMsg);
    default:
      return withServerDetail(text("unreachable", TEXT.unreachable), outcome.errorMsg);
  }
}

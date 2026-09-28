// @vitest-environment jsdom
//
// Regression guard: "you never signed in" and "your session ended" are
// different facts, and the dashboard used to say the second one to people in
// the first situation.
//
// The failure this pins was visible on a real deployment: a browser with no
// credential loaded the providers index, the admin read answered 401, and the
// dashboard answered with a "Your session ended" dialog — for an operator who
// had never held a session. The 401 was correct; the sentence attached to it
// was not.
//
// The store is the real one (`aisixAdminAuth`) and only `fetch` is stubbed, so
// these cases drive the same transition path the browser does. Nothing here
// reaches for a private flag: the two states are told apart by the SEQUENCE of
// admin responses, which is the only information the client will ever have.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// The gate is inert outside the SPA export (a normal Next build has its own
// login), so a test that did not force this would assert against `null` and
// pass for the wrong reason.
vi.mock("@/shared/utils/aisixEndpoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/utils/aisixEndpoints")>()),
  isAisixSpaExport: () => true,
}));

const {
  __resetAisixAdminAuthForTests,
  aisixAdminFetch,
  exchangeAdminKeyForSession,
  requestAdminLogin,
  getAisixSessionState,
  isAisixSignedOut,
} = await import("@/shared/utils/aisixAdminAuth");
const { getAisixAdminBase } = await import("@/shared/utils/aisixTransportBase");

const { default: AdminSessionGate } = await import("@/shared/components/AdminSessionGate");

const MODELS_URL = `${getAisixAdminBase()}/admin/v1/models`;

let container: HTMLDivElement;
let root: Root;
let originalFetch: typeof globalThis.fetch;

/** Answer every admin read with one fixed status, the way a gateway would. */
function respondWith(status: number) {
  globalThis.fetch = (async () =>
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify({ error_msg: `status ${status}` }), {
          status,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch;
}

async function readAs(status: number) {
  respondWith(status);
  await act(async () => {
    await aisixAdminFetch(MODELS_URL);
  });
}

function renderGate() {
  act(() => {
    root.render(<AdminSessionGate />);
  });
}

const dialog = () => container.querySelector("[data-testid='admin-key-input']");
const endedNote = () => container.querySelector("[data-testid='admin-session-ended-note']");

beforeEach(() => {
  __resetAisixAdminAuthForTests();
  originalFetch = globalThis.fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
  __resetAisixAdminAuthForTests();
});

describe("AdminSessionGate — a refusal is only an ended session if there was one", () => {
  it("does NOT tell a browser that never held a credential that its session ended", async () => {
    await readAs(401);
    renderGate();

    // The refusal is still visible as state — the per-surface banners own that.
    // What must be absent is the claim about the operator's session history.
    expect(dialog()).toBeNull();
    expect(endedNote()).toBeNull();
  });

  it("DOES tell the operator their session ended when one really was working", async () => {
    // The reload case: a cookie that outlived the page load, then expired. The
    // 2xx is the only surviving evidence a session existed — the exchange is
    // history and the cookie is HttpOnly.
    await readAs(200);
    await readAs(401);
    renderGate();

    expect(dialog()).not.toBeNull();
    expect(endedNote()).not.toBeNull();
  });

  it("leaves a never-signed-in operator a way in, on request", async () => {
    // Suppressing the automatic prompt must not remove the affordance: the
    // per-surface "Sign in" button is the honest way to ask for a prompt when
    // you have not signed in yet.
    await readAs(401);
    renderGate();
    expect(dialog()).toBeNull();

    act(() => {
      requestAdminLogin();
    });

    // Opened — and still WITHOUT the "your session ended" note, which would be
    // the same false claim wearing a different hat.
    expect(dialog()).not.toBeNull();
    expect(endedNote()).toBeNull();
  });

  it("shows no dialog while the session is working, and never lies about it", async () => {
    await readAs(200);
    renderGate();

    // The precondition, asserted rather than assumed. This case is about the
    // `active` state and about nothing else, and a 2xx admin read is the ONLY
    // thing that produces it (aisixAdminAuth.ts:413-415). Without these two
    // lines the case cannot tell `active` from `anonymous`: deleting that
    // assignment leaves a 200-reading browser `anonymous`, every assertion
    // below still passes, and the case becomes a second copy of the
    // never-signed-in one wearing this one's name.
    expect(
      getAisixSessionState(),
      "a 2xx admin read is the only surviving evidence a credential existed"
    ).toBe("active");
    expect(isAisixSignedOut(), "a session that is working is not a signed-out one").toBe(false);

    expect(dialog(), "a working session must not be interrupted by a prompt").toBeNull();
    expect(endedNote(), "and nothing may claim a session ended while it is working").toBeNull();

    // The positive half, and the one thing this case did not have. A prompt is
    // still the way in from here, and it must not carry the note — for the
    // operator who really is signed in that sentence is the precise claim this
    // file exists to keep off the screen, and it is a far more plausible place
    // for it to reappear than on the anonymous path the case above covers.
    act(() => {
      requestAdminLogin();
    });

    expect(dialog(), "the prompt is still reachable from a working session").not.toBeNull();
    expect(
      endedNote(),
      "an operator who is signed in must never be told their session ended"
    ).toBeNull();
  });
});

/**
 * The same distinction, from the other side: an operator who SIGNS OUT has
 * answered the prompt, they have not lost a session.
 *
 * `revokeAdminSession` deliberately ends on `ended` — a sign-out is itself
 * proof a session existed — and `ended` is the only state the auto-open effect
 * watches. So "Sign out" put the operator straight back into the same modal,
 * with a "Your session ended" note about a session they ended on purpose. The
 * gate already keeps a dismissal flag for exactly this distinction; signing out
 * is answering the prompt, and it had to say so.
 */
describe("AdminSessionGate — a deliberate sign-out is not a lost session", () => {
  const strip = () => container.querySelector("[data-testid='admin-session-strip']");
  const signOutButton = () => container.querySelector("[data-testid='admin-session-sign-out']");

  /** A real exchange, so the strip renders exactly as it does in the browser. */
  async function signIn() {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/session")) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await act(async () => {
      const outcome = await exchangeAdminKeyForSession("a-key");
      expect(outcome.ok, "the exchange should have produced a session").toBe(true);
    });
  }

  it("signing out leaves the operator signed out, with no prompt springing back", async () => {
    await signIn();
    renderGate();

    // Without the strip there is nothing to click and the case would pass
    // vacuously.
    expect(strip(), "the signed-in strip should be rendered").not.toBeNull();

    await act(async () => {
      signOutButton()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The prompt stays shut. Before the fix it reopened here, with the
    // "Your session ended" note beside the strip that was just dismissed.
    expect(dialog(), "the sign-in prompt reopened after a deliberate sign-out").toBeNull();
    expect(endedNote(), "a session the operator ended is not a lost one").toBeNull();
    // And the strip is gone, so the assertion above is not satisfied by a
    // component that rendered nothing at all.
    expect(strip(), "the operator is still shown as signed in").toBeNull();
  });

  it("still prompts for a session that ends on its own afterwards", async () => {
    // The positive half. If the case above passed only because the gate never
    // opens, this one would fail — and the fix must not have turned "your
    // session ended" into silence.
    await signIn();
    renderGate();

    // A gateway restart: the next admin read is refused, and nobody asked it to
    // be. A credential WAS working and is not now.
    await readAs(401);

    expect(dialog(), "a genuinely lost session must still prompt").not.toBeNull();
    expect(endedNote(), "and must say so").not.toBeNull();
  });
});

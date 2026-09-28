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

const { __resetAisixAdminAuthForTests, aisixAdminFetch, requestAdminLogin } =
  await import("@/shared/utils/aisixAdminAuth");
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

  it("shows no dialog at all while the session is working", async () => {
    await readAs(200);
    renderGate();

    expect(dialog()).toBeNull();
    expect(endedNote()).toBeNull();
  });
});

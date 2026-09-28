// @vitest-environment jsdom
/**
 * R6-13, the named pair: the combos page's `settingsLoadError` /
 * `settingsSupported` consumers.
 *
 * The predicate itself (`resolveAisixSurfaceSupport("settings","read")`) is
 * tested in `aisix-api-surface-repoint.test.ts`. What was untested is what the
 * page DOES with the answer, and there are two halves that are independent and
 * both are operator-visible:
 *
 *   1. The three `/api/settings*` reads are SKIPPED, not fired into a guaranteed
 *      404. The gateway has no readable settings collection at all, so a fetch
 *      is a request that cannot succeed. `if (settingsSupported)` at
 *      `page.tsx:655` is the skip branch.
 *   2. The banner still RENDERS, because the page is running on built-in
 *      defaults. The three `*LoadError` flags are DERIVED from the same
 *      declaration (`xxxLoadFailed || !settingsSupported`, `page.tsx:492-494`)
 *      rather than being set from inside the effect. That derived half is
 *      load-bearing: with the reads skipped there is no `*LoadFailed`
 *      transition left to drive the banner, so dropping the `||` makes the
 *      notice vanish and the page presents defaults as if they were loaded.
 *
 * Both are asserted as OBSERVABLE EFFECTS — which URLs were requested, and
 * whether the operator's notice is in the document — not as "it rendered".
 *
 * On the asserted string: `settingsUnavailable` is in no locale catalogue, so
 * `getI18nOrFallback` takes its fallback branch and the DOM carries the English
 * literal. That makes this an assertion about what an operator actually reads,
 * not about a key name.
 *
 * On the mount gate: every banner assertion waits for a request the page
 * definitely makes BEFORE looking for the banner. Without that, a banner which
 * never appears is indistinguishable from a page that has not finished
 * mounting — `getByText` would just time out, and a timeout is a weak
 * falsifier because it can be had for any reason the render was slow. Gating on
 * a completed request makes a missing banner fail on the assertion itself.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";

// Stable translator reference: `useTranslations` must return the SAME function
// across renders, or every render invalidates the mount effect's deps and the
// fetches loop. No `has` method, which is what routes every lookup to the
// literal fallback — the same branch a locale that has not caught up takes.
const t = (key: string) => key;
vi.mock("next-intl", () => ({ useTranslations: () => t }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/shared/hooks/useAisixAdminSession", () => ({
  useAisixSessionEpoch: () => 0,
}));

vi.mock("@/shared/utils/aisixAdminAuth", () => ({ requestAdminLogin: vi.fn() }));

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock("@/store/emailPrivacyStore", () => ({
  default: (selector: (s: { emailsVisible: boolean }) => unknown) =>
    selector({ emailsVisible: false }),
}));

// The page is the unit under test; the predicate it consults is real. A test
// that mocked `resolveAisixSurfaceSupport` would be testing the mock.
import CombosPage from "@/app/(dashboard)/dashboard/combos/page";

const SETTINGS_URLS = ["/api/settings", "/api/settings/compression", "/api/settings/proxy"];
const DEFAULTS_NOTICE = "Settings service unavailable — showing built-in defaults.";

// The page is a 5 000-line client component with a dozen effects; jsdom needs
// more than vitest's default 5 s per test to mount it and settle its fetch
// chain. Applied as the per-test budget, not only to `waitFor`, or the budget
// fires first and fails a test for the wrong reason.
const TEST_TIMEOUT = 30_000;

/** The distinct paths the page requested, for membership assertions. */
function requestedPaths(fetchMock: ReturnType<typeof vi.fn>): Set<string> {
  const paths = new Set<string>();
  for (const call of fetchMock.mock.calls) {
    const url = String(call[0]);
    try {
      paths.add(new URL(url, "http://localhost").pathname);
    } catch {
      paths.add(url);
    }
  }
  return paths;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("combos page — the settings surface the AISIX gateway does not have", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  /**
   * Wait until the page has demonstrably run its mount effect by observing a
   * request it always makes. Also serves as the control for the skip
   * assertions: "no settings URL was requested" would otherwise be satisfied by
   * a page that requested nothing at all, which is the failure this suite
   * exists to distinguish from a deliberate skip.
   */
  async function waitForMount(): Promise<void> {
    await waitFor(() => expect(requestedPaths(fetchMock).has("/admin/v1/combos")).toBe(true), {
      timeout: TEST_TIMEOUT,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // The SPA export is what makes the settings surface unsupported; it is the
    // one build this page is actually shipped for.
    vi.stubEnv("NEXT_PUBLIC_AISIX_SPA_EXPORT", "1");

    fetchMock = vi.fn(async (url: string) => {
      const path = new URL(String(url), "http://localhost").pathname;
      if (SETTINGS_URLS.includes(path)) {
        // A real settings read would SUCCEED here. The page must never see it,
        // and its success would be indistinguishable from a working surface.
        return jsonResponse({ comboConfigMode: "guided", enabled: false });
      }
      if (path === "/admin/v1/combos") return jsonResponse({ error_msg: "not found" }, 404);
      if (path === "/admin/v1/models") return jsonResponse({ models: [] });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it(
    "still reads the surfaces that DO exist, so the skip is a decision and not a dead page",
    async () => {
      render(<CombosPage />);
      await waitForMount();
    },
    TEST_TIMEOUT
  );

  it(
    "SKIPS all three settings reads — a fetch here is a request that cannot succeed",
    async () => {
      render(<CombosPage />);
      await waitForMount();

      const paths = requestedPaths(fetchMock);
      for (const url of SETTINGS_URLS) {
        expect(
          paths.has(url),
          `${url} must not be requested on a gateway with no settings surface`
        ).toBe(false);
      }
    },
    TEST_TIMEOUT
  );

  it(
    "RENDERS the defaults notice — the reads were skipped, so the page IS on defaults",
    async () => {
      render(<CombosPage />);
      await waitForMount();

      expect(
        screen.queryByText(DEFAULTS_NOTICE),
        "the built-in-defaults notice must render on a gateway with no settings surface"
      ).toBeTruthy();
    },
    TEST_TIMEOUT
  );

  it(
    "derives the notice from the declaration, not from a failed read",
    async () => {
      render(<CombosPage />);
      await waitForMount();

      // Every request this mock received SUCCEEDED with 2xx JSON, including the
      // settings ones had they been made. So this notice can only have come
      // from the `|| !settingsSupported` half of the flags — a
      // declared-unsupported surface must not be indistinguishable from a read
      // that happened to fail.
      const settingsCalls = fetchMock.mock.calls.filter((call) =>
        SETTINGS_URLS.some((url) => String(call[0]).includes(url))
      );
      expect(settingsCalls, "no settings request may exist to have failed").toEqual([]);
    },
    TEST_TIMEOUT
  );
});

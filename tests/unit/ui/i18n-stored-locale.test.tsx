// @vitest-environment jsdom
//
// The read half of the stored locale preference — `readStoredLocale` in
// `src/shared/lib/persistLocale.ts`.
//
// Two claims this file defends, both about UNTRUSTED INPUT:
//
//   1. Total. Whatever a visitor has written into the `NEXT_LOCALE` cookie or
//      the localStorage mirror, the return value is either `null` or a code
//      this build actually ships a catalogue for. Downstream that value becomes
//      `import(\`./messages/<code>.json\`)`, so a value that escaped here would
//      be a chunk name chosen by whoever typed into devtools.
//   2. Server-parity. The same cookie is read by `src/i18n/request.ts` through
//      `resolveRequestedLocale`, so a retired locale (`in` → `id`) or a
//      differently-cased one must land the same way on both sides — otherwise
//      the export would answer "English" to a preference the standalone server
//      honours.
//
// The render-level consequence of both is asserted in
// `tests/unit/ui/spa-intl-provider.test.tsx`; this file is the total-function
// check, fast enough to run a wide input matrix.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readStoredLocale } from "@/shared/lib/persistLocale";
import { LOCALES, DEFAULT_LOCALE } from "@/i18n/config";

function clearStores(): void {
  document.cookie = "NEXT_LOCALE=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  window.localStorage.removeItem("NEXT_LOCALE");
}

const seed = (value: string, store: "cookie" | "local" | "both") => {
  clearStores();
  if (store !== "local") document.cookie = `NEXT_LOCALE=${value}; path=/`;
  if (store !== "cookie") window.localStorage.setItem("NEXT_LOCALE", value);
};

describe("readStoredLocale", () => {
  beforeEach(clearStores);
  afterEach(clearStores);

  it("returns null when nothing is stored", () => {
    expect(readStoredLocale()).toBeNull();
  });

  it("reads a stored locale out of either store", () => {
    seed("ja", "cookie");
    expect(readStoredLocale()).toBe("ja");

    seed("ar", "local");
    expect(readStoredLocale()).toBe("ar");
  });

  it("prefers the cookie, the order src/i18n/request.ts reads them in", () => {
    seed("ar", "both");
    expect(readStoredLocale()).toBe("ar");
  });

  it("falls back to the mirror when the cookie holds nothing usable", () => {
    clearStores();
    document.cookie = "SESSION=abc; path=/";
    window.localStorage.setItem("NEXT_LOCALE", "ja");

    expect(readStoredLocale()).toBe("ja");
  });

  it("resolves a retired locale and a differently-cased one like the server does", () => {
    seed("in", "cookie");
    expect(readStoredLocale()).toBe("id");

    seed("UK-ua", "cookie");
    expect(readStoredLocale()).toBe("uk-UA");
  });

  it("returns null on the server, so the export's prerender never sees a cookie", () => {
    seed("ja", "both");
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    // jsdom always defines `document`; the prerender and the `output:
    // "standalone"` render pass both run where it does not exist.
    Object.defineProperty(globalThis, "document", { value: undefined, configurable: true });
    try {
      expect(readStoredLocale()).toBeNull();
    } finally {
      if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    }
  });

  // The total-function check. Each of these is something a cookie editor, a
  // hostile page on the same origin, or a bug elsewhere can leave behind; none
  // of them may come back as a locale.
  const HOSTILE = [
    "",
    " ",
    "en ",
    "klingon",
    "xx",
    "en-US",
    "../../../etc/passwd",
    "en/../../messages/en",
    "./en",
    "/etc/passwd",
    "%2e%2e%2f%2e%2e%2f",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "prototype",
    'ja"',
    "ja\n",
    "ja\r\nSet-Cookie: x=1",
    "ja;path=/",
    "ja\u0000",
    "😀",
    "<script>alert(1)</script>",
    "../messages/en.json",
    "a".repeat(4096),
    "en\u0000.json",
  ];

  it("never returns an unconfigured code, from either store", () => {
    for (const value of HOSTILE) {
      for (const store of ["cookie", "local"] as const) {
        seed(value, store);
        const resolved = readStoredLocale();
        expect(
          resolved === null || (LOCALES as readonly string[]).includes(resolved),
          `readStoredLocale() returned ${JSON.stringify(resolved)} for the ${store} store ` +
            `holding ${JSON.stringify(value)}`
        ).toBe(true);
      }
    }
  });

  it("leaves the default locale alone rather than mistaking it for no answer", () => {
    seed(DEFAULT_LOCALE, "cookie");
    expect(readStoredLocale()).toBe(DEFAULT_LOCALE);
  });
});

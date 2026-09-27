import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page, Request, Response } from "@playwright/test";

/**
 * Shared instrumentation for the AISIX dashboard-SPA suite.
 *
 * Three rules this module exists to enforce:
 *
 *  1. NO MOCKING. Nothing here installs an interceptor, a route handler or a
 *     fixture server. Every request in every test goes to the real gateway on
 *     the real port. The only thing a test supplies is the admin key, as a
 *     request header — which is what an ingress in front of the admin port
 *     does, and the only way the shipped SPA can obtain a credential that
 *     lives in the gateway's own config.
 *
 *  2. NO SECRETS ON DISK. The key is read from the environment, never written
 *     to a report, never interpolated into a failure message. `scrub()` is
 *     applied to every recorded URL and every console line before it can reach
 *     `aisix-spa-evidence/`.
 *
 *  3. EVERY CHECK CAN FAIL. `PageWatch` records the raw evidence (console
 *     text, exception text, status codes, timestamps) and the specs assert on
 *     the recorded evidence rather than on a boolean someone flipped. If the
 *     product starts logging a hydration mismatch, the recorded text changes
 *     and the assertion goes red on its own.
 */

export const BASE_URL = process.env.AISIX_SPA_BASE_URL || "http://127.0.0.1:3001";
export const ADMIN_KEY = process.env.AISIX_SPA_ADMIN_KEY || "";

const EVIDENCE_DIR = process.env.AISIX_SPA_EVIDENCE_DIR || "aisix-spa-evidence";

/** Remove anything that could be a credential from a string about to be persisted. */
export function scrub(value: string): string {
  if (!value) return value;
  return value
    .split(ADMIN_KEY)
    .join("<admin-key>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/g, "$1<redacted>")
    .replace(/([?&](?:key|api_key|apikey|token|secret|password)=)[^&\s]+/gi, "$1<redacted>");
}

export function evidencePath(name: string): string {
  return path.join(EVIDENCE_DIR, name);
}

/** Write scrubbed evidence next to the test run. Never throws. */
export function writeEvidence(name: string, payload: unknown): void {
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(
      evidencePath(name),
      typeof payload === "string" ? scrub(payload) : scrub(JSON.stringify(payload, null, 2))
    );
  } catch {
    // Evidence is a convenience. A suite must never fail because a directory
    // is not writable.
  }
}

/**
 * React's hydration failures, as they reach the console. Next.js 16 surfaces
 * each of these once per affected subtree, and they are the only reliable
 * signal that the client tree disagreed with the prerendered HTML — the DOM
 * "looks fine" either way, which is exactly what made the previous report's
 * hydration question unanswerable from a screenshot.
 */
export const HYDRATION_ERROR_PATTERNS: readonly RegExp[] = [
  /hydrat/i,
  /did not match/i,
  /server[- ]rendered html/i,
  /server html/i,
  /text content does not match/i,
  /expected server html to contain/i,
  /there was an error while hydrating/i,
  /the server could not finish this suspense boundary/i,
];

/** Uncaught-exception / rejected-promise text that means the app is broken, not "still loading". */
export const FATAL_ERROR_PATTERNS: readonly RegExp[] = [
  /uncaught/i,
  /unhandled/i,
  /is not a function/i,
  /is not iterable/i,
  /cannot read propert/i,
  /undefined is not/i,
];

/**
 * Console lines the browser itself emits for a subresource that answered 4xx.
 * These are not app output; they are the network failure made visible, and
 * they are how a missing `_next/static` route announces itself.
 */
export const RESOURCE_FAILURE_PATTERNS: readonly RegExp[] = [
  /failed to load resource/i,
  /bad http response code/i,
];

export type RecordedResponse = {
  url: string;
  method: string;
  status: number;
  resourceType: string;
  at: number;
};

export type RecordedRequest = { url: string; method: string; at: number };

/**
 * Attaches to a page and records everything the assertions need. Install it
 * BEFORE the first navigation or the first paint is unobserved.
 */
export class PageWatch {
  readonly consoleErrors: string[] = [];
  readonly pageErrors: string[] = [];
  readonly responses: RecordedResponse[] = [];
  readonly requests: RecordedRequest[] = [];
  readonly failures: string[] = [];
  readonly start = Date.now();

  constructor(private readonly page: Page) {
    page.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      this.consoleErrors.push(`[${message.type()}] ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      this.pageErrors.push(error.message);
    });
    page.on("request", (request: Request) => {
      this.requests.push({
        url: request.url(),
        method: request.method(),
        at: Date.now() - this.start,
      });
    });
    page.on("response", (response: Response) => {
      const request = response.request();
      this.responses.push({
        url: response.url(),
        method: request.method(),
        status: response.status(),
        resourceType: request.resourceType(),
        at: Date.now() - this.start,
      });
    });
    page.on("requestfailed", (request: Request) => {
      this.failures.push(
        `${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "?"}`
      );
    });
  }

  /** Same-origin responses under `prefix` — the SPA's own asset tree. */
  under(prefix: string): RecordedResponse[] {
    return this.responses.filter((r) => r.url.startsWith(BASE_URL) && r.url.includes(prefix));
  }

  /** Every non-2xx same-origin response, newest last, de-duplicated by URL+status. */
  non2xx(): RecordedResponse[] {
    const seen = new Set<string>();
    return this.responses.filter((r) => {
      if (!r.url.startsWith(BASE_URL) || r.status < 400) return false;
      const key = `${r.status} ${r.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Uncaught exceptions plus console errors that name an app fault. */
  fatalErrors(): string[] {
    return [
      ...this.pageErrors,
      ...this.consoleErrors.filter((line) =>
        FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(line))
      ),
    ];
  }

  /** Console errors that mean the client tree disagreed with the prerender. */
  hydrationErrors(): string[] {
    return this.consoleErrors.filter((line) =>
      HYDRATION_ERROR_PATTERNS.some((pattern) => pattern.test(line))
    );
  }

  /** Count of requests per URL, for the request-budget assertion. */
  requestHistogram(): Map<string, number> {
    const histogram = new Map<string, number>();
    for (const request of this.requests) {
      if (!request.url.startsWith(BASE_URL)) continue;
      const key = `${request.method} ${request.url.replace(BASE_URL, "")}`;
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
    }
    return histogram;
  }

  /**
   * Highest number of times ONE url was requested inside any `windowMs` slice.
   * A dashboard route that re-issues the same GET 40 times in five seconds is
   * a defect whether or not it eventually renders, so this is measured
   * directly from the timestamps rather than inferred.
   */
  peakRepeats(windowMs: number): { key: string; count: number } {
    const byKey = new Map<string, number[]>();
    for (const request of this.requests) {
      if (!request.url.startsWith(BASE_URL)) continue;
      const key = `${request.method} ${request.url.replace(BASE_URL, "")}`;
      const list = byKey.get(key) ?? [];
      list.push(request.at);
      byKey.set(key, list);
    }
    let best = { key: "", count: 0 };
    for (const [key, times] of byKey) {
      for (let i = 0; i < times.length; i++) {
        let count = 0;
        for (let j = i; j < times.length && times[j] - times[i] <= windowMs; j++) count++;
        if (count > best.count) best = { key, count };
      }
    }
    return best;
  }

  dump(): Record<string, unknown> {
    return {
      url: this.page.url(),
      consoleErrors: this.consoleErrors.map(scrub),
      pageErrors: this.pageErrors.map(scrub),
      failedRequests: this.failures.map(scrub),
      non2xx: this.non2xx().map((r) => ({ status: r.status, url: scrub(r.url) })),
      requestHistogram: [...this.requestHistogram()].map(([k, n]) => `${n}x ${k}`),
    };
  }
}

/** Attach the admin key the way an ingress in front of the admin port would. */
export async function authenticate(context: BrowserContext, key = ADMIN_KEY): Promise<boolean> {
  if (!key) return false;
  await context.setExtraHTTPHeaders({ Authorization: `Bearer ${key}` });
  return true;
}

/**
 * Measure the app's content region: the innermost element that holds the most
 * text and is not itself inside the page chrome.
 *
 * A fixed selector is wrong here: this shell renders chrome (`header`, `nav`)
 * INSIDE a `<main>`, so `main` on the dashboard route measures 60 characters of
 * search box and breadcrumb while the page's actual content — 2 000+ characters
 * of it — sits outside the landmark. An assertion on `main` would then be an
 * assertion about a 60-character string.
 *
 * Deepest-among-ties is what gets the content column rather than the full-bleed
 * shell that also contains the sidebar; excluding `header`/`nav`/`aside`
 * subtrees is what keeps the sidebar and the toolbar out of the measurement.
 * This is a definition of "the content the operator is looking at", not a guess
 * about internals — which is also why it is written as a function and evaluated
 * in the page: the repo forbids `eval`, and a string-built script would be it.
 */
function measureContentRegion(): { text: string; length: number; region: string | null } {
  const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
  const CHROME = "header, nav, aside";
  const visibleText = (el: Element) =>
    ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();

  let best: { el: Element; size: number; depth: number } | null = null;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (SKIP.has(el.tagName) || el.closest(CHROME)) continue;
    const size = visibleText(el).length;
    if (size === 0) continue;
    let depth = 0;
    let node: Element | null = el;
    while (node) {
      node = node.parentElement;
      if (node) depth += 1;
    }
    if (!best || size > best.size || (size === best.size && depth > best.depth)) {
      best = { el, size, depth };
    }
  }
  const winner = best?.el;
  if (!best || !winner) return { text: "", length: 0, region: null };
  return {
    text: visibleText(winner),
    length: best.size,
    region: winner.tagName.toLowerCase() + (winner.id ? `#${winner.id}` : ""),
  };
}

/**
 * Read the content region until it has REAL CONTENT, and report how it got
 * there.
 *
 * These dashboard routes are `<Suspense fallback={null}>` shells, so "the
 * content region is empty" has two very different causes: still loading, or
 * broken. A fixed sleep cannot tell them apart and neither can a strict
 * stability check — a live dashboard keeps its own content changing (counters,
 * refresh stamps), so demanding the text hold still for seconds fails on pages
 * that are working perfectly.
 *
 * So the question asked is the answerable one: did real content arrive? The
 * length history comes back with it, which is what separates the two failures:
 * a region that climbs and keeps climbing is a shell still loading, and a
 * region flat at zero is a shell that rendered nothing. Both are failures, and
 * the message says which.
 */
export type ContentReading = {
  text: string;
  length: number;
  /** Which element was measured. */
  region: string | null;
  /** Real content is present. */
  loaded: boolean;
  /** The region was still climbing when the budget ran out. */
  stillGrowing: boolean;
  waitedMs: number;
  /** Sampled lengths, so a failure message can show the trajectory. */
  history: number[];
};

export async function readContent(
  page: Page,
  options: { timeoutMs?: number; minLength?: number; pollMs?: number } = {}
): Promise<ContentReading> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const minLength = options.minLength ?? 1;
  const pollMs = options.pollMs ?? 350;

  const started = Date.now();
  const history: number[] = [];
  let lastText = "";
  let lastRegion: string | null = null;

  while (Date.now() - started < timeoutMs) {
    const snapshot = await page
      // A rejected evaluate is not a null reading — it is a renderer that has
      // stopped answering. Surface it as such instead of polling a dead page.
      .evaluate(measureContentRegion)
      .catch(() => null);

    if (snapshot) {
      lastText = snapshot.text;
      lastRegion = snapshot.region;
      history.push(snapshot.length);
      if (snapshot.length >= minLength) {
        return {
          text: snapshot.text,
          length: snapshot.length,
          region: snapshot.region,
          loaded: true,
          stillGrowing: false,
          waitedMs: Date.now() - started,
          history,
        };
      }
    }
    await page.waitForTimeout(pollMs);
  }

  const first = history[0] ?? 0;
  const last = history[history.length - 1] ?? 0;
  return {
    text: lastText,
    length: last,
    region: lastRegion,
    loaded: false,
    // A region that is still climbing is a shell that has not finished; one
    // that never moved received nothing at all.
    stillGrowing: history.length > 2 && last > first,
    waitedMs: Date.now() - started,
    history,
  };
}

/**
 * A message that says WHICH kind of emptiness it was, from the trajectory.
 * Both are bugs, but they are different dispatches, and a reader of a CI log
 * should not have to guess.
 */
export function emptinessMessage(
  route: string,
  reading: ContentReading,
  minLength: number
): string {
  const head = reading.history.slice(0, 6).join(" → ");
  const tail = reading.history.slice(-6).join(" → ");
  const trajectory =
    reading.history.length > 12 ? `${head} … ${tail}` : reading.history.join(" → ");
  if (reading.stillGrowing) {
    return (
      `${route}: after ${Math.round(reading.waitedMs / 1000)}s the content region (${reading.region}) ` +
      `had only ${reading.length} characters (needed ${minLength}) and was still growing ` +
      `(${trajectory}) — a Suspense shell that never finished loading. The operator sees a page ` +
      "that never arrives."
    );
  }
  return (
    `${route}: after ${Math.round(reading.waitedMs / 1000)}s the content region (${reading.region}) ` +
    `held ${reading.length} characters (needed ${minLength}) and never grew (${trajectory}) — a ` +
    "shell that rendered nothing at all. This is not 'still loading': nothing ever arrived."
  );
}

/**
 * What the REAL gateway holds, read over HTTP with the same credential the
 * browser uses. This is the backend, not a stand-in for it — the point is to
 * assert the UI agrees with the server rather than with a hard-coded count.
 */
export type AdminSnapshot = {
  providerKeyCount: number;
  providerKeyNames: string[];
  reachable: boolean;
};

export async function readAdminSnapshot(): Promise<AdminSnapshot> {
  try {
    const response = await fetch(`${BASE_URL}/admin/v1/provider_keys`, {
      headers: ADMIN_KEY ? { Authorization: `Bearer ${ADMIN_KEY}` } : {},
    });
    if (!response.ok) return { providerKeyCount: -1, providerKeyNames: [], reachable: false };
    const body = (await response.json()) as Array<{ value?: { display_name?: string } }>;
    return {
      providerKeyCount: body.length,
      providerKeyNames: body.map((row) => row?.value?.display_name ?? "").filter(Boolean),
      reachable: true,
    };
  } catch {
    return { providerKeyCount: -1, providerKeyNames: [], reachable: false };
  }
}

/** The header control that opens the locale menu, located by what it renders. */
export function localeButton(page: Page) {
  return page
    .locator("header button")
    .filter({ has: page.locator('img[src*="flagcdn"]') })
    .first();
}

/** Scripts that carry a specific writing system, e.g. Han, Hiragana, Arabic. */
export const SCRIPT_PATTERNS = {
  han: /\p{Script=Han}/u,
  kana: /\p{Script=Hiragana}|\p{Script=Katakana}/u,
  arabic: /\p{Script=Arabic}/u,
  cyrillic: /\p{Script=Cyrillic}/u,
} as const;

export type WrittenScript = keyof typeof SCRIPT_PATTERNS;

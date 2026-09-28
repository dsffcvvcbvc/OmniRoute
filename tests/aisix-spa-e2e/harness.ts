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

// The admin key is optional, and the keyless run is a real, supported mode:
// the signed-out assertions are made without one on purpose. But it is a mode
// that changes what this suite can conclude, and it used to change it silently
// — `scrub()` shredded every evidence file when the key was unset, so the run
// that had least to go on also lost its record. So the state is stated once, out
// loud, at the moment it is decided.
if (!ADMIN_KEY) {
  console.warn(
    "[aisix-spa-e2e] AISIX_SPA_ADMIN_KEY is not set. Signed-in assertions (07, the C6 control) " +
      "will FAIL with instructions rather than skip, and evidence is still scrubbed of bearer " +
      "tokens and credential query parameters — there is simply no admin key in it to redact."
  );
}

const EVIDENCE_DIR = process.env.AISIX_SPA_EVIDENCE_DIR || "aisix-spa-evidence";

/**
 * Remove anything that could be a credential from a string about to be persisted.
 *
 * `key` is a parameter and not only the module constant, so that BOTH states —
 * key set and key unset — are reachable from one test process and the unset
 * case cannot rot unnoticed. It is not a corner: `AISIX_SPA_ADMIN_KEY` is
 * documented as optional, and `"abc".split("")` is `["a","b","c"]`, so an
 * unguarded `split(ADMIN_KEY)` interleaves the marker between every character
 * of every evidence file the run writes — destroying the only failure record
 * in precisely the keyless run, where the operator has least to go on.
 */
export function scrub(value: string, key: string = ADMIN_KEY): string {
  if (!value) return value;
  const withoutKey = key ? value.split(key).join("<admin-key>") : value;
  return withoutKey
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/g, "$1<redacted>")
    .replace(/([?&](?:key|api_key|apikey|token|secret|password)=)[^&\s]+/gi, "$1<redacted>");
}

export function evidencePath(name: string): string {
  return path.join(EVIDENCE_DIR, name);
}

/**
 * Write scrubbed evidence next to the test run.
 *
 * Never throws — a suite must not fail because a directory is not writable —
 * but it does not swallow the reason either: the run that needs its evidence
 * most is the red one, and a write that silently did not happen is
 * indistinguishable from one that did. The reason goes to stderr.
 */
export function writeEvidence(name: string, payload: unknown): void {
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(
      evidencePath(name),
      typeof payload === "string" ? scrub(payload) : scrub(JSON.stringify(payload, null, 2))
    );
  } catch (error) {
    console.error(`[harness] evidence ${name} was NOT written: ${String(error)}`);
  }
}

/**
 * The request-budget ceiling, stated once.
 *
 * It lives here and not in `08-request-budget.spec.ts` because the negative
 * control has to judge an INJECTED storm against the same number the
 * production assertion judges the real page against. A control that quotes its
 * own copy of the ceiling proves only that its own copy is what it is.
 */
export const REQUEST_BUDGET_WINDOW_MS = 5000;
export const MAX_REPEATS_PER_URL_PER_WINDOW = 5;

/**
 * The verdict `08-request-budget` is made of, extracted so a control can
 * require it to REJECT a storm. `peak.count <= 5` written twice, in two files,
 * is one assertion and a copy; this is one function and a control.
 */
export function isOverRequestBudget(
  peak: { key: string; count: number },
  max: number = MAX_REPEATS_PER_URL_PER_WINDOW
): boolean {
  return peak.count > max;
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
  /**
   * The response's own `content-type`, lowercased, or `""` when it sent none.
   * A status code cannot see a wrong content type: the RSC payloads the client
   * validates, and the fonts/images it trusts, all answer 2xx whether or not
   * they are what they claim to be.
   */
  contentType: string;
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
        contentType: (response.headers()["content-type"] ?? "").toLowerCase(),
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

/**
 * The ONE origin the admin key may be sent to: the origin the gateway's admin
 * plane answers on. Everything else the browser fetches — and the dashboard
 * does fetch third-party things, e.g. `CountryFlag` renders
 * `<img src="https://flagcdn.com/w40/us.png">` in the language selector the
 * header paints unconditionally — must go out with no credential.
 */
export function adminOrigin(): string {
  return new URL(BASE_URL).origin;
}

/**
 * Whether a request URL is the admin plane's own origin.
 *
 * Compared on the PARSED origin, never on a string prefix: `startsWith` on a
 * base URL would accept `http://127.0.0.1:3001.evil.example`, which is a
 * different origin an attacker could point anywhere.
 */
export function isAdminOrigin(url: string | URL): boolean {
  try {
    return new URL(String(url)).origin === adminOrigin();
  } catch {
    // Not a URL we can parse (a `data:`/`about:` frame, a relative form the
    // browser already resolved). It is certainly not the admin origin.
    return false;
  }
}

/**
 * Attach the admin key the way an ingress in front of the admin port would —
 * and ONLY to that ingress.
 *
 * It used to be `context.setExtraHTTPHeaders({ Authorization: … })`, which is
 * context-wide and origin-agnostic: Chromium attaches those headers to every
 * request the context issues, so a test that authenticated and then visited
 * any dashboard page handed the real gateway's admin key to
 * `https://flagcdn.com` in an `Authorization` header. Nothing in the suite
 * could see it — `PageWatch` records URLs, not headers, and `scrub()` only
 * cleans what the suite itself writes to disk — so running this against a real
 * gateway published that key to a public CDN with no signal that it happened.
 *
 * A route handler scoped to `isAdminOrigin` puts the header on the same
 * requests and no others, and it is the mechanism `context.route` already
 * gives us rather than a wrapper the callers would each have to remember:
 * every existing call site keeps working unchanged.
 *
 * Cost, stated because it is real: an intercepted request takes a round trip
 * through the Playwright driver, so admin-origin requests in a test that
 * authenticates are marginally slower. `08-request-budget.spec.ts` measures
 * timings and deliberately never calls `authenticate`, so it is unaffected.
 */
export async function authenticate(context: BrowserContext, key = ADMIN_KEY): Promise<boolean> {
  if (!key) return false;
  await context.route(
    (url) => isAdminOrigin(url),
    async (route) => {
      await route.continue({
        headers: { ...route.request().headers(), Authorization: `Bearer ${key}` },
      });
    }
  );
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

/**
 * What the REAL gateway's native catalog holds, read over HTTP with the same
 * credential the browser uses.
 *
 * The point is the same as `readAdminSnapshot`: a UI assertion about "the model
 * catalog is populated" is worthless if the count is written into the test. The
 * comparison is made against what the core actually returns, so an empty page
 * with an empty gateway passes and an empty page with a populated gateway fails.
 */
export type NativeCatalogSnapshot = {
  reachable: boolean;
  modelCount: number;
  providers: string[];
  /** A provider that actually has models, for a per-provider cross-check. */
  sampleProvider: string | null;
  sampleModelId: string | null;
  sampleDisplayName: string | null;
};

export async function readNativeCatalog(): Promise<NativeCatalogSnapshot> {
  const empty: NativeCatalogSnapshot = {
    reachable: false,
    modelCount: 0,
    providers: [],
    sampleProvider: null,
    sampleModelId: null,
    sampleDisplayName: null,
  };
  try {
    const response = await fetch(`${BASE_URL}/admin/v1/models`, {
      headers: ADMIN_KEY ? { Authorization: `Bearer ${ADMIN_KEY}` } : {},
    });
    if (!response.ok) return empty;
    const body = (await response.json()) as Array<{
      id?: string;
      value?: { provider?: string; model_name?: string; display_name?: string };
    }>;
    if (!Array.isArray(body)) return empty;
    const providers = new Set<string>();
    for (const row of body) {
      const provider = row?.value?.provider;
      if (typeof provider === "string" && provider.length > 0) providers.add(provider);
    }
    const first = body.find(
      (row) =>
        typeof row?.value?.provider === "string" && typeof row?.value?.model_name === "string"
    );
    return {
      reachable: true,
      modelCount: body.length,
      providers: [...providers].sort(),
      sampleProvider: first?.value?.provider ?? null,
      sampleModelId: first?.value?.model_name ?? null,
      sampleDisplayName: first?.value?.display_name ?? null,
    };
  } catch {
    return empty;
  }
}

/**
 * The gateway's ENTIRE `RuntimeStatus` vocabulary, as the state it means.
 *
 * Read off the core itself — `aisix-proxy/src/health.rs`, `RuntimeStatus` with
 * `#[serde(rename_all = "snake_case")]` — which is four tokens, and mirrored in
 * the dashboard's own `HEALTHY_STATES` / `DEGRADED_STATES` / `DOWN_STATES`
 * (`src/shared/utils/aisixHealth.ts`):
 *
 *   healthy           the model is in rotation and answering
 *   not_applicable    a VIRTUAL router — `kind: routing | ensemble |
 *                     semantic`, which is every combo, because a combo is a
 *                     routing model. It has no upstream of its own, so the core
 *                     reports no runtime health for it; the health that matters
 *                     lives on the direct models it dispatches to, which are in
 *                     the same payload. Not applicable is not a fault.
 *   cooldown          out of rotation until `cooldown_until`, expected to lapse
 *   unhealthy         the background check marked it; the core itself puts it
 *                     in `DeploymentState::Down` — out of rotation
 *
 * This is an ALLOW-list on purpose. The oracle used to deny-list three
 * spellings and count everything else as degraded, so `not_applicable` —
 * every virtual router, that is, every combo on the gateway — was counted as a
 * fault: the e2e oracle agreed with the exact bug it exists to catch. A
 * deny-list also fails in the direction that hides things: a token the gateway
 * adds tomorrow is counted as degraded by default. A token this table does not
 * know is therefore reported as `unrecognisedStatusTokens` and asserted empty
 * by the spec, rather than being folded into a count.
 *
 * Scope, stated exactly: this is the wire vocabulary of `GET :9090/status/models`
 * — the core's `RuntimeStatus` enum, whose four tokens are all here — plus the
 * handful of adjacent spellings this core family is known to emit
 * (`ok`, `degraded`, `half_open`, `down`, `unavailable`). It is deliberately
 * NOT the dashboard's whole `toAisixProviderState` vocabulary: that one accepts
 * `warn`, `open`, `error` and a dozen more, and every token it accepts that the
 * core cannot emit is a token this oracle would then have to call
 * "recognised" — which is the silence the allow-list exists to remove.
 *
 * The tokens are kept as literal strings rather than imported from
 * `aisixHealth.ts`. An oracle that imports the code under audit agrees with it
 * by construction, which is the failure mode this table replaces.
 */
// Exported so the unit test can hold it against an INDEPENDENTLY anchored
// list — the core's own four-token enum — rather than against itself.
export const RUNTIME_STATUS_STATES: Record<string, "healthy" | "degraded" | "down"> = {
  healthy: "healthy",
  ok: "healthy",
  not_applicable: "healthy",
  notapplicable: "healthy",
  cooldown: "degraded",
  degraded: "degraded",
  half_open: "degraded",
  unhealthy: "down",
  down: "down",
  unavailable: "down",
};

export type NativeModelStatusSummary = {
  modelCount: number;
  healthyCount: number;
  degradedCount: number;
  downCount: number;
  /** Every status token the payload carried, counted. */
  statusTokens: Record<string, number>;
  /**
   * Tokens this harness does not know. Not an error state on its own — it is
   * a vocabulary gap between the gateway and the dashboard, and it is loud:
   * the spec asserts this list is empty, because a token nobody classified is
   * one the operator is not being told about.
   */
  unrecognisedStatusTokens: string[];
};

/** Classify a `GET :9090/status/models` payload. Pure, so it is unit-tested. */
export function summarizeNativeModelStatus(body: unknown): NativeModelStatusSummary {
  const rows = Array.isArray(body) ? body : [];
  const summary: NativeModelStatusSummary = {
    modelCount: rows.length,
    healthyCount: 0,
    degradedCount: 0,
    downCount: 0,
    statusTokens: {},
    unrecognisedStatusTokens: [],
  };
  for (const row of rows) {
    const token = String((row as { status?: unknown })?.status ?? "")
      .trim()
      .toLowerCase();
    summary.statusTokens[token] = (summary.statusTokens[token] ?? 0) + 1;
    const state = RUNTIME_STATUS_STATES[token];
    if (state === "healthy") summary.healthyCount += 1;
    else if (state === "degraded") summary.degradedCount += 1;
    else if (state === "down") summary.downCount += 1;
    // A row with NO status token is not counted either way: the core omits it
    // for rows that predate the field, and inventing a fault there is how a
    // healthy gateway reads as a broken one.
    else if (token && !summary.unrecognisedStatusTokens.includes(token)) {
      summary.unrecognisedStatusTokens.push(token);
    }
  }
  return summary;
}

/**
 * What the REAL gateway's UNAUTHENTICATED health surface holds, read over HTTP.
 *
 * Deliberately the METRICS-plane `/status/models` and the root `/livez`, not the
 * admin plane: the two shell reads under test live on those planes precisely
 * because an admin-plane 401 flips the dashboard's global signed-out state, which
 * a header badge must not be able to do to a visitor carrying no admin key.
 */
export async function readNativeHealth(metricsPort = 9090): Promise<
  NativeModelStatusSummary & {
    statusModelsReachable: boolean;
    livezStatus: number | null;
  }
> {
  const result = {
    statusModelsReachable: false,
    livezStatus: null as number | null,
    ...summarizeNativeModelStatus([]),
  };
  const origin = new URL(BASE_URL);
  try {
    const status = await fetch(`http://${origin.hostname}:${metricsPort}/status/models`);
    if (status.ok) {
      const body = (await status.json()) as unknown;
      if (Array.isArray(body)) {
        result.statusModelsReachable = true;
        Object.assign(result, summarizeNativeModelStatus(body));
      }
    }
  } catch {
    // leave statusModelsReachable false — the assertion says so
  }
  try {
    const livez = await fetch(`${BASE_URL}/livez`);
    result.livezStatus = livez.status;
  } catch {
    // leave livezStatus null
  }
  return result;
}

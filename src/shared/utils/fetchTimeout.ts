/**
 * Fetch Timeout — T-25
 *
 * Wraps fetch() with an AbortController-based timeout.
 * Default timeout is 120 seconds (FETCH_TIMEOUT_MS env var).
 *
 * @module shared/utils/fetchTimeout
 */

const DEFAULT_TIMEOUT_MS =
  parseInt(process.env.OMNIROUTE_DEFAULT_FETCH_TIMEOUT_MS || "", 10) || 120000; // 2 minutes
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS;

interface FetchTimeoutOptions extends RequestInit {
  timeoutMs?: number;
  /** Alternative fetch function to use instead of globalThis.fetch.
   *  Pass getOriginalFetch() to bypass the proxy/TLS patch layer. */
  fetchFn?: typeof globalThis.fetch;
}

export async function fetchWithTimeout(url: string | URL, options: FetchTimeoutOptions = {}) {
  const {
    timeoutMs = FETCH_TIMEOUT_MS,
    signal: externalSignal,
    fetchFn,
    ...fetchOptions
  } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // If an external signal was provided, wire it to abort our controller too
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  try {
    const doFetch = fetchFn || globalThis.fetch;
    const response = await doFetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (error: any) {
    if (error.name === "AbortError") {
      throw new FetchTimeoutError(
        `Request to ${url} timed out after ${timeoutMs}ms`,
        timeoutMs,
        String(url)
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Error thrown on fetch timeout.
 */
export class FetchTimeoutError extends Error {
  timeoutMs: number;
  url: string;

  constructor(message: string, timeoutMs: number, url: string) {
    super(message);
    this.name = "FetchTimeoutError";
    this.timeoutMs = timeoutMs;
    this.url = url;
  }
}

/**
 * Get the configured timeout value.
 * @returns {number} Timeout in milliseconds
 */
export function getConfiguredTimeout() {
  return FETCH_TIMEOUT_MS;
}

/** Ceiling for dashboard backoff — a hidden/unreachable core must not wedge a tab at 15s forever. */
const MAX_POLL_BACKOFF_MS = 5 * 60_000;

/**
 * True when the tab is backgrounded. Dashboard pollers skip their tick while
 * hidden (the missed refresh simply happens on return) instead of hammering
 * an unreachable core from a tab nobody is watching.
 */
export function isDocumentHidden(): boolean {
  try {
    return typeof document !== "undefined" && document.hidden === true;
  } catch {
    return false;
  }
}

/**
 * Exponential backoff for dashboard polling against an unreachable core:
 * `baseMs * 2^consecutiveFailures`, capped at 5 minutes. `0` failures returns
 * the base interval unchanged, so healthy polling is untouched — only the
 * red path slows down.
 */
export function backoffPollDelayMs(baseMs: number, consecutiveFailures: number): number {
  const failures = Number.isFinite(consecutiveFailures)
    ? Math.max(0, Math.floor(consecutiveFailures))
    : 0;
  if (failures <= 0) return baseMs;
  return Math.min(MAX_POLL_BACKOFF_MS, baseMs * 2 ** Math.min(failures, 10));
}

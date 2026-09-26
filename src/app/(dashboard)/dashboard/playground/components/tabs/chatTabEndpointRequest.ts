// src/app/(dashboard)/dashboard/playground/components/tabs/chatTabEndpointRequest.ts
//
// #10592 — ChatTab.tsx hardcoded every "Send" click to POST /api/v1/chat/completions,
// ignoring configState.endpoint entirely. Selecting a search-only provider (exa-search,
// tavily-search, serper-search) in the Endpoint selector still sent a chat.completions
// request, which has no notion of search-provider credentials and 404s.
//
// This module gives ChatTab a small, testable seam for routing non-chat endpoints
// (currently "search" and "web.fetch") to their real path with a query-shaped body,
// instead of the chat.completions messages/SSE shape.

import { endpointToPath, type PlaygroundEndpoint } from "@/lib/playground/codeExport";
import { getAisixDataBase } from "@/shared/utils/aisixEndpoints";

/** Chat-shaped endpoints keep the existing messages[] + SSE-delta request/response flow. */
export function isChatCompletionsEndpoint(endpoint: PlaygroundEndpoint | undefined): boolean {
  return !endpoint || endpoint === "chat.completions";
}

/**
 * Resolves the absolute fetch URL (data plane `:3000`) for the selected Playground endpoint.
 *
 * CORS/auth contract: the native data plane is the operator's own OpenAI-compatible
 * server on their own host — it has no Next.js dashboard session, so the browser
 * MUST NOT send an implicit `Authorization: Bearer` or a same-origin cookie it
 * cannot attach cross-origin anyway. Routing is done by the core's configured
 * provider keys, with `X-OmniRoute-Connection` as the only per-request hint
 * (see ApiTab.tsx). Cross-origin reads therefore require the core to allow this
 * origin; a rejected preflight is reported via `coreUnreachableMessage`, never
 * as a generic network error (see `isCoreUnreachableError`).
 */
export function resolveChatTabRequestPath(endpoint: PlaygroundEndpoint | undefined): string {
  return `${getAisixDataBase()}${endpointToPath(endpoint ?? "chat.completions")}`;
}

/**
 * `true` for the failures a rejected CORS preflight (or a dead core) produces:
 * the browser surfaces them as a bare `TypeError: Failed to fetch` with no
 * status, no body, and no way to distinguish "core down" from "core refused
 * this origin" — so the UI must say exactly that instead of a generic
 * "Network error".
 */
export function isCoreUnreachableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  const message = String((err as { message?: unknown }).message ?? "");
  if (name === "AbortError") return false;
  return (
    name === "TypeError" ||
    /failed to fetch|networkerror|load failed|cors|preflight|network request failed/i.test(message)
  );
}

/**
 * Human-readable playground failure for an unreachable/CORS-blocked core.
 * Kept as a literal (not an i18n key): it interpolates the absolute core URL,
 * which catalogs cannot pre-translate, and names the two actionable causes.
 */
export function coreUnreachableMessage(url: string): string {
  return (
    `Core unreachable or CORS-blocked (${url}). ` +
    `Start the core and allow this origin; dashboard cookies are never sent cross-origin.`
  );
}

/**
 * Builds the request body for a non-chat endpoint from the user's free-text query.
 * "search" and "web.fetch" both take a single string field instead of a messages array.
 */
export function buildNonChatRequestBody(
  endpoint: PlaygroundEndpoint | undefined,
  query: string,
  model: string
): Record<string, unknown> {
  if (endpoint === "web.fetch") {
    return { url: query };
  }
  const body: Record<string, unknown> = { query };
  if (model) body.model = model;
  return body;
}

/** Renders a non-chat endpoint's raw response text as a chat-bubble-friendly string. */
export function formatNonChatResponse(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
  } catch {
    return rawText;
  }
}

/** Finds the most recent user-authored message content to use as a non-chat query. */
export function lastUserContent(chatMessages: Array<{ role: string; content: string }>): string {
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    if (chatMessages[i].role === "user") return chatMessages[i].content;
  }
  return "";
}

/**
 * providerPageStats — the per-card connection roll-up, extracted from
 * `providers/page.tsx`, which the file-size gate no longer allows to carry it.
 *
 * One function, `createProviderStatsReader`, closes over the three pieces of
 * page state the roll-up reads (the connection list, the expiration snapshot,
 * the global Codex service mode) plus the translator, and returns the
 * `(providerId, authType) => stats` function the page hands to
 * `buildStaticProviderEntries` for every catalogue section.
 *
 * It is a factory and not a plain function taking those four arguments on each
 * call because the page builds ~30 entry lists per render; re-filtering the
 * connection list per argument tuple is what this shape avoids, and it is the
 * shape the closure already had before the move.
 *
 * Nothing here reads or writes state: the same `(providerId, authType)` pair
 * yields the same object for as long as the three inputs are unchanged, which
 * is what the counts, the `—` rendering and the display-mode gate all rely on.
 */

import { getErrorCode, getRelativeTime } from "@/shared/utils";
import {
  isProviderConnectionConnected,
  isProviderConnectionErrored,
} from "@/shared/utils/providerConnectionStatus";
import {
  getCodexEffectiveServiceTier,
  type CodexGlobalServiceMode,
} from "@/lib/providers/codexFastTier";
import { connectionMatchesProviderCard } from "./providerPageUtils";
import { providerText, type ProviderMessageTranslator } from "./[id]/providerCredentialText";
/**
 * The one tag a connection's failure is shown under, derived from its most
 * specific available signal: the server's own `lastErrorType`, then a numeric
 * HTTP code, then a code scraped out of the message, then a keyword match on
 * the message. `"ERR"` is the honest floor — it says "something failed" and
 * claims nothing about what.
 */
export function getConnectionErrorTag(
  connection: { lastErrorType?: unknown; errorCode?: unknown; lastError?: unknown },
  t: ProviderMessageTranslator
) {
  if (!connection) return null;

  const explicitType = connection.lastErrorType;
  if (explicitType === "runtime_error") return providerText(t, "errorTypeRuntime", "Runtime");
  if (
    explicitType === "upstream_auth_error" ||
    explicitType === "auth_missing" ||
    explicitType === "token_refresh_failed" ||
    explicitType === "token_expired"
  ) {
    return providerText(t, "errorTypeUpstreamAuth", "Auth");
  }
  if (explicitType === "upstream_rate_limited") {
    return providerText(t, "errorTypeRateLimited", "Rate limited");
  }
  if (explicitType === "upstream_unavailable") {
    return providerText(t, "errorTypeUpstreamUnavailable", "Server error");
  }
  if (explicitType === "network_error") {
    return providerText(t, "errorTypeNetworkError", "Network");
  }

  const numericCode = Number(connection.errorCode);
  if (Number.isFinite(numericCode) && numericCode >= 400) {
    return String(numericCode);
  }

  const fromMessage = getErrorCode(connection.lastError);
  if (fromMessage === "401" || fromMessage === "403") {
    return providerText(t, "errorTypeUpstreamAuth", "Auth");
  }
  if (fromMessage && fromMessage !== "ERR") return fromMessage;

  const msg = (connection.lastError || "").toLowerCase();
  if (msg.includes("runtime") || msg.includes("not runnable") || msg.includes("not installed"))
    return providerText(t, "errorTypeRuntime", "Runtime");
  if (
    msg.includes("invalid api key") ||
    msg.includes("token invalid") ||
    msg.includes("revoked") ||
    msg.includes("unauthorized")
  )
    return providerText(t, "errorTypeUpstreamAuth", "Auth");

  return "ERR";
}

/**
 * The page state the roll-up reads. Passed in rather than imported so this
 * module stays a pure function of its arguments and the page keeps sole
 * ownership of when a re-read happens.
 */
export interface ProviderStatsSources {
  connections: Array<Record<string, unknown>>;
  expirations: { list?: Array<{ provider?: string; status?: string }> } | null;
  codexGlobalServiceMode: CodexGlobalServiceMode;
  t: ProviderMessageTranslator;
}

export function createProviderStatsReader({
  connections,
  expirations,
  codexGlobalServiceMode,
  t,
}: ProviderStatsSources) {
  return (providerId: string, authType: "oauth" | "free" | "apikey") => {
    const providerConnections = connections.filter((c) =>
      connectionMatchesProviderCard(c, providerId, authType)
    );

    const connected = providerConnections.filter((connection) =>
      isProviderConnectionConnected(connection)
    ).length;

    const errorConns = providerConnections.filter((connection) =>
      isProviderConnectionErrored(connection)
    );

    const error = errorConns.length;
    const total = providerConnections.length;

    // Check if all connections are manually disabled
    const allDisabled = total > 0 && providerConnections.every((c) => c.isActive === false);

    // Get latest error info
    const latestError = errorConns.sort(
      (a: any, b: any) =>
        (new Date(b.lastErrorAt || 0) as any) - (new Date(a.lastErrorAt || 0) as any)
    )[0];
    const errorCode = latestError ? getConnectionErrorTag(latestError, t) : null;
    const errorTime = latestError?.lastErrorAt ? getRelativeTime(latestError.lastErrorAt) : null;

    // Check expirations
    const providerExpirations =
      expirations?.list?.filter((e: any) => e.provider === providerId) || [];
    const hasExpired = providerExpirations.some((e: any) => e.status === "expired");
    const hasExpiringSoon = providerExpirations.some((e: any) => e.status === "expiring_soon");
    let expiryStatus = null;
    if (hasExpired) expiryStatus = "expired";
    else if (hasExpiringSoon) expiryStatus = "expiring_soon";

    const codexConnectionServiceTiers = [
      ...new Set(
        providerConnections
          .map((connection) =>
            getCodexEffectiveServiceTier(connection.providerSpecificData, "none")
          )
          .filter((tier) => tier !== "default")
      ),
    ];
    const codexServiceTier =
      providerId === "codex"
        ? codexGlobalServiceMode !== "none"
          ? codexGlobalServiceMode
          : codexConnectionServiceTiers.length === 1
            ? codexConnectionServiceTiers[0]
            : null
        : null;

    // Count API keys in "warning" state across all connections, and (#10261)
    // aggregate a SANITIZED reasons summary (max failure count + most recent
    // failure time — never the raw upstream error text) so the warning badge
    // can expose why connections are flagged instead of a bare count.
    let warningMaxFailures = 0;
    let warningLatestFailureAt: string | null = null;
    const warning = providerConnections.reduce((warnCount, conn) => {
      const health = (conn as any).providerSpecificData?.apiKeyHealth as
        | Record<string, { status: string; failures?: number; lastFailure?: string | null }>
        | undefined;
      if (!health) return warnCount;
      const warningEntries = Object.values(health).filter((h) => h.status === "warning");
      for (const entry of warningEntries) {
        warningMaxFailures = Math.max(warningMaxFailures, entry.failures ?? 0);
        if (
          entry.lastFailure &&
          (!warningLatestFailureAt || entry.lastFailure > warningLatestFailureAt)
        ) {
          warningLatestFailureAt = entry.lastFailure;
        }
      }
      return warnCount + warningEntries.length;
    }, 0);
    const warningLastFailureRelative = warningLatestFailureAt
      ? getRelativeTime(warningLatestFailureAt)
      : null;

    return {
      connected,
      error,
      warning,
      warningMaxFailures,
      warningLastFailureRelative,
      total,
      errorCode,
      errorTime,
      allDisabled,
      expiryStatus,
      codexServiceTier,
    };
  };
}

"use client";

// Groups the provider detail page's "extra" sections — playground + param
// filters — behind a single import/render call from ProviderDetailPageClient.tsx.
// Extracted so the frozen host file stays within the file-size ratchet
// (#6649 review follow-up: keeps ProviderDetailPageClient.tsx at its ≤784 cap).

import ProviderPlaygroundPanel from "./ProviderPlaygroundPanel";
import ProviderParamFilterSection from "./ProviderParamFilterSection";
import ProviderInterceptionSection from "./ProviderInterceptionSection";
import ProviderCcAliasSection from "./ProviderCcAliasSection";
import { useTranslations } from "next-intl";
import { resolveAisixSurfaceSupport } from "@/shared/utils/aisixEndpoints";
import { providerText, type ProviderMessageTranslator } from "../providerPageHelpers";

/**
 * The three request-shaping cards are ONE capability, not three.
 *
 * `ProviderParamFilterSection`, `ProviderInterceptionSection` and
 * `ProviderCcAliasSection` each read one per-provider SQLite row through a
 * Next.js-only route: `/api/providers/{id}/param-filters`,
 * `/interception-rules` and `/cc-alias`. The AISIX core has no resource type
 * for any of them, so on a static host all three reads are guaranteed 404s.
 *
 * The gate is HERE, at the composition point, rather than inside the three
 * sections. That placement is deliberate and is the reason this file exists as
 * a separate concern:
 *
 *   - the refusal is ONE card carrying ONE reason, instead of three skeletons
 *     that each resolve to "loaded, nothing configured". That resolution would
 *     be a fabricated answer: the operator may well have filters configured in
 *     a Next.js deployment of the same account, and "empty form" is not the
 *     same claim as "this gateway cannot hold filters";
 *   - nothing is fetched at all, so no card can enter a 404-driven state
 *     machine in the first place;
 *   - the three sections keep their own effects untouched, so this gate shares
 *     no file with any retry/backoff handling inside them.
 *
 * `modelCompatOverrides` is deliberately NOT gated: it is read from the model
 * catalog, which IS a native resource (see `aisixNativeCatalog.ts`).
 */
export default function ProviderExtraPanels({ providerId }: { providerId: string }) {
  const t = useTranslations("providers") as ProviderMessageTranslator;
  const extrasSupport = resolveAisixSurfaceSupport("providerExtras", "read");
  const text = (key: string, fallback: string) => providerText(t, key, fallback);

  return (
    <>
      {/* Playground panel — rendered for providers that declare serviceKinds */}
      <ProviderPlaygroundPanel providerId={providerId} />

      {extrasSupport.supported ? (
        <>
          {/* Param filters — denylist/allowlist config per provider/model (#6625) */}
          <ProviderParamFilterSection providerId={providerId} />

          {/* Web search/fetch tool interception toggles (#3384/#7339) */}
          <ProviderInterceptionSection providerId={providerId} />

          {/* Claude Code discovery-alias gate — provider/model on/off/inherit */}
          <ProviderCcAliasSection providerId={providerId} />
        </>
      ) : (
        <section
          className="rounded-xl border border-dashed border-border bg-white p-5 dark:bg-zinc-950"
          data-testid="provider-extras-unsupported"
          data-unsupported="providerExtras"
          role="status"
        >
          <h2 className="flex items-center gap-2 text-base font-semibold text-text-main">
            <span
              className="material-symbols-outlined text-[18px] text-text-muted"
              aria-hidden="true"
            >
              cloud_off
            </span>
            {text(
              "providerExtrasUnsupportedTitle",
              "Request shaping, tool interception and Claude Code aliases"
            )}
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-text-muted">
            {text(
              "providerExtrasUnsupported",
              "The AISIX gateway does not carry these three per-provider settings, so this page " +
                "does not read them and no value below can be shown or changed."
            )}
          </p>
          <p
            className="mt-2 text-xs leading-relaxed text-text-muted"
            data-testid="provider-extras-reason"
          >
            {extrasSupport.reason}
          </p>
        </section>
      )}
    </>
  );
}

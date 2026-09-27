"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

import {
  filterActiveRadarOffers,
  localizeRadarOfferText,
  type RadarOffer,
  type RadarOfferBenefit,
} from "@/lib/radar/offersFeedSchema";
import { Card } from "@/shared/components";
import {
  fetchAisixJson,
  resolveAisixRequestUrl,
  resolveAisixSurfaceSupport,
} from "@/shared/utils/aisixEndpoints";

interface OffersMeta {
  version: string;
  tier: "live";
  fetchedAt: string;
}

interface SettingsPayload {
  hasSupporterKey?: boolean;
  contributorClaimUrl?: string;
  supporterPlansUrl?: string;
}

export default function RadarOffersPage() {
  const t = useTranslations("radarOffersPage");
  const locale = useLocale();
  const [offers, setOffers] = useState<RadarOffer[]>([]);
  const [meta, setMeta] = useState<OffersMeta | null>(null);
  const [hasSupporterKey, setHasSupporterKey] = useState(false);
  const [contributorClaimUrl, setContributorClaimUrl] = useState<string | null>(null);
  const [supporterPlansUrl, setSupporterPlansUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [flagOff, setFlagOff] = useState(false);
  const [error, setError] = useState("");
  // Partner offers are served from the Next.js-only Radar feed cache keyed by a
  // supporter key; the AISIX gateway has neither the feed nor the key store.
  const offersRead = resolveAisixSurfaceSupport("radar", "read");
  const offersWrite = resolveAisixSurfaceSupport("radar", "write");
  const offersSupported = offersRead.supported;

  const loadOffers = useCallback(async () => {
    if (!offersSupported) return;
    const result = await fetchAisixJson(resolveAisixRequestUrl("/api/radar/offers"));
    if (result.missing) {
      setFlagOff(true);
      return;
    }
    if (!result.ok) throw new Error(result.error || "offers_load_failed");
    const body = (result.data ?? {}) as { offers?: RadarOffer[]; meta?: OffersMeta | null };
    setOffers(Array.isArray(body.offers) ? body.offers : []);
    setMeta(body.meta ?? null);
  }, [offersSupported]);

  const syncAndLoad = useCallback(async () => {
    if (!offersWrite.supported) {
      setError(offersWrite.reason);
      return;
    }
    setRefreshing(true);
    setError("");
    try {
      const result = await fetchAisixJson(resolveAisixRequestUrl("/api/radar/offers/sync"), {
        method: "POST",
      });
      if (result.missing) {
        setFlagOff(true);
        return;
      }
      if (!result.ok) {
        // Preserve availability: even when the refresh fails, render the last
        // verified local cache rather than clearing it.
        setError(result.error || t("loadFailed"));
        try {
          await loadOffers();
        } catch {
          // The primary error already explains the failed local read.
        }
        return;
      }
      const status = (result.data ?? {}) as { status?: string; reason?: string };
      if (status.status === "no_key") {
        setHasSupporterKey(false);
        return;
      }
      if (
        status.status === "error" ||
        status.status === "invalid_signature" ||
        status.status === "invalid_schema" ||
        status.status === "wrong_tier" ||
        status.status === "too_large"
      ) {
        setError(t("loadFailed"));
      }
      await loadOffers();
    } finally {
      setRefreshing(false);
    }
  }, [loadOffers, t, offersWrite.supported, offersWrite.reason]);

  useEffect(() => {
    async function load(): Promise<void> {
      if (!offersSupported) {
        setLoading(false);
        return;
      }
      const result = await fetchAisixJson(resolveAisixRequestUrl("/api/radar/settings"));
      if (result.missing) {
        setFlagOff(true);
        return;
      }
      if (!result.ok) {
        setError(result.error || t("loadFailed"));
        return;
      }
      const settings = (result.data ?? {}) as SettingsPayload;
      const hasKey = settings.hasSupporterKey === true;
      setHasSupporterKey(hasKey);
      setContributorClaimUrl(
        typeof settings.contributorClaimUrl === "string" ? settings.contributorClaimUrl : null
      );
      setSupporterPlansUrl(
        typeof settings.supporterPlansUrl === "string" ? settings.supporterPlansUrl : null
      );
      if (hasKey) await syncAndLoad();
    }
    void load().finally(() => setLoading(false));
  }, [syncAndLoad, t, offersSupported]);

  const activeOffers = useMemo(() => filterActiveRadarOffers(offers, new Date()), [offers]);

  const formatBenefit = useCallback(
    (benefit: RadarOfferBenefit): string => {
      if (benefit.kind === "percent_off") {
        return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
          benefit.basisPoints / 100
        )}%`;
      }
      if (benefit.kind === "credit") {
        return new Intl.NumberFormat(locale, {
          style: "currency",
          currency: benefit.currency,
        }).format(benefit.amountMinor / 100);
      }
      return t("trialDays", { days: benefit.days });
    },
    [locale, t]
  );

  if (flagOff) notFound();

  if (!offersSupported) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <Link
            href="/dashboard/radar"
            className="text-sm text-text-muted hover:text-text-main transition-colors w-fit"
          >
            ← {t("backToRadar")}
          </Link>
          <div>
            <h1 className="text-2xl font-bold">{t("title")}</h1>
            <p className="text-sm text-text-muted mt-1">{t("subtitle")}</p>
          </div>
        </div>
        <div
          role="status"
          data-testid="radar-offers-unavailable"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-200"
        >
          {offersRead.reason}
        </div>
        <Card>
          <p className="py-8 text-center text-text-muted">{t("empty")}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link
          href="/dashboard/radar"
          className="text-sm text-text-muted hover:text-text-main transition-colors w-fit"
        >
          ← {t("backToRadar")}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{t("title")}</h1>
            <p className="text-sm text-text-muted mt-1">{t("subtitle")}</p>
          </div>
          {hasSupporterKey && (
            <button
              type="button"
              onClick={() => void syncAndLoad()}
              disabled={refreshing || !offersWrite.supported}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-violet-500 text-violet-400 hover:bg-violet-500/10 transition-colors disabled:opacity-50"
            >
              {refreshing ? t("refreshing") : t("refresh")}
            </button>
          )}
        </div>
      </div>

      {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}

      {loading ? (
        <div className="flex min-h-48 items-center justify-center text-text-muted">
          {t("loading")}
        </div>
      ) : !hasSupporterKey ? (
        <Card>
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <span className="material-symbols-outlined text-4xl text-violet-400">redeem</span>
            <h2 className="text-xl font-semibold">{t("keyRequiredTitle")}</h2>
            <p className="max-w-xl text-text-muted">{t("keyRequiredDescription")}</p>
            <div className="flex flex-col sm:flex-row gap-3">
              {contributorClaimUrl && (
                <a
                  href={contributorClaimUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 rounded-lg border border-violet-500 text-violet-400 hover:bg-violet-500/10"
                >
                  {t("contributorButton")}
                </a>
              )}
              {supporterPlansUrl && (
                <a
                  href={supporterPlansUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 rounded-lg bg-violet-500 text-white hover:bg-violet-600"
                >
                  {t("supporterButton")}
                </a>
              )}
            </div>
          </div>
        </Card>
      ) : activeOffers.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-text-muted">{t("empty")}</p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {activeOffers.map((offer) => (
            <Card key={`${offer.provider}:${offer.id}`}>
              <div className="flex h-full flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-text-muted">
                      {offer.provider}
                    </p>
                    <h2 className="text-lg font-semibold">
                      {localizeRadarOfferText(offer.title, locale)}
                    </h2>
                  </div>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-medium ${
                      offer.partner
                        ? "bg-violet-500/15 text-violet-300"
                        : "bg-green-500/15 text-green-300"
                    }`}
                  >
                    {offer.partner ? t("partnerBadge") : t("officialBadge")}
                  </span>
                </div>

                <p className="text-2xl font-bold text-violet-300">{formatBenefit(offer.benefit)}</p>
                <p className="text-sm text-text-muted">
                  {localizeRadarOfferText(offer.description, locale)}
                </p>
                <div className="text-sm">
                  <span className="font-medium">{t("conditionsLabel")}</span>{" "}
                  <span className="text-text-muted">
                    {localizeRadarOfferText(offer.conditions, locale)}
                  </span>
                </div>
                <p className="text-xs text-text-muted">
                  {offer.validUntil
                    ? t("validUntil", {
                        date: new Date(offer.validUntil).toLocaleDateString(locale),
                      })
                    : t("noExpiry")}
                </p>
                <a
                  href={offer.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-auto inline-flex w-fit items-center gap-1 text-sm font-medium text-violet-400 hover:underline"
                >
                  {t("openOffer")}
                  <span className="material-symbols-outlined text-sm">open_in_new</span>
                </a>
              </div>
            </Card>
          ))}
        </div>
      )}

      {meta && (
        <p className="text-xs text-text-muted">
          {meta.version} · {new Date(meta.fetchedAt).toLocaleString(locale)}
        </p>
      )}
    </div>
  );
}

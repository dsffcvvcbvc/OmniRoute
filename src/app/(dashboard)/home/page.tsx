import { getMachineId } from "@/shared/utils/machine";
import { loadHomeSettings } from "./loadHomeSettings";
import CoreStateBadge from "./CoreStateBadge";
import HomePageClient from "../dashboard/HomePageClient";
import BootstrapBanner from "../dashboard/BootstrapBanner";
import KimiSponsorBanner from "../dashboard/KimiSponsorBanner";
import CheaperInferenceSponsorBanner from "../dashboard/CheaperInferenceSponsorBanner";
import VscodeCopilotBanner from "../dashboard/VscodeCopilotBanner";
import NewsBanner from "../dashboard/NewsBanner";
import FirstRunReadinessCard from "../dashboard/FirstRunReadinessCard";

// AGENT.md §3.3: SPA static export — no force-dynamic (prerenderable, data via /admin/v1/* fetch with defaults fallback).
export default async function HomePage() {
  // Settings failures degrade to "unknown" here (display-only) — see loadHomeSettings (#14060).
  const [settings, machineId] = await Promise.all([loadHomeSettings(), getMachineId()]);
  const isBootstrapped = process.env.OMNIROUTE_BOOTSTRAPPED === "true";
  // The first-run nag shows ONLY on an explicit `false`. `"unknown"` (core
  // unreachable) hides it without claiming the setup is complete — and renders
  // the amber badge below so "unknown" never looks like setup-complete.
  const setupComplete = settings.setupComplete !== false;
  const coreUnknown = settings.setupComplete === "unknown";
  return (
    <>
      {isBootstrapped && <BootstrapBanner />}
      {coreUnknown ? <CoreStateBadge /> : null}
      <FirstRunReadinessCard setupComplete={setupComplete} />
      <KimiSponsorBanner />
      <CheaperInferenceSponsorBanner />
      <VscodeCopilotBanner />
      <NewsBanner />
      <HomePageClient machineId={machineId} />
    </>
  );
}

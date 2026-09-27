"use client";

import { Suspense } from "react";
import CostOverviewTab from "./CostOverviewTab";

// AGENT.md §3.3: `CostOverviewTab` reads `useSearchParams()` (range / groupBy /
// apiKeyIds), which cannot be prerendered for `output: "export"` without a
// Suspense boundary above it. `fallback={null}` keeps the static shell empty —
// the tab is a client-rendered data view and has no meaningful server markup.
export default function CostsPage() {
  return (
    <Suspense fallback={null}>
      <CostOverviewTab />
    </Suspense>
  );
}

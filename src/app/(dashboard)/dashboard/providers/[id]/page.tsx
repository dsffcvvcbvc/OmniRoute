import { Suspense } from "react";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import ProviderDetailPageClient from "./ProviderDetailPageClient";

// Thin route wrapper — all logic lives in ProviderDetailPageClient (Issue #3501,
// Phase 0 of the strangler-fig decomposition of this 12.8K-LOC god-component).
// The client reads the route id itself via useParams(), so no props are threaded.
//
// AGENT.md §3.3: the client calls both useParams() and useSearchParams(), which
// need a Suspense boundary above them for `output: "export"`. The page itself
// is a server component with no server-rendered markup to fall back to.
//
// The dynamic segment needs the second half of that contract as well:
// `output: "export"` hard-fails on a dynamic route with no
// `generateStaticParams()` (Next E1452) and, at the export phase, on a page
// declared `force-dynamic` (there is no runtime server to render it). The
// honest list exists here: `AI_PROVIDERS` is the build-time provider catalog
// and every id in it is a page the live server really serves, so prerendering
// one shell per provider is accurate — no placeholders, no real id missing.
export function generateStaticParams() {
  return Object.values(AI_PROVIDERS).map((provider) => ({ id: provider.id }));
}

export default function ProviderDetailPage() {
  return (
    <Suspense fallback={null}>
      <ProviderDetailPageClient />
    </Suspense>
  );
}

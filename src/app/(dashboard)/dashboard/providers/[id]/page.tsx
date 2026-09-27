import { Suspense } from "react";
import ProviderDetailPageClient from "./ProviderDetailPageClient";

// Thin route wrapper — all logic lives in ProviderDetailPageClient (Issue #3501,
// Phase 0 of the strangler-fig decomposition of this 12.8K-LOC god-component).
// The client reads the route id itself via useParams(), so no props are threaded.
//
// AGENT.md §3.3: the client calls both useParams() and useSearchParams(), which
// need a Suspense boundary above them for `output: "export"`. The page itself
// is a server component with no server-rendered markup to fall back to.
//
// `dynamic = "force-dynamic"` states the second half of the same truth: the
// provider id is resolved entirely at runtime, so this deep link has no
// build-time representation — `output: "export"` rejects a dynamic segment
// with no `generateStaticParams()` (Next E1452), and a placeholder list would
// emit one shell per placeholder and 404 every real id. The
// `output: "standalone"` build, which is what actually serves this route, is
// unaffected.
export const dynamic = "force-dynamic";

export default function ProviderDetailPage() {
  return (
    <Suspense fallback={null}>
      <ProviderDetailPageClient />
    </Suspense>
  );
}

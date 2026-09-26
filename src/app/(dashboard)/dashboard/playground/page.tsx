// src/app/(dashboard)/dashboard/playground/page.tsx
// Server component shell — delegates to PlaygroundStudio client component.

import { Suspense } from "react";
import { PlaygroundStudio } from "./PlaygroundStudio";

// AGENT.md §3.3: SPA static export — no force-dynamic.
export default function PlaygroundPage() {
  return (
    <Suspense fallback={null}>
      <PlaygroundStudio />
    </Suspense>
  );
}

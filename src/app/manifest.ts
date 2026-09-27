import type { MetadataRoute } from "next";

/**
 * AGENT.md §3.3: `output: "export"` throws E301 ("export const dynamic =
 * "force-static"/export const revalidate not configured on route
 * /manifest.webmanifest") for a metadata route that is not static-gen enabled.
 *
 * `app/manifest.ts` is compiled by `next-metadata-route-loader` into a Route
 * Handler (`GET /manifest.webmanifest`). The loader re-exports every named
 * export of this file except `default`, so this config reaches the route
 * module and satisfies the export gate.
 *
 * It is also simply true: the manifest below is a compile-time constant — it
 * reads no request, no database and no environment. The Web App Manifest is a
 * static discovery document by specification.
 */
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OmniRoute AI 网关",
    short_name: "OmniRoute",
    description: "OmniRoute 是一个面向多提供者 LLM 的 AI 网关。一个端点连接您所有的 AI 提供者。",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0b0f1a",
    theme_color: "#0b0f1a",
    categories: ["developer-tools", "productivity", "utilities"],
    lang: "en",
    dir: "ltr",
    prefer_related_applications: false,
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
    screenshots: [
      {
        src: "/screenshots/dashboard.png",
        sizes: "1280x720",
        type: "image/png",
        form_factor: "wide",
        label: "OmniRoute Dashboard",
      },
    ],
  };
}

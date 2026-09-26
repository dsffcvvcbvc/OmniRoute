/**
 * AGENT.md v2.0 Law 5 Case B: 1proxy (free-pool) отсутствует в Rust-ядре.
 * Страница-заглушка: бесплатные proxy-пулы не поддерживаются декларативным resources.yaml.
 * Актуальный Proxy — /dashboard/system/proxy.
 */
export default function OneProxyPage() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center p-8">
      <div className="rounded-xl border border-cyan-500/40 bg-cyan-900/20 p-8 text-center max-w-md w-full space-y-4">
        <h1 className="text-lg font-semibold text-cyan-200">1proxy недоступен в AISIX</h1>
        <p className="text-sm text-cyan-300/80">
          Free-пул вырезан (Law 5 Case B): шлюз использует статичные Provider Keys из
          resources.yaml.
        </p>
        <a
          href="/dashboard/system/proxy"
          className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 px-4 py-2 text-sm font-medium hover:bg-cyan-500/30 transition-colors"
        >
          Открыть Proxy
        </a>
      </div>
    </div>
  );
}

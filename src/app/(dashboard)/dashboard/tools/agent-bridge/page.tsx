import Link from "next/link";

/**
 * AGENT.md v2.0 Law 5 Case B: Agent Bridge отсутствует в Rust-ядре.
 * Заглушка вместо MITM-менеджера/DNS/сертификатов: подключения настраиваются
 * через declarative resources.yaml и POST /admin/v1/resources (Hot-Reload).
 */
export default function AgentBridgePage() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center p-8">
      <div className="rounded-xl border border-violet-500/40 bg-violet-900/20 p-8 text-center max-w-md w-full space-y-4">
        <h1 className="text-lg font-semibold text-violet-200">Agent Bridge недоступен в AISIX</h1>
        <p className="text-sm text-violet-300/80">
          MITM-мост вырезан (Law 5 Case B). Провайдеры — /dashboard/providers, ключи — POST
          /admin/v1/resources, статус — :9090/status/models.
        </p>
        <Link
          href="/dashboard/providers"
          className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500/20 text-violet-200 px-4 py-2 text-sm font-medium hover:bg-violet-500/30 transition-colors"
        >
          Открыть Провайдеры
        </Link>
      </div>
    </div>
  );
}

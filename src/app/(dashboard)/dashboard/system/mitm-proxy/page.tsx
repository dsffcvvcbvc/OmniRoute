/**
 * AGENT.md v2.0 Law 5 Case B: MITM-proxy отсутствует в Rust-ядре AISIX.
 * Локальный MITM-перехват (node-pty, сертификаты, DNS-правки) вырезан чисто —
 * шлюз работает как прямой proxy на :3000, состояние — :9090/status/models.
 */
export default function MitmProxyPage() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center p-8">
      <div className="rounded-xl border border-amber-500/40 bg-amber-900/20 p-8 text-center max-w-md w-full space-y-4">
        <h1 className="text-lg font-semibold text-amber-200">MITM-proxy недоступен в AISIX</h1>
        <p className="text-sm text-amber-300/80">
          Локальный перехват трафика вырезан (Law 5 Case B): в нативном бинаре нет Node MITM-стека.
          Используйте прямой Data Plane :3000 и Cooldown-статус :9090/status/models.
        </p>
        <a
          href="/dashboard/activity"
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/20 text-amber-200 px-4 py-2 text-sm font-medium hover:bg-amber-500/30 transition-colors"
        >
          Открыть Активность
        </a>
      </div>
    </div>
  );
}

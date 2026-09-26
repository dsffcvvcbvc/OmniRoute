/**
 * AGENT.md v2.0 Law 5 Case B: Traffic Inspector отсутствует в Rust-ядре.
 * Заглушка вместо node-pty/MITM-буфера: живой трафик смотрите в Activity и /metrics.
 */
export default function TrafficInspectorPage() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center p-8">
      <div className="rounded-xl border border-slate-500/40 bg-slate-900/40 p-8 text-center max-w-md w-full space-y-4">
        <h1 className="text-lg font-semibold text-slate-100">
          Traffic Inspector недоступен в AISIX
        </h1>
        <p className="text-sm text-slate-400">
          Перехват и WS-стрим вырезаны (Law 5 Case B). Активность — /dashboard/activity, метрики —
          :9090/metrics, Cooldown — :9090/status/models.
        </p>
        <a
          href="/dashboard/activity"
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-500/20 text-slate-200 px-4 py-2 text-sm font-medium hover:bg-slate-500/30 transition-colors"
        >
          Открыть Активность
        </a>
      </div>
    </div>
  );
}

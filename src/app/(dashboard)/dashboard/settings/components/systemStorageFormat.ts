// Byte/relative-time formatting for the storage settings surface. Shared by the
// tab and the backup list panel, which both render these figures.

type TranslateFn = (key: string, values?: Record<string, unknown>) => string;

export const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const formatRelativeTime = (isoString: string | null, t: TranslateFn): string | null => {
  if (!isoString) return null;
  const now = new Date();
  const then = new Date(isoString);
  const diffMs = now.getTime() - then.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t("justNow");
  if (diffMin < 60) return t("minutesAgo", { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("hoursAgo", { count: diffHr });
  const diffDays = Math.floor(diffHr / 24);
  return t("daysAgo", { count: diffDays });
};

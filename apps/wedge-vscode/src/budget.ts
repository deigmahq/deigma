// The wedge's resource budget (CLAUDE.md: <= 2 % CPU, <= 300 MB RAM).
//
// The guard is not decoration: when the extension host exceeds the budget the collector stops
// doing work and says so (`wedge.status` kind `paused`, error_code `budget_exceeded`) instead of
// quietly costing the user their laptop. It resumes by itself once usage falls back.

export const MAX_AVG_CPU_PERCENT = 2;
export const MAX_RSS_BYTES = 300 * 1024 * 1024;
/** Window over which the CPU average is taken: a single Kc computation is allowed to spike. */
export const CPU_WINDOW_MS = 60_000;
/** Below this much wall clock a CPU *average* means nothing: two saves 50 ms apart would show
 *  ~100 % and pause a wedge that is doing exactly what it should. RSS is judged immediately. */
export const MIN_CPU_WINDOW_MS = 10_000;

export type ResourceSample = { cpuMicros: number; rssBytes: number; atMs: number };

/** Default sampler: this process' own CPU time and RSS. Injected in tests. */
export function processSampler(): ResourceSample {
  const cpu = process.cpuUsage();
  return {
    cpuMicros: cpu.user + cpu.system,
    rssBytes: process.memoryUsage().rss,
    atMs: Date.now(),
  };
}

export type BudgetVerdict = {
  withinBudget: boolean;
  avgCpuPercent: number;
  rssBytes: number;
  reason?: "cpu" | "rss";
};

export class BudgetGuard {
  private first: ResourceSample | null = null;
  private last: ResourceSample | null = null;

  constructor(private readonly sampler: () => ResourceSample = processSampler) {}

  check(): BudgetVerdict {
    const now = this.sampler();
    if (!this.first || now.atMs - this.first.atMs > CPU_WINDOW_MS) this.first = this.last ?? now;
    this.last = now;
    const elapsedMs = now.atMs - this.first.atMs;
    const cpuMs = (now.cpuMicros - this.first.cpuMicros) / 1000;
    const avgCpuPercent = elapsedMs > 0 ? (cpuMs / elapsedMs) * 100 : 0;
    if (now.rssBytes > MAX_RSS_BYTES) {
      return { withinBudget: false, avgCpuPercent, rssBytes: now.rssBytes, reason: "rss" };
    }
    if (elapsedMs >= MIN_CPU_WINDOW_MS && avgCpuPercent > MAX_AVG_CPU_PERCENT) {
      return { withinBudget: false, avgCpuPercent, rssBytes: now.rssBytes, reason: "cpu" };
    }
    return { withinBudget: true, avgCpuPercent, rssBytes: now.rssBytes };
  }
}

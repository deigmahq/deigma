// The Kc compute ladder (collector §9). Kc is the draft -> final similarity: 1.0 means the draft
// was accepted untouched, 0.0 means it was replaced entirely.
//
// Rules the ladder exists to enforce:
//   * scope is the draft region (plus a little context), never the whole file — a large file must
//     not change the number and must not cost the CPU budget;
//   * token-level Myers O(nd) first; a structural (AST) level is reserved for the Tree-sitter WASM
//     build; a linear fallback catches oversized regions and timeouts;
//   * every level tags its own `kc_algo_version`: values from different levels are NOT comparable
//     (deferred modules §2 — Kc thresholds are calibrated per algorithm version);
//   * computed on accept/save only: this module exposes no incremental/keystroke entry point.

export const KC_ALGO = {
  /** Token-level Myers diff over the draft region. Default level. */
  myersToken: "myers-token-1.0",
  /** Structural comparison (Tree-sitter WASM). Ships with the extension that bundles the grammar. */
  treeSitter: "tree-sitter-1.0",
  /** Line-level ratio: oversized regions and timeouts. Cheap, coarse, never silently mixed in. */
  linearFallback: "linear-fallback-1.0",
} as const;

export type KcAlgoVersion = (typeof KC_ALGO)[keyof typeof KC_ALGO];

/** Above this many lines the region is not diffed token-wise (collector §9: > 2000 lines). */
export const KC_MAX_REGION_LINES = 2000;
/** Wall-clock budget for one computation; exceeding it drops to the linear fallback. */
export const KC_DEFAULT_BUDGET_MS = 250;

export type KcInput = {
  /** The AI draft as it was proposed. */
  draft: string;
  /** The text as it was saved/accepted. */
  final: string;
  /** Optional full file, used only to prove that scope is the region (never diffed as a whole). */
  fileText?: string | undefined;
  /** Line where the draft region starts inside `fileText`. */
  regionStartLine?: number | undefined;
  budgetMs?: number | undefined;
  /** Force a level (tests and the extension that bundles Tree-sitter). */
  algo?: KcAlgoVersion | undefined;
};

export type KcResult = {
  value: number;
  algoVersion: KcAlgoVersion;
  scope: "draft_region";
  regionLines: number;
  fallbackReason?: "region_too_large" | "timeout";
};

function tokenize(text: string): string[] {
  return text.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|\S/g) ?? [];
}

/** Length of the longest common subsequence, Myers O(nd) over tokens. Returns null on budget. */
function lcsMyers(a: string[], b: string[], deadline: number): number | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  const max = n + m;
  const v = new Int32Array(2 * max + 1);
  const offset = max;
  for (let d = 0; d <= max; d += 1) {
    if (d % 32 === 0 && Date.now() > deadline) return null;
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        // d = number of inserts + deletes; the rest of the tokens are common
        return (n + m - d) / 2;
      }
    }
  }
  return 0;
}

/** Line-level similarity: the coarse fallback. */
function linearRatio(a: string, b: string): number {
  const al = a.split("\n");
  const bl = b.split("\n");
  const counts = new Map<string, number>();
  for (const line of al) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of bl) {
    const left = counts.get(line) ?? 0;
    if (left > 0) {
      counts.set(line, left - 1);
      common += 1;
    }
  }
  const total = al.length + bl.length;
  return total === 0 ? 1 : (2 * common) / total;
}

/**
 * Kc for one accepted/saved draft. Pure and synchronous: the caller (IDE extension) invokes it on
 * accept/save, and nothing here touches the disk, the network or the editor.
 */
export function computeKc(input: KcInput): KcResult {
  const { draft, final } = input;
  const regionLines = Math.max(draft.split("\n").length, final.split("\n").length);
  const scope = "draft_region" as const;

  if (draft === final) {
    return { value: 1, algoVersion: input.algo ?? KC_ALGO.myersToken, scope, regionLines };
  }
  if (draft.length === 0 || final.length === 0) {
    return { value: 0, algoVersion: input.algo ?? KC_ALGO.myersToken, scope, regionLines };
  }
  if (regionLines > KC_MAX_REGION_LINES) {
    return {
      value: round(linearRatio(draft, final)),
      algoVersion: KC_ALGO.linearFallback,
      scope,
      regionLines,
      fallbackReason: "region_too_large",
    };
  }

  const budget = input.budgetMs ?? KC_DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budget;
  const a = tokenize(draft);
  const b = tokenize(final);
  const lcs = budget <= 0 ? null : lcsMyers(a, b, deadline);
  if (lcs === null) {
    return {
      value: round(linearRatio(draft, final)),
      algoVersion: KC_ALGO.linearFallback,
      scope,
      regionLines,
      fallbackReason: "timeout",
    };
  }
  return {
    value: round((2 * lcs) / (a.length + b.length)),
    algoVersion: input.algo ?? KC_ALGO.myersToken,
    scope,
    regionLines,
  };
}

function round(x: number): number {
  return Math.min(1, Math.max(0, Math.round(x * 1e6) / 1e6));
}

/** Measures one computation, so the budget can be asserted in tests and reported by the wedge. */
export function kcBudget<T>(fn: () => T): { result: T; ms: number } {
  const started = Date.now();
  const result = fn();
  return { result, ms: Date.now() - started };
}

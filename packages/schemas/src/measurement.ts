/**
 * Measurement constants that TypeScript must agree with the data plane about.
 *
 * The data plane's measurement configuration and its scoring configuration (`ScoringConfig`) are the
 * SOURCE: that is where a definition two services must agree on lives, and it is what reaches
 * `config_hash`. TypeScript cannot import Python, so this file is a MIRROR — and a mirror nobody
 * checks is two definitions. A drift test in the monorepo reads the Python files and fails when the
 * values part company.
 *
 * This exists because of a number on a card. The acceptance document said "18 of the 30 sessions
 * it needs" while the engine's floor was 10: the card renders `progress.need` from the snapshot
 * and was therefore honest, but the fixture behind the document invented a threshold the product
 * does not have — so the document stated a number nothing could produce. One of the two was
 * false, and which one hardly matters next to the fact that there were two.
 */

/**
 * What ends a session (B4.1).
 *
 * The unit the session facts and habits are counted in, so the two sources of sessions (the live
 * MCP proxy and the local-log backfill) must use one rule.
 *
 * Four hours, and the table is the argument — measured on 45 days of real transcripts, see the
 * data plane's measurement configuration. Taking a transcript file at face value gives 7 sessions at a 17.6-hour
 * median and never reaches the floor of 10. Every idle gap reaches it in about four weeks, so the
 * choice is not about speed: four hours is the widest gap that still produces sessions of a
 * plausible length (88-minute median, against 267 at eight hours where a "session" has swallowed
 * a day).
 */
export const SESSION_IDLE_GAP_HOURS = 4.0;

/**
 * The publication rule of decisions by others (Core 7 §3.3) — `r_min_observations`,
 * `r_ci90_max` and `r_expected_observations` in `ScoringConfig`. The onboarding screen and the
 * collecting card say them out loud before and beside any snapshot, so they are read from here and
 * held against the Python by the drift test, never typed beside the copy.
 */
export const DECISIONS_RULE = {
  /** Floor of observations: below it no number at all, not even for the owner. */
  min_observations: 5,
  /** Proven when the 90 % interval is no wider than this, as a share. */
  ci90_max: 0.3,
  /** The card's promise below the floor: the sweep's 90th percentile of PRs it takes. */
  expected_observations: 45,
} as const;

/**
 * The publication rule of the practice index (pi-1.0) —
 * `practice_min_occasions`, `practice_min_sessions`, `practice_preliminary_sessions` and
 * `practice_ci90_max` in `ScoringConfig`. The methodology page says them out loud, so they are
 * read from here and held against the Python by the drift test.
 */
export const PRACTICE_RULE = {
  /** A practice enters the index only with this many occasions. */
  min_occasions: 5,
  /** Sessions before a stranger sees the number. */
  min_sessions: 20,
  /** Sessions from which the owner sees a preliminary reading. */
  preliminary_sessions: 5,
  /** Published only when the 90 % interval is no wider than this many points. */
  ci90_max: 20,
  /** At most this many sessions a day count toward the index. */
  max_sessions_per_day: 12,
  /** pi-1.3: landings before a stranger sees the number when there are no sessions to count. */
  min_landings: 20,
  /** pi-1.3: landings from which the owner sees a preliminary reading. */
  preliminary_landings: 5,
  /** pi-1.3: at most this many landings a day count. */
  max_landings_per_day: 12,
  /** pi-1.3: `gh_small_changes` — a landing of at most this many changed lines is a small change. */
  small_change_lines: 400,
  /** pi-1.4: distinct days with counted work before a stranger sees the number. */
  min_days: 7,
  /** pi-1.5: practices with enough occasions before a stranger sees the number. */
  min_items: 4,
  /** pi-1.6: the cut points between the level words (Building / Solid / Strong / Expert). */
  level_bands: [30, 45, 60],
  /** pi-1.6: a weekly movement under this many points reads "No change this week". */
  delta_min: 2,
} as const;

/**
 * The horizons survival is counted at — `SURVIVAL_DAYS` in the data plane's `history` module,
 * mirrored and drift-checked like the rest of this file. The snapshot carries one entry per
 * horizon that something has reached.
 */
export const SURVIVAL_HORIZONS_DAYS = [14, 30, 90] as const;

// The card no longer quotes survival (founder, 2026-10-19): "what still stands" is History's.

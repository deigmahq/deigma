import { z } from "zod";

import { WorkArea } from "./vocabulary";
import { CarrierKind, CarrierRef, nonNegativeInt, OutcomeDefinitionVariant, rfc3339, uuid } from "./common";

// Episode = the unit of scoring (collector §5-7). Stored encrypted per user (C2); this schema is
// the body. One carrier -> one outcome observation; sub-episodes only aggregate process metrics.

export const SizeBucket = z.enum(["S", "M", "L"]);
// The task class names the carrier kind: a run of commits on main and a reviewed pull request
// are not the same task, and pooling them would put the difference into the person instead of
// into the work (6.1 §2.2, formula (2)). Adding a kind is a classifier version change — cls-3.0.
export const CarrierType = CarrierKind;
export const EpisodeStatus = z.enum(["open", "provisional", "final"]);
export type EpisodeStatus = z.infer<typeof EpisodeStatus>;

/**
 * The mode of working is a property of the EPISODE, not of the person (Engine Core 6.1 §2.1),
 * and it is derived from the envelopes of the wedge events bound to the carrier — never chosen
 * by a human (that is one of the three conditions formula (12) stands on):
 *
 *   assist        only draft.curation events — the person writes, the model suggests
 *   delegate      session.summary present, tool_calls < κ — the agent works, the person directs
 *   orchestrate   session.summary present, tool_calls ≥ κ — several agents run under one person
 *   unattributed  no wedge events bound to the carrier at all
 *
 * κ is configuration calibrated on the first population (§16 lists it as an open decision);
 * until it is calibrated, delegate and orchestrate are ONE category, labelled `delegate`. A
 * mixed episode belongs to the mode with the predominant event mass; a tie goes to the more
 * autonomous mode. No new field travels on the wire for this — it is computed from `source`,
 * `type` and `payload.tool_calls` that were already collected.
 */
export const EpisodeMode = z.enum(["assist", "delegate", "orchestrate", "unattributed"]);
export type EpisodeMode = z.infer<typeof EpisodeMode>;

export const TaskClass = z
  .strictObject({
    carrier_type: CarrierType,
    size_bucket: SizeBucket,
    domain: z.string().min(1),
    /** 4th dimension of the task class (6.1 §2.2, formula (2)). */
    mode: EpisodeMode,
    /** Deterministic key `<kind>:<bucket>:<domain>:<mode>` used by the scoring step. */
    key: z.string().min(1),
    classifier_version: z.string().min(1),
  })
  .meta({ id: "TaskClass", title: "TaskClass" });

/**
 * The outcome of an episode is an ORDERED CATEGORY, not a bit (Engine Core 6.1 §3, collector §6):
 *
 *   0 — did not land        revert ∨ CI failures after merge ∨ ≥ 3 rework cycles
 *   1 — landed the hard way merged with 2 review cycles, or after CI went red and then green
 *   2 — landed              merged with ≤ 1 review cycle, CI green
 *   3 — landed cleanly      merged with no rework cycles, CI green on the first pass
 *
 * Category ≥ 1 is exactly the old binary y = 1, and the model fixes the first threshold at
 * τ₁ = 0, so the published number keeps its definition; the higher categories only sharpen the
 * estimate of the same θ. Labels come from the carrier events that were already collected.
 */
/**
 * Who saw the work land (6.1 §12, R2). A property of the evidence, never a choice:
 *
 *   W2  a human other than the author AND automation — the whole scale is identified
 *   W1  automation only — "landed" and "landed cleanly" are one observation from outside
 *   W0  the author alone — it landed, and nothing else is known
 *   unknown  the records that would say are no longer available
 *
 * The fourth state exists because of a measurement, not a hunch. GitHub keeps check-runs for a
 * while and then stops: probed on 2026-09-05, a commit in vercel/next.js had 200 check-runs at
 * six months, 520 at a year and NONE at two years, while its recent commits had 702. Reading
 * that silence as W0 would be a lie in two directions at once — it would tell the person nobody
 * witnessed work that was in fact witnessed, and it would move their episode out of the claim
 * on the strength of a retention policy.
 *
 * "No CI records" and "no CI" are told apart at the REPOSITORY level, which the same probe
 * showed is enough: torvalds/linux has zero check-runs on its newest commits — that repository
 * genuinely runs none, so an old commit there is honestly W0 — while a repository whose recent
 * commits carry checks and whose old ones do not has simply lost the records.
 *
 * `unknown` is excluded from the outcome claim exactly like W0, and for a different reason that
 * the passport states: the evidence is missing rather than absent.
 *
 * W0 evidence stays out of the outcome claim until a pilot measures how often work fails
 * silently: fed as a category it cost 20-37 points of coverage at zero noise, and a 10 % rate of
 * hidden failures drops coverage of the truth to 80 % (T20, T20c). It still counts in History,
 * in volumes and in the descriptive panel — it is unpublishable, not invisible.
 */
export const WitnessLevel = z.enum(["W0", "W1", "W2", "unknown"]);
export type WitnessLevel = z.infer<typeof WitnessLevel>;

/**
 * What a carrier's record RESTS ON, in the words a passport may use (evidence class, 2026-10-10).
 *
 * The witness level answers "is the scale identified" for the model; this answers "who decided
 * that it landed" for a reader, and the two must not be confused. A pull request its author
 * merged in their own repository, with CI they configured, was presented as "third-party
 * evidence" — GitHub recorded it, but nobody other than the author decided anything. So:
 *
 *   accepted_by_other  an account other than the author's, not a bot, merged it
 *                      (`merged_by = another_person`) — said as "merged by another account",
 *                      because a second account of the same person, or a machine user GitHub
 *                      does not mark as a bot, reads the same: an account, not a person, is
 *                      what the record shows
 *   machine_checked    nobody else merged it; CI ran and/or the window saw no revert —
 *                      decided by machines, in a repository the person may configure (W1, W2)
 *   no_ci              no CI (W0) and the record does NOT show the author alone: a merger nobody
 *                      recorded (read before 2.5), a bot's merge, another person's review
 *                      without CI, a run of commits. "Not checked by CI" — nothing about solitude
 *   author_only        the author pressed merge, nobody else reviewed it, no CI: the one case
 *                      the record positively shows the author alone
 *   unknown            the records that would say are gone (witness `unknown`)
 *
 * A classification of the evidence that is already collected, never an input to a claim: no
 * gate, threshold or published number reads it (the claims keep reading the witness level). It
 * is computed in ONE place, in the data plane, and the snapshot counts it.
 */
export const EvidenceClass = z.enum([
  "accepted_by_other",
  "machine_checked",
  "no_ci",
  "author_only",
  "unknown",
]);
export type EvidenceClass = z.infer<typeof EvidenceClass>;

export const OutcomeCategory = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

/**
 * An outcome is an INTERVAL of categories, not always a single one (R9, engine 6.2).
 *
 * Evidence differs in how much it can tell apart. A reviewed pull request with CI says exactly
 * which category the work landed in. A run of commits with green CI and no reviewer says the
 * work landed and cannot distinguish "landed" from "landed cleanly" — that is (2, 3), and
 * feeding it to the model as a single category is not a rounding error: the simulation measured
 * coverage falling to 63–80 % at zero noise, and interval censoring restoring 91–93 %.
 *
 * `y_lo == y_hi` is the ordinary case and is exactly what every pull request produces, so the
 * numbers a passport already publishes do not move.
 */
export const Outcome = z
  .strictObject({
    /** Lowest category the evidence is consistent with. */
    y_lo: OutcomeCategory,
    /** Highest category the evidence is consistent with; equal to y_lo when the evidence decides. */
    y_hi: OutcomeCategory,
    decided_at: rfc3339,
    /** Which rule fired (collector §6), for the status journal and the UI. */
    reason: z.string().min(1),
  })
  .meta({ id: "Outcome", title: "Outcome" });

export const SubEpisode = z
  .strictObject({
    started_at: rfc3339,
    ended_at: rfc3339,
    n_events: nonNegativeInt,
    n_ai_events: nonNegativeInt,
  })
  .meta({ id: "SubEpisode", title: "SubEpisode" });

export const Episode = z
  .strictObject({
    episode_id: uuid,
    user_id: uuid,
    carrier: CarrierRef,
    /** `github:<repo_id>:pr:<number>` — deterministic, hashed for episode_id. */
    carrier_key: z.string().min(1),
    /** Who witnessed this episode's outcome (B1.6). */
    witness: WitnessLevel,
    /** What the record rests on, for a reader (see `EvidenceClass`). Optional because an episode
     *  segmented before 2.5 does not carry it; readers derive it from the same function then. */
    evidence_class: EvidenceClass.optional(),
    /** Cluster key for the power weight (collector §5): repository/project. */
    project_cluster_key: z.string().min(1),
    task_class: TaskClass,
    status: EpisodeStatus,
    opened_at: rfc3339,
    /** Carrier close (merge/close) — age reference for the freshness weight; null while open. */
    closed_at: rfc3339.nullable(),
    merged: z.boolean(),
    sub_episodes: z.array(SubEpisode).min(1),
    /** Null while the window is open, and also when the rules decide nothing (e.g. merged
     * without any CI signal): a carrier without an outcome observation, per collector §6. */
    provisional_outcome: Outcome.nullable(),
    final_outcome: Outcome.nullable(),
    /** Why there is no outcome yet / at all (rule name), for the UI and the status journal. */
    outcome_note: z.string().nullable(),
    /** When the final window closes (closed_at + 14 d for PRs); null while open. */
    window_final_at: rfc3339.nullable(),
    evidence: z
      .strictObject({
        /**
         * Where the knowledge of AI participation came from (6.2 §5.1, §17). THREE states, and
         * the third one is the point: `carrier_marked` means the carrier's own commits carry an
         * agent's trailer, so AI took part and HOW is unknown — no mode is assigned, but the
         * episode stops being unattributed for the descriptive panel.
         *
         * It read `"wedge" if n_ai > 0 else "none"`, so a marked episode with no wedge recorded
         * "no AI evidence" while the very next field listed the agents that marked it. The
         * three-way rule existed in `ai_markers.ai_attribution` and had no caller.
         */
        ai_evidence: z.enum(["none", "wedge", "carrier_marked"]),
        /** Agents that co-authored the work, read from the commit trailers themselves (R8).
         *  Independent of the wedge on purpose: the markers an agent writes are the first thing a
         *  person sees about AI, before anything is installed. Names, not a judgement — the
         *  passport says nothing about whether using an agent is good. */
        ai_agents: z.array(z.string().min(1)).default([]),
        n_carrier_events: nonNegativeInt,
        /** How many of those came from a historical backfill rather than live webhooks
         *  (6.1 §12). An episode whose whole history was reconstructed is flagged, so it can be
         *  excluded or down-weighted later without discarding anybody's past. */
        n_backfilled_events: nonNegativeInt,
        n_wedge_events: nonNegativeInt,
        ci_seen: z.boolean(),
        ci_passed: z.boolean(),
        ci_failed_after_merge: z.boolean(),
        /** CI runs that failed before the merge and were later green: the difference between
         *  "landed" and "landed the hard way" (6.1 §3). */
        ci_failures_before_merge: nonNegativeInt,
        changes_requested_cycles: nonNegativeInt,
        /** A review by somebody OTHER than the author. Approving your own work is not a
         *  witness (B1.6), and this is the fact the witness level is read from. */
        reviewed_by_other: z.boolean(),
        /** Who pressed merge, as the carrier's `merged` event recorded it (schema 2.5). Null when
         *  nothing merged, and when the merge was read before the merger was recorded — "not
         *  recorded" is its own state, never "the author". */
        merged_by: z.enum(["author", "another_person", "bot"]).nullable().default(null),
        /** Who closed it unmerged (schema 2.6); null when it merged, is open, or was not recorded. */
        closed_by: z.enum(["author", "another_person", "bot"]).nullable().default(null),
        /**
         * Core 7 §2: the decision another person made about this pull request, with the inputs the
         * context correction needs. Null on carriers that are not pull requests and on episodes
         * segmented before Core 7.
         */
        decision: z
          .strictObject({
            /** W1: 1 merged by another human (or by a bot after another human approved), 0 closed
             *  unmerged by another human, null when nobody but the author decided. */
            w1: z.union([z.literal(0), z.literal(1)]).nullable(),
            /** The first human other than the author who approved or requested changes. Kept in
             *  the encrypted body only, to look up that reviewer's deviation in the repo context. */
            first_reviewer_github_id: z.number().int().positive().nullable(),
            /** The author's n-th pull request in the repository; null when not counted. */
            author_ordinal: z.number().int().positive().nullable(),
            /** Calendar year (UTC) the pull request was opened — the repo-year of the correction. */
            opened_year: z.number().int().min(2000).max(2100),
          })
          .nullable()
          .default(null),
        reverted: z.boolean(),
        lines_changed: nonNegativeInt,
        /** Commits in a run of commits (pi-1.4 reads a run's change size per commit); null for a
         *  pull request and on runs segmented before it. */
        n_commits: nonNegativeInt.nullish(),
        /** What the work was about, in shares by kind of file and by language (B2.5). Present
         *  only where the carrier reports its paths; deliberately says nothing about WHEN
         *  somebody works, which is the line between this product and the surveillance it
         *  exists against. */
        descriptors: z
          .strictObject({
            version: z.string().min(1),
            n_files: nonNegativeInt,
            kinds: z.record(z.string(), z.number().min(0).max(1)),
            languages: z.record(z.string(), z.number().min(0).max(1)),
          })
          .nullish(),
        /**
         * Which of the closed vocabulary's areas of work (`AREAS` in vocabulary.ts) this carrier's
         * changed paths touch, sorted by the data plane under the rules named in `version`. Names of
         * areas only — never a path, a fragment of one or a count of files — and in the order of the
         * vocabulary.
         *
         * Migration note: optional, and the three states mean three things. Absent or null: the
         * paths were not read (an episode segmented before the rules existed, or a carrier that
         * reports no paths) — a consumer counts nothing for it, and a default would read as a
         * fact. `touched: []`: the paths WERE read and none of them touches an area. A list: the
         * areas, each once. Episode-only (the paths were already on the wire for revert
         * detection), so `SCHEMA_VERSION` does not move; the pipeline re-reads an episode's areas
         * the next time the user's history is re-segmented, and does so for everybody once per
         * version of the rules.
         */
        areas: z
          .strictObject({
            version: z.string().regex(/^areas-\d+\.\d+$/),
            touched: z.array(WorkArea),
          })
          .meta({ id: "EpisodeAreas", title: "EpisodeAreas" })
          .nullish(),
        /** Collector §5 minimum size: >= 3 AI interactions or >= 50 changed lines. Episodes below
         * it are kept for volumes/UI but never enter the scoring model. */
        min_size_ok: z.boolean(),
        /** §2.5 — the share of the lines this run wrote that were later written over, and the
         *  floor when the comparison could not be seen in full. Null means NOT MEASURED, which
         *  is neither zero nor a small number: survival (§11.4) counts only carriers where it is
         *  known, because reading "we did not look" as "nothing happened to it" is the
         *  flattering direction and the one every interval here exists to refuse. */
        rewrite_share: z.number().min(0).max(1).nullish(),
        rewrite_share_lower_bound: z.number().min(0).max(1).nullish(),
      })
      .meta({ id: "EpisodeEvidence", title: "EpisodeEvidence" }),
    /** Which definition of environment equipping this episode was segmented under. It changes a
     *  published number, so it is stamped per episode and a re-score under a different one has to
     *  say so — the same rule 6.1 §7 states for `n_categories`. */
    e_definition_version: z.enum(["E-1.0", "E-1.1"]),
    /** Which definition of a run's OUTCOME decided `provisional_outcome` / `final_outcome`
     *  (the data plane's OUTCOME_DEFINITION_VERSION). outcome-2.0 reads CI per check against the
     *  branch and measures rewriting on exact changed lines; the switch moves published numbers,
     *  so it is stamped per episode. Absent on episodes written before 2.3, which were decided
     *  under outcome-1.0. The VARIANT is stamped (review 2026-10-08 #4): an episode whose rewrite
     *  was measured on spans, or whose CI was read as one stream, says so. */
    outcome_definition_version: OutcomeDefinitionVariant.default("outcome-1.0"),
    updated_at: rfc3339,
  })
  .meta({ id: "Episode", title: "Episode" });
export type Episode = z.infer<typeof Episode>;

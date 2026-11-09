import { z } from "zod";

import { CarrierKind, nonNegativeInt, OutcomeDefinitionVariant, rfc3339, unitInterval, uuid } from "./common";
import { WorkArea } from "./vocabulary";
import { EpisodeMode, EvidenceClass, OutcomeCategory } from "./episode";
import { READER_VERSIONS } from "./events";
import { AGENTS } from "./agents";

// Snapshot = what the scoring service publishes about a passport (C2, encrypted per user).
// ARCH-2: no absolute theta / b anywhere in this schema — only ETS with intervals and gate
// diagnostics. ARCH-3: an ungated snapshot never carries fake numeric fields (nullable + status).
// ARCH-4: engine / classifier / E-definition versions, config hash and RNG seed are recorded.

/** Gate thresholds of Engine Core 6.1 §10, shared by the scoring service and the UI so a
 * recalibration never leaves a stale number on the screen. */
export const GATE1_MASS_MIN = 12;
export const GATE2_CI90_MAX_PP = 25;

export const PassportStatus = z.enum(["draft", "calibrating", "verified"]);
export type PassportStatus = z.infer<typeof PassportStatus>;

/** Shares by freshness mass. They sum to 1 up to the rounding applied for the wire (four
 *  decimals), and to nothing at all when there is no mass — an empty object, not zeroes. */
export const WitnessMix = z
  // partialRecord, not record: a composition lists the evidence that EXISTS. An exhaustive
  // record would force "W0: 0" onto every passport, and a zero here reads as a measurement of
  // nothing rather than as the absence of it.
  .partialRecord(z.enum(["W0", "W1", "W2", "unknown"]), z.number().min(0).max(1))
  .meta({ id: "WitnessMix", title: "WitnessMix" });

/** "N of M landings still stand after D days" (§11.4). */
export const SurvivalHorizon = z
  .strictObject({
    days: z.number().int().positive(),
    standing: nonNegativeInt,
    of: nonNegativeInt,
  })
  .meta({ id: "SurvivalHorizon", title: "SurvivalHorizon" });

export const EngineProvenance = z
  .strictObject({
    engine_version: z.string().min(1),
    classifier_version: z.string().min(1),
    /** Which definition of "decisions by others" scored this snapshot (Core 7 §3). A definition
     *  change moves published numbers, so it is recorded per snapshot — never a silent swap. */
    r_definition_version: z.literal("R-7.0"),
    /** sha256 of the population constants the claim was scored against
     *  (the claim's population constants). They are part of the definition. */
    population_digest: z.string().regex(/^[0-9a-f]{64}$/),
    /** Which definition of a run's outcome decided the observations this snapshot scored
     *  (the data plane's OUTCOME_DEFINITION_VERSION). Snapshots written before 2.3 were scored
     *  on outcome-1.0 observations and read as that. */
    outcome_definition_version: z.enum(["outcome-1.0", "outcome-2.0"]).default("outcome-1.0"),
    /** How many of the scored episodes each variant of the outcome definition decided, read off
     *  the episodes themselves (review 2026-10-08 #4): the configuration names the definition the
     *  pipeline runs, this says what the observations actually were — history decided under
     *  outcome-1.0 and not yet re-segmented, live runs measured on spans, suites read flat. Empty
     *  on snapshots written before it existed. */
    outcome_definition_mix: z.partialRecord(OutcomeDefinitionVariant, nonNegativeInt).default({}),
    /** Sessions in force by the reader that read them from a journal (`cc-reader-1`,
     *  `cc-reader-2`), or `live` (schema 2.5). A re-read replaces the older reading of the same
     *  transcript; a transcript the tool already deleted cannot be re-read and keeps its
     *  cc-reader-1 sessions — with the old, inflated count of typed turns — which is what this
     *  makes visible. Snapshot-only: no wire event changes. Empty on snapshots written before it.
     *  The keys are the wire's own reader versions plus `live`, derived rather than restated: a
     *  reader the wire accepts can never be one the snapshot cannot name. */
    reader_mix: z.partialRecord(z.enum([...READER_VERSIONS, "live"]), nonNegativeInt).default({}),
    config_hash: z.string().regex(/^[0-9a-f]{64}$/),
    /** The configuration itself, not only its digest (ARCH-4).
     *
     *  `config_hash` proves that two snapshots were scored under the same definitions and
     *  proves nothing about WHICH — a digest does not invert. So re-scoring a snapshot a month
     *  later reconstructed the configuration from whatever the modules happened to hold that
     *  day, and every parameter changed in between moved the number silently: the recomputation
     *  would even record a different hash, and the difference would read as a change in the
     *  person's work. Determinism is the requirement ARCH-4 states; a hash alone cannot meet it.
     *
     *  Values are numbers, strings, booleans, or arrays of those — the field is a record of what
     *  scored the passport, not a place to put structures. */
    config: z
      .record(
        z.string(),
        z.union([
          z.number(),
          z.string(),
          z.boolean(),
          z.null(),
          z.array(z.union([z.number(), z.string(), z.boolean()])),
        ]),
      )
      // Empty for snapshots written before the read-back existed. It has to be readable rather
      // than rejected — those rows are somebody's published passport — and `config_of_snapshot`
      // refuses to reproduce one, in those words, instead of quietly scoring it under today's
      // definitions.
      .default({}),
    rng_seed: nonNegativeInt,
    /** Digest of the observation set the population fit ran on (6.1 §14): the fit is
     * population-wide, so ARCH-4 reproducibility needs the data identity, not only the seed. */
    observations_digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .meta({ id: "EngineProvenance", title: "EngineProvenance" });

export const Interval = z
  .strictObject({ lo: unitInterval, hi: unitInterval })
  .meta({ id: "Interval", title: "Interval" });

/** A claim interval on the claim's own scale: shares live in [0,1], PtR is iterations. */
export const ValueInterval = z
  .strictObject({ lo: z.number().min(0), hi: z.number().min(0) })
  .meta({ id: "ValueInterval", title: "ValueInterval" });


export const WeekCell = z
  .strictObject({
    /** ISO date (Monday) of the week. */
    week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    episodes: nonNegativeInt,
    y1: nonNegativeInt,
    y0: nonNegativeInt,
    pending: nonNegativeInt,
  })
  .meta({ id: "WeekCell", title: "WeekCell" });

/** Engine Core 6.1 §8: the passport is a set of claims, and every claim has its own unit of
 * observation and its own publication threshold. The tiles it replaces were all computed per
 * episode and published as flat numbers. */
/**
 * One landing, as the timeline draws it (redesign §3: "a dot is a landing").
 *
 * The week ribbon that came before aggregated a person's six months into 26 bars, and a bar
 * cannot say that one of those landings was seventeen thousand lines and another was ninety. The
 * dot can: its radius is the size, its fill is whether an agent was in the loop, its ring is a
 * revert. Nothing here is a claim and nothing is gated — it is the work, counted.
 *
 * Two fields are nullable because two surfaces are not allowed to say the same things (§14.1).
 * `repository` is the owner's; a stranger was shown a passport, not the names of the
 * repositories somebody works in — usually an employer's. `reverted` is null on a public
 * surface until the outcome claim is proven: on a witnessed carrier a revert IS that claim's
 * numerator, element by element, and null says "not published here" where `false` would say
 * "nothing happened to it".
 */
export const Landing = z
  .strictObject({
    /** Index of the week inside the history window — 0 is the oldest week the window covers. */
    week: nonNegativeInt,
    /** Lines changed: what the radius reads. */
    lines: nonNegativeInt,
    /** An agent left a trace — the wedge's journals, or the carrier's own commit trailers. */
    ai: z.boolean(),
    /** Inside the outcome claim's witness rule (W1/W2): CI, or CI and a reviewer, saw it. NOT
     *  "seen by somebody other than its author" — W1 is automation only, in a repository the
     *  person may configure; `evidence` below says who actually decided. */
    witnessed: z.boolean(),
    /** True when a revert was seen, false when nothing was, null when this surface may not say. */
    reverted: z.boolean().nullable(),
    /** Owner surfaces only; null everywhere else. */
    repository: z.string().min(1).nullable(),
    // RD-19 contract — what the Timeline's fill and the reading screen need from a dot. Every
    // field below is OPTIONAL: a snapshot scored before RD-19 carries none of them, and a
    // consumer that finds one absent draws or prints nothing for it — never a default that would
    // read as a fact ("final" for a dot whose outcome nobody stated). Migration note: snapshot-
    // only, no wire event changes, so `SCHEMA_VERSION` (the event envelope's) does not move —
    // the same rule as `kind_counts` and `mode_counts`. The next scoring run writes them.
    /** The server carrier timestamp (merge / close), at DAY granularity, YYYY-MM-DD. Owner
     *  surfaces only: a per-day public trail reads as presence monitoring, so the public
     *  projection drops it and keeps `week`. Null while the carrier has not closed. */
    landed_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    /** What the carrier is: a pull request, a run of commits, a release. */
    kind: CarrierKind.optional(),
    /** The outcome window has closed (episode status `final`); false is "too recent to say",
     *  which the Timeline draws as a ring, not as a failure. */
    final: z.boolean().optional(),
    /** The mode of working the episode was assigned (6.1 §2.1, formula (1)) — never chosen by a
     *  human. Delegate and orchestrate are one category, `delegate`, until κ is calibrated. */
    mode: EpisodeMode.optional(),
    /** The graded outcome as the INTERVAL the evidence allows (6.1 §3): `y_lo == y_hi` when the
     *  evidence decides, a range when it does not — never a point picked inside the range. Null
     *  when no outcome was observed. Owner surfaces only; the public projection drops it. */
    grade: z
      .strictObject({ y_lo: OutcomeCategory, y_hi: OutcomeCategory })
      .nullable()
      .optional(),
    /** The pull request's number, carried by the episode's carrier ref. Null for a commit run or
     *  a release, which have no number. Owner surfaces only; the public projection drops it. */
    number: z.number().int().positive().nullable().optional(),
    /** What this landing's record rests on (`EvidenceClass`): merged by another account,
     *  machine-checked, not checked by CI, the author alone, or records gone. A fact about the work, nobody's
     *  numerator, so it travels to every surface. Optional: snapshots scored before 2.5 lack it
     *  and the dot then says nothing about it. */
    evidence: EvidenceClass.optional(),
  })
  .meta({ id: "Landing", title: "Landing" });
export type Landing = z.infer<typeof Landing>;

/** One week of the History ribbon (B3.1): carriers split by kind, and the volume behind them.
 * Descriptive, not a claim — no interval, no threshold, nothing gated. */
export const HistoryWeek = z.strictObject({
  week_start: z.string().min(10),
  pr: z.number().int().min(0),
  commit_run: z.number().int().min(0),
  release: z.number().int().min(0),
  episodes: z.number().int().min(0),
  lines_changed: z.number().int().min(0),
  /** Episodes that week carrying a trace of an agent — from the wedge or from the markers an
   * agent writes into the commit itself (R8). A share, never a verdict. */
  with_ai: z.number().int().min(0),
});

/** The descriptive history: what happened, as opposed to what it proves. Read by the History
 * page, which is required to keep it visually separate from the claims (B3.1). */
const DescriptorShare = z.strictObject({
  name: z.string().min(1),
  share: z.number().min(0).max(1),
  files: z.number().min(0),
});

/** B4.2: how somebody works with agents. Descriptive — nothing here is a claim, and the two
 *  claims that rest on sessions live in `claims` and appear only when proven. Tool names arrive
 *  already in the wire vocabulary (a built-in, or a salted hash), and the MCP figure is a COUNT
 *  rather than a list, because the names never leave the device. */
export const AgentsBlock = z.strictObject({
  weeks: z.array(
    z.strictObject({
      week_start: z.string().min(10),
      sessions: z.number().int().min(0),
      /** Observed live rather than read from a journal — the only kind the environment claim may
       *  count, since a backfilled E stamps today's configuration onto a months-old session. */
      live: z.number().int().min(0),
    }),
  ),
  n_sessions: z.number().int().min(0),
  n_live: z.number().int().min(0),
  tools: z.array(z.strictObject({ name: z.string().min(1), calls: z.number().int().min(0) })),
  mcp_tools_max: z.number().int().min(0),
  with_project_instructions: z.number().int().min(0),
  skill_calls: z.number().int().min(0),
  median_iterations: z.number().int().min(0),
  /** Turns the person typed in a session, as a median. Distinct from `median_iterations`, which
   *  counts the rounds the tool took: one is the person's asking, the other the machine's work,
   *  and only the first is ever an input to a claim (volume of use is not skill).
   *
   *  Defaulted for the same reason as `history.landings`: older snapshots stay readable. */
  median_prompts: z.number().int().min(0).default(0),
  /** Schema 2.10: the sessions by the agent they were read from — how many, and the day of the
   *  latest — in the fixed agent order, agents with no session left out (no "0 in Codex" for
   *  somebody who never used it). Counts the scorer made; the Sources card prints them. Empty on
   *  older snapshots. */
  by_agent: z
    .array(
      z.strictObject({
        agent: z.enum(AGENTS),
        n_sessions: z.number().int().min(0),
        last_session_at: z.string().min(10).nullable(),
      }),
    )
    .default([]),
});

/**
 * The version of the rules that sort a landing's changed files into areas of work. The Python
 * constant is the one the data plane stamps on every episode and on `history.domains`; this is its
 * mirror, and a drift test in the monorepo fails when the two differ. It is NOT part of
 * `ScoringConfig` and so not of any `config_hash`: the personal card does not read the areas.
 */
export const AREAS_RULES_VERSION = "areas-1.0";

/**
 * One area of work and what the person's landings in the history window say about it. Counts and
 * a week, nothing else: a level word, if a surface wants one, is derived from the counts where it
 * is read, so a threshold that moves does not need a re-score, and it is never stored here.
 *
 * `pieces` counts the landings — pull requests, runs of commits, releases — whose changed paths
 * touch the area. One landing can touch several areas, so the counts of different areas do not add
 * up to the number of landings, and a surface must not sum them. `checked_by_ci` is how many of
 * those pieces were seen by CI (witness W1 or W2: the rule the timeline's `witnessed` dot uses),
 * and `reverted` how many had a revert seen — a positive observation, as on the dots. Both are at
 * most `pieces`; a declarative schema cannot say so, and the scorer's test does.
 *
 * `last_week` is the Monday of the week the latest such piece OPENED — the bucket `history.weeks`
 * and the landings' `week` use, so it is always a week the timeline has. Never a day.
 */
export const HistoryDomainItem = z
  .strictObject({
    area: WorkArea,
    /** At least one: an area with no piece is left out of the list, not listed with a zero. */
    pieces: z.number().int().min(1),
    checked_by_ci: z.number().int().min(0),
    reverted: z.number().int().min(0),
    last_week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .meta({ id: "HistoryDomainItem", title: "HistoryDomainItem" });
export type HistoryDomainItem = z.infer<typeof HistoryDomainItem>;

/**
 * Where the person's work is, by the closed vocabulary of areas (`AREAS` in vocabulary.ts), counted
 * over the landings of the history window. OWNER-ONLY in the snapshot: it is not carried by
 * `measuredFactsFromSnapshot`, `publicFacts` or any public projection; it leaves the owner's hands
 * only on a share the person made themselves.
 *
 * `version` is the rules' version the counts were made under (`AREAS_RULES_VERSION`): counts are
 * comparable inside one version only, so it travels with them. `items` follow the order of `AREAS`
 * (never an order of counts — that would rank what a person does), and an area with no piece is
 * not in the list.
 */
export const HistoryDomains = z
  .strictObject({
    version: z.string().regex(/^areas-\d+\.\d+$/),
    items: z.array(HistoryDomainItem),
  })
  .meta({ id: "HistoryDomains", title: "HistoryDomains" });
export type HistoryDomains = z.infer<typeof HistoryDomains>;

export const HistoryBlock = z.strictObject({
  weeks: z.array(HistoryWeek),
  /** Every landing in the window, one entry each (redesign §3). The weekly cells above stay:
   *  they are what the outcome grid is bucketed by, and the two must agree about a week.
   *
   *  Defaulted, because a snapshot is a RECORD: the ones written before this field existed are
   *  not wrong and are not rewritten, and a reader that refused them would black out every
   *  passport until the next scoring run. Empty means "this snapshot predates the timeline", and
   *  the card draws no timeline at all rather than an empty axis that would read as "nothing
   *  landed". */
  landings: z.array(Landing).default([]),
  /** Episodes by witness level, as plain counts — the mass-weighted version lives in
   * `witness_mix`, and a person counting their own weeks should get the counting answer. */
  witness_counts: z.partialRecord(z.enum(["W0", "W1", "W2", "unknown"]), z.number().int().min(0)),
  /** Episodes whose CI conclusion GitHub no longer serves. Surfaced on its own because a missing
   * witness is not an absent one: this is not W0 and must never be shown as unwitnessed work. */
  witness_unknown: z.number().int().min(0),
  /** What the work was about, in shares weighted by files touched. Read from the descriptors on
   *  the evidence rather than from the task class, whose domain stays "unknown" for work no
   *  classifier ever saw — a real account read "unknown 100 %" while its files said TypeScript,
   *  Python and Markdown. */
  languages: z.array(DescriptorShare),
  kinds: z.array(DescriptorShare),
  /** Which agents left a trace, and in how many episodes. Named, never scored. */
  agents: z.array(
    z.strictObject({ agent: z.string().min(1), episodes: z.number().int().min(0) }),
  ),
  /** "measured on N repositories · M with review · K with CI" — counted in repositories, because
   * the sentence is about where the work was witnessed. */
  context: z.strictObject({
    repositories: z.number().int().min(0),
    with_review: z.number().int().min(0),
    with_ci: z.number().int().min(0),
  }),
  /** What the witness rule leaves out of the outcome claim, and where it sits. The page states
   *  it instead of telling anybody to install anything: "CI runs in 2 of your 3 repositories;
   *  the 20 runs from the third are here, but nobody witnessed them". Every number is measured —
   *  `excluded_mass` is the freshness weight those episodes already carry, on the curve the gate
   *  uses — because a screen that promised a future number would be claiming something about
   *  work that has not happened. */
  witness_gap: z.strictObject({
    excluded_episodes: z.number().int().min(0),
    excluded_mass: z.number().min(0),
    repositories: z.number().int().min(0),
    repositories_without_ci: z.number().int().min(0),
    excluded_in_repositories_without_ci: z.number().int().min(0),
  }),
  /** Episodes by carrier kind, as COUNTS. `carrier_mix` on the snapshot is the same composition
   *  by freshness mass, which is the right answer to "what is your recent work made of" and the
   *  wrong thing to multiply by a headcount — see `withAi` in measuredFactsFromSnapshot. */
  kind_counts: z.record(z.string(), z.number().int().min(0)).default({}),
  /** Landings by the mode of working the episode was assigned (6.1 §2.1, formula (1)), as
   *  COUNTS that add up to `n_episodes` (RD-15a). A wedge's Settings row reads "behind N
   *  landings" from here — never `round(ai_attribution_mix.wedge * n)`, a freshness-mass share
   *  times a headcount (see `kind_counts`). Delegate and orchestrate are one category, reported
   *  as `delegate`, until κ is calibrated; `orchestrate` appears only after that.
   *  Migration note: optional, because a snapshot scored before RD-15a does not carry it. Absent
   *  means "not counted", and a consumer prints nothing rather than a zero or an estimate; the
   *  next scoring run writes it. Snapshot-only: no wire event changes, so `SCHEMA_VERSION` (the
   *  event envelope's contract) does not move. */
  mode_counts: z
    .strictObject({
      assist: z.number().int().min(0),
      delegate: z.number().int().min(0),
      orchestrate: z.number().int().min(0).optional(),
      unattributed: z.number().int().min(0),
    })
    .optional(),
  n_with_ai: z.number().int().min(0),
  n_episodes: z.number().int().min(0),
  /** Episodes by what their record rests on (`EvidenceClass`), as COUNTS that add up to
   *  `n_episodes` — the counting answer beside `witness_mix`'s mass, same rule as `kind_counts`.
   *  "38 results · 6 merged by another account · 32 machine-checked" is printed from here and
   *  from nowhere else. Every key is present, zeros included, once the field is written.
   *  Migration: absent on snapshots scored before 2.5; a consumer prints nothing then, never a
   *  zero (a zero would say nobody else accepted any of the work, which nobody measured). */
  evidence_counts: z
    .strictObject({
      accepted_by_other: z.number().int().min(0),
      machine_checked: z.number().int().min(0),
      no_ci: z.number().int().min(0),
      author_only: z.number().int().min(0),
      unknown: z.number().int().min(0),
    })
    .optional(),
  /** Merged pull requests whose merger was not recorded (read before schema 2.5). They count as
   *  `machine_checked` / `no_ci` above — never `author_only`: a lower bound on acceptance, never
   *  a statement that the author merged them, and this says how loose that bound is (surfaces
   *  print the acceptance count as "at least N" while it is non-zero). Absent before 2.5. */
  merger_unrecorded: z.number().int().min(0).optional(),
  /**
   * Where the work is, by area: see `HistoryDomains`. Owner-only.
   *
   * Migration note: optional, and ABSENT — never defaulted to an empty list — on a snapshot scored
   * before the areas were read, and on one whose landings carry no readable paths. An empty `items`
   * would say "no area" about a person nobody has looked at; absent says "not read", and a consumer
   * prints nothing or says so in words. Snapshot-only: no wire event changes, so `SCHEMA_VERSION`
   * (the event envelope's contract) does not move, and the next scoring run writes it once the
   * pipeline has re-read the history's episodes (`evidence.areas`, episode.ts).
   */
  domains: HistoryDomains.optional(),
  /**
   * The Security panel (B5.2). Descriptive, and about REPOSITORIES.
   *
   * The distinction this block exists to keep is the one a security number destroys fastest.
   * "This repository runs no scanning" is a fact about the repository — nobody switched CodeQL on
   * — and the person working there has not been measured. "Three alerts were raised on your
   * commits" is a fact about the work. Neither of them is a verdict, and the shape says so: no
   * ratio of the person, no score, no nudge. Somebody usually cannot enable scanning in an
   * employer's repository, and a passport that scolded them for it would be measuring the
   * employer.
   *
   * `collected: false` is a third state again — the collector has not run for this person — and
   * is not "no scanning" and not "no alerts".
   */
  security: z
    .discriminatedUnion("collected", [
      z.strictObject({ collected: z.literal(false) }),
      z.strictObject({
        collected: z.literal(true),
        /** Both numbers travel: "4 of 9 scanned" is a fact, "4 scanned" invites the reader to
         *  supply a denominator of their own. */
        repositories_total: z.number().int().min(0),
        repositories_scanned: z.number().int().min(0),
        alerts_open: z.number().int().min(0),
        alerts_fixed: z.number().int().min(0),
        /** Kept apart from fixed on purpose: a dismissal is a decision not to act. */
        alerts_dismissed: z.number().int().min(0),
        open_high_or_critical: z.number().int().min(0),
        /** Secrets: the count and nothing else. Not which, not where, not what for. */
        secrets_found: z.number().int().min(0),
        secrets_open: z.number().int().min(0),
        /** Alerts this person's own work closed — a count of repairs, never a rate. */
        fixes_authored: z.number().int().min(0),
      }),
    ])
    .default({ collected: false }),
});

export type HistoryBlock = z.infer<typeof HistoryBlock>;

/**
 * What the passport was measured ON, as one sentence (B6.1, B6.2).
 *
 * It lives here, with the data, because three surfaces say it and only one of them is React: the
 * card, the badge's title and the OG image. "One component, two surfaces" cannot be a component
 * when one of the surfaces is an SVG string — so the shared thing is the sentence, built from
 * the snapshot's own mixes and never recomputed by anybody.
 */
export type CardComposition = {
  /** Episodes behind the passport — the denominator every share below is a share of. */
  episodes: number;
  /** By carrier kind, as freshness mass: the same weighting the claims were scored under. */
  byKind: Array<{ kind: string; share: number }>;
  /** The share of the history's episodes that somebody other than the author saw (W2), by
   *  freshness mass; null when the snapshot does not carry it. */
  reviewedShare: number | null;
  /** How much of the work sits in a carrier kind this person also works in another way (6.2 §6).
   *  Below 0.10 the transfer contour is not identified by them, which is why it publishes
   *  nothing; carried so the silence has a reason a reader can see. */
  bridgeShare: number;
};

/** The order the classes are read in, strongest first: another account merged it; machines
 *  decided it; no CI, the rest not shown; the author alone, shown; nothing left to say. */
export const EVIDENCE_CLASS_ORDER: readonly EvidenceClass[] = [
  "accepted_by_other",
  "machine_checked",
  "no_ci",
  "author_only",
  "unknown",
];

/**
 * What each class is called on every surface (evidence class, 2026-10-10). ONE vocabulary: the
 * card, the History page, the share text and the OG image all read it, so one class cannot mean a
 * merge on one screen and a CI run on another. Two voices, because the owner reads "you" and a
 * stranger reads "the author" — the class is the same.
 *
 * What the words may not do is promise more than the record holds. CI and "not reverted" are
 * decided by machines in a repository the person can configure, so they are "machine-checked",
 * never "third-party". A merge by another ACCOUNT is what GitHub records — a second account of
 * the same person or an unmarked machine user reads the same — so it is "merged by another
 * account", not "accepted by someone else". "Alone" is said only where the record shows the
 * author merged with no other review and no CI; every other W0 is "not checked by CI".
 */
export const EVIDENCE_CLASS_WORDS: Record<"owner" | "public", Record<EvidenceClass, string>> = {
  owner: {
    accepted_by_other: "merged by another account",
    machine_checked: "machine-checked",
    no_ci: "not checked by CI",
    author_only: "merged by you, no review or CI",
    unknown: "with CI records gone",
  },
  public: {
    accepted_by_other: "merged by another account",
    machine_checked: "machine-checked",
    no_ci: "not checked by CI",
    author_only: "self-merged, no review or CI",
    unknown: "with CI records gone",
  },
};

/** The count of a class as a surface prints it: "at least 4" for acceptance while some mergers
 *  went unrecorded (read before 2.5) — those merges may have been anybody's, so the count is a
 *  lower bound and must read as one. Every other class is an exact count. */
export function evidenceCount(
  facts: Pick<MeasuredFacts, "mergerUnrecorded">,
  evidence: EvidenceClass,
  n: number,
): string {
  return evidence === "accepted_by_other" && (facts.mergerUnrecorded ?? 0) > 0 ? `at least ${n}` : String(n);
}

/**
 * "38 results · 6 merged by another account · 32 machine-checked" — what the record rests on,
 * in counts that add up to the first one. Null when the snapshot does not carry the counts
 * (scored before 2.5) or there is nothing yet: the surface says nothing rather than a zero.
 */
export function evidenceClassLine(
  facts: Pick<MeasuredFacts, "landings" | "byEvidence" | "mergerUnrecorded">,
  voice: "owner" | "public",
): string | null {
  const clauses = evidenceClauses(facts, voice);
  if (!clauses) return null;
  return [`${facts.landings} result${facts.landings === 1 ? "" : "s"}`, ...clauses].join(" · ");
}

/** The clauses of that line without its head — "6 merged by another account", "32 machine-checked"
 *  — for a sentence that has already said how many results there are. Null exactly when the line
 *  is. */
export function evidenceClauses(
  facts: Pick<MeasuredFacts, "landings" | "byEvidence" | "mergerUnrecorded">,
  voice: "owner" | "public",
): string[] | null {
  if (!facts.byEvidence || facts.landings === 0 || facts.byEvidence.length === 0) return null;
  const words = EVIDENCE_CLASS_WORDS[voice];
  return facts.byEvidence.map((e) => `${evidenceCount(facts, e.evidence, e.landings)} ${words[e.evidence]}`);
}

export const KIND_WORDS: Record<string, string> = {
  pr: "pull requests",
  commit_run: "direct commits",
  release: "releases",
};

/** The composition, out of the snapshot's own mixes. Nothing is recomputed. */
export function compositionFromSnapshot(snapshot: Snapshot): CardComposition {
  const kinds = Object.entries(snapshot.carrier_mix ?? {})
    .map(([kind, share]) => ({ kind, share: Number(share) || 0 }))
    .filter((k) => k.share > 0)
    .sort((a, b) => b.share - a.share);
  const reviewed = (snapshot.witness_mix ?? {}).W2;
  return {
    episodes: snapshot.volumes.n_episodes,
    byKind: kinds,
    reviewedShare: typeof reviewed === "number" ? reviewed : null,
    bridgeShare: snapshot.bridge_share ?? 0,
  };
}

/**
 * §14.1 — the layer of FACTS a passport carries in every status.
 *
 * The product asks a person for two things, connecting GitHub and running `deigma init`, and
 * asks for nothing after that. Everything already there has to become a result on the first
 * minute: not a promise of one, not a list of what is still missing, and not a progress bar
 * towards a configuration nobody agreed to do. A claim with an interval is a second layer that
 * arrives as it is proven; Draft, Calibrating and Verified are a stamp ON the passport, not its
 * content.
 *
 * Every field here is a COUNT or a NAME, never an estimate — nothing in it needs a gate, an
 * interval or a witness to be honest, which is exactly why it can be shown at once. Where a
 * number is genuinely unknown the field is null and the surface says "no data", which is a
 * different sentence from zero and must read as one.
 */
export type MeasuredFacts = {
  /** Landings inside the freshness window, and where they happened. */
  landings: number;
  repositories: number;
  /** By carrier kind, as counts rather than shares: a person counting their own work should get
   *  the counting answer, and the mass-weighted version is what the claims were scored on. */
  byKind: Array<{ kind: string; landings: number }>;
  /** By who saw them land. `unknown` is kept apart from W0 on purpose: records GitHub no longer
   *  serves are not work nobody witnessed (§12). */
  byWitness: Array<{ witness: string; landings: number }>;
  /** By what the record rests on (`EvidenceClass`), as counts that add up to `landings`, zero
   *  classes dropped. Null when the snapshot predates the count (scored before 2.5): the surface
   *  then says nothing about it rather than printing a zero nobody measured. A count of the work
   *  itself and nobody's numerator, so it is public like `byWitness`. */
  byEvidence: Array<{ evidence: EvidenceClass; landings: number }> | null;
  /** Merged pull requests read before the merger was recorded: acceptance is a lower bound by
   *  this many. Null when not counted. */
  mergerUnrecorded: number | null;
  /** Episodes carrying a trace of an agent, from the carrier's own commit trailers and the
   *  local journals — named, never scored, and a share of landings rather than of sessions. */
  withAi: number;
  agents: Array<{ agent: string; episodes: number }>;
  /** What the environment did, as counters. Volume is not skill and none of these is an input to
   *  a claim; they are here because they are true and a person recognises their own work in them. */
  tools: number;
  mcpToolsMax: number;
  skillCalls: number;
  sessions: number;
  /** Schema 2.10: the agents those sessions were read from (Claude Code, Codex), in the fixed
   *  order, without counts — a name a person recognises. Absent on facts built before 2.10. */
  sessionAgents?: Array<(typeof AGENTS)[number]>;
  /** Agent sessions by week, oldest first, on the timeline's own axis: index i is the week a
   *  landing with `week: i` opened in (`agents.weeks` and `history.weeks` are the scorer's Monday
   *  weeks counted back from one run). Counts the scorer made, drawn as the small marks under the
   *  work on the line; nobody's numerator — more sessions is volume, not skill (T22d). WEEK-level
   *  only, the granularity a stranger already gets for a landing: no day travels here. Empty when
   *  nothing was read; absent on facts built before it existed. */
  sessionWeeks?: number[];
  /** §11.4 — how much of the work is still standing after D days: no revert, and no more than
   *  `survival_rewrite_threshold` of its lines written over. A FACT, not a claim: it is counted
   *  from the repository's own history, it enters no model, and it needs no CI.
   *
   *  Split by witness: on a carrier nobody but the author saw it travels signed `self-witnessed`.
   *  Since Core 7 neither half is any claim's numerator, so both are public. */
  survivalSelfWitnessed: SurvivalFact | null;
  survivalWitnessed: SurvivalFact | null;
  /** The same two, at EVERY horizon rather than the longest one with data.
   *
   *  The card's first tile is "stayed shipped", and it must not be a sum across two horizons:
   *  the witnessed half can have data at 30 days while the self-witnessed half has it at 90, and
   *  adding those gives a number whose denominator means two different things. The surface picks
   *  one horizon and adds within it — 30 days for the owner, 90 for what a stranger may see —
   *  which it can only do if both lists are here. */
  survivalWitnessedAll: SurvivalFact[];
  survivalSelfWitnessedAll: SurvivalFact[];
  /** The turns a person typed before the work landed, as a median. A fact (Core 7 §7: the path
   *  claim is gone). */
  medianPromptsToLanding: number | null;
  /** Turns per session, as a median — the sentence under the prompts tile. Nobody's numerator:
   *  the claim is prompts per LANDING, and this is prompts per sitting. */
  medianPromptsPerSession: number | null;
  /** Every landing, for the timeline (redesign §3). Already projected for the surface that asked:
   *  a public model carries no repository names and no revert flags until the claim is proven. */
  landingDots: Landing[];
  /** Subagents launched and workflows run, read off the tool counters by name. Counters, never
   *  inputs: "ran more subagents" is volume, and volume is not skill (T22d). */
  subagents: number;
  workflows: number;
};

/** "N of M landings still stand after D days." Days are a list because the shape of the answer
 *  is the point: 90 % at 14 days and 60 % at 90 says something 90 % alone does not. */
export type SurvivalFact = {
  standing: number;
  of: number;
  days: number;
};


/** §14.1 — the one hint the product is allowed to give, or none.
 *
 * A line under a fact, and only when the action would change something MEASURABLE: "CI in
 * sentinel would have made 13 landings witnessed" is a sentence about this person's own numbers.
 * Never a list, never a task, never "required" or "set up" — those are the words the pivot
 * removed, and a test on the rendered text holds them out.
 *
 * Returns null far more often than not, and that is the design: a passport with nothing useful
 * to say says nothing. The temptation this function exists to refuse is the helpful one — five
 * suggestions, each individually reasonable, which together are a checklist the person did not
 * ask for and cannot finish.
 */
export function hintFor(facts: MeasuredFacts): string | null {
  // The wedge, and ONLY as the second hint, and only when there is work for it to describe.
  // It used to live on the onboarding as "step 3: install the collectors" — a task in a list
  // before the person had seen a single number of their own. Here it is a line under the facts,
  // beside the rows it would fill, and it names what it would measure rather than what to run.
  if (facts.sessions === 0 && facts.landings > 0) {
    return `No agent sessions read yet. The sessions already on your machine would show your habits with the agent — whether you plan before edits, look at changes before a commit, point corrections at a place.`;
  }
  return null;
}

/** The order claims are read in, everywhere they are read. */
export const CLAIM_ORDER: readonly ClaimKey[] = ["decisions_by_others"];

export type PublicClaim = {
  key: ClaimKey;
  unit: Claim["unit"];
  proven: boolean;
  n_observations: number;
  value: number | null;
  ci90: { lo: number; hi: number } | null;
};

/**
 * A snapshot's claims as a STRANGER receives them (Core 7 §3.3, §5).
 *
 * One implementation, because there are two readers: the API serves it on `/p/:handle` and inside
 * the signed proof, and the landing renders an example passport from a snapshot on disk without an
 * API in front of it. A second copy of "which fields survive the boundary" is a second place for
 * an unproven value to slip through. An allow-list: `preliminary` is not named, so it cannot pass.
 */
export function publicClaims(claims: Snapshot["claims"]): PublicClaim[] {
  return CLAIM_ORDER.flatMap((key) => {
    const claim = claims[key];
    if (!claim) return [];
    return [
      {
        key,
        unit: claim.unit,
        proven: claim.proven,
        // Volume is a fact about the work, not about the score: it may be shown either way.
        n_observations: claim.n_observations,
        value: claim.proven ? claim.value : null,
        ci90: claim.proven ? claim.ci90 : null,
      },
    ];
  });
}

/** What a STRANGER may see of the facts layer. An allow-list, and a function rather than a filter:
 *  a field added to `MeasuredFacts` does not reach a stranger until somebody writes it here.
 *  Habits are not in `MeasuredFacts` at all — they are owner-only (Core 7 §4).
 *
 *  One count waits for the claim: how many results another account merged. Beside the claim's
 *  public volume it is the raw numerator of decisions by others, and the numerator of an unproven
 *  claim is published neither as a number nor as a share — so until the claim is proven the class
 *  `accepted_by_other` and the count of unrecorded mergers stay off a stranger's surface. */
export function publicFacts(facts: MeasuredFacts, opts: { claimProven: boolean }): PublicMeasuredFacts {
  return {
    landings: facts.landings,
    repositories: facts.repositories,
    byKind: facts.byKind,
    byWitness: facts.byWitness,
    // Until the claim is proven a stranger gets no split by evidence class at all (founder,
    // 2026-10-29). With "merged by another account" held back, what was left — "1 machine-checked"
    // beside seven dots drawn as checked by CI — read as "only one was checked". The card then
    // falls back to the witness count (cardText restsOn), which is the dots' own reading.
    byEvidence: opts.claimProven ? facts.byEvidence : null,
    mergerUnrecorded: opts.claimProven ? facts.mergerUnrecorded : null,
    withAi: facts.withAi,
    agents: facts.agents,
    tools: facts.tools,
    mcpToolsMax: facts.mcpToolsMax,
    skillCalls: facts.skillCalls,
    sessions: facts.sessions,
    // Sessions by WEEK, the granularity the public line already has (a landing keeps its `week`
    // and never its day): how many, never when within the week, never which project.
    sessionWeeks: facts.sessionWeeks ?? [],
    survivalSelfWitnessed: facts.survivalSelfWitnessed,
    survivalWitnessed: facts.survivalWitnessed,
    survivalWitnessedAll: facts.survivalWitnessedAll,
    survivalSelfWitnessedAll: facts.survivalSelfWitnessedAll,
    medianPromptsToLanding: facts.medianPromptsToLanding,
    medianPromptsPerSession: facts.medianPromptsPerSession,
    subagents: facts.subagents,
    workflows: facts.workflows,
    // The timeline a stranger sees: the work, its sizes and whether an agent was in the loop —
    // all counts of the work itself. Not the repository it happened in.
    // RD-19: the day, the grade and the PR number are owner-only and are dropped outright,
    // not nulled — an absent field draws nothing, and the dot keeps its week.
    landingDots: facts.landingDots.map(
      ({ landed_at: _day, grade: _grade, number: _number, ...dot }) => ({
        ...dot,
        repository: null,
        reverted: dot.reverted,
      }),
    ),
  };
}

export type PublicMeasuredFacts = MeasuredFacts;

export function measuredFactsFromSnapshot(snapshot: Snapshot): MeasuredFacts {
  const history = snapshot.history;
  const counts = history.witness_counts ?? {};
  const byWitness = (["W2", "W1", "W0", "unknown"] as const)
    .map((witness) => ({ witness, landings: Number(counts[witness] ?? 0) }))
    .filter((w) => w.landings > 0);
  const total = snapshot.volumes.n_episodes;
  const evidenceCounts = history.evidence_counts;
  const byEvidence = evidenceCounts
    ? EVIDENCE_CLASS_ORDER.map((evidence) => ({ evidence, landings: Number(evidenceCounts[evidence] ?? 0) })).filter(
        (e) => e.landings > 0,
      )
    : null;
  const byKind = Object.entries(history.kind_counts ?? {})
    .map(([kind, landings]) => ({ kind, landings: Number(landings) || 0 }))
    .filter((k) => k.landings > 0)
    .sort((a, b) => b.landings - a.landings);
  // AI participation is a count of LANDINGS — the carrier's own trailers plus what the local
  // journals said — and it is COUNTED, not reconstructed. Counting sessions instead would make
  // somebody who runs the agent more look like they work with it more, which is the
  // volume-is-not-skill mistake in its most natural disguise; and reconstructing the count from
  // a share is the same mistake wearing arithmetic. Both of these read
  // `round(freshness_mass_share * n_episodes)`, which is an estimate of something nobody had to
  // estimate: measured across the dumped snapshots it was wrong for three accounts of sixteen,
  // once by two landings, and once UPWARDS — "107 of 107 landings with an agent" where the
  // hundred-and-seventh had none. The passport now reads the counts the scorer already made.
  const withAi = history.n_with_ai;
  // The longest horizon with carriers old enough to judge. Longest because it is the strongest
  // statement the data supports, and "of: 0" is not a statement at all — a horizon nothing has
  // reached yet says nothing, and saying nothing is not the same as saying none survived.
  const longest = (horizons: Array<{ days: number; standing: number; of: number }>) =>
    [...horizons].filter((h) => h.of > 0).sort((a, b) => b.days - a.days)[0] ?? null;
  const survival = snapshot.survival ?? {
    self_witnessed: [],
    witnessed: [],
    median_prompts_to_landing: null,
  };
  return {
    landings: total,
    repositories: history.context.repositories,
    byKind,
    byWitness,
    byEvidence,
    mergerUnrecorded: history.merger_unrecorded ?? null,
    withAi,
    agents: history.agents ?? [],
    tools: snapshot.agents.tools.length,
    mcpToolsMax: snapshot.agents.mcp_tools_max,
    skillCalls: snapshot.agents.skill_calls,
    sessions: snapshot.agents.n_sessions,
    sessionAgents: (snapshot.agents.by_agent ?? []).filter((a) => a.n_sessions > 0).map((a) => a.agent),
    sessionWeeks: sessionWeeksOnTheLine(snapshot),
    survivalSelfWitnessed: longest(survival.self_witnessed),
    survivalWitnessed: longest(survival.witnessed),
    survivalWitnessedAll: [...survival.witnessed],
    survivalSelfWitnessedAll: [...survival.self_witnessed],
    medianPromptsToLanding: survival.median_prompts_to_landing,
    medianPromptsPerSession: snapshot.agents.n_sessions > 0 ? snapshot.agents.median_prompts : null,
    landingDots: history.landings ?? [],
    // By NAME off the tool counters, so the card does not have to know the vocabulary. The names
    // are built-ins (`apps/wedge-cli/src/vocabulary.ts`): anything a user named was hashed on
    // their own device long before it reached here.
    subagents: toolCalls(snapshot, ["Agent", "Task"]),
    workflows: toolCalls(snapshot, ["Workflow"]),
  };
}

/** `agents.weeks` on the landings' axis, matched by the week's Monday rather than by position: the
 *  two lists come from one run and agree today, and a week the history does not hold is outside
 *  the line and is not drawn rather than shifted onto a neighbour. Without a history axis (nothing
 *  carried yet) the sessions' own list is the axis — it is built over the same span. */
function sessionWeeksOnTheLine(snapshot: Snapshot): number[] {
  const weeks = snapshot.agents.weeks;
  if (!weeks.some((w) => w.sessions > 0)) return [];
  const axis = snapshot.history.weeks.map((w) => w.week_start.slice(0, 10));
  if (axis.length === 0) return weeks.map((w) => w.sessions);
  const at = new Map(axis.map((start, i) => [start, i]));
  const out = axis.map(() => 0);
  for (const w of weeks) {
    const i = at.get(w.week_start.slice(0, 10));
    if (i !== undefined) out[i]! += w.sessions;
  }
  return out.some((n) => n > 0) ? out : [];
}

function toolCalls(snapshot: Snapshot, names: readonly string[]): number {
  return snapshot.agents.tools
    .filter((tool) => names.includes(tool.name))
    .reduce((sum, tool) => sum + tool.calls, 0);
}

/**
 * "measured on 214 episodes · 60 % pull requests · 40 % direct commits · 70 % reviewed".
 *
 * Every clause is a fact with a denominator the reader can see. The witness share comes last and
 * is called "reviewed": it is the share of the episodes that ENTERED the outcome claim which
 * somebody other than their author saw. A surface that led with it would read as a boast about
 * process rather than a statement of what the number rests on.
 */
export function measuredOnText(c: CardComposition | undefined | null): string | null {
  if (!c || c.episodes === 0) return null;
  const parts = [`measured on ${c.episodes} episode${c.episodes === 1 ? "" : "s"}`];
  for (const k of c.byKind) {
    parts.push(`${Math.round(k.share * 100)} % ${KIND_WORDS[k.kind] ?? k.kind}`);
  }
  if (c.reviewedShare !== null) parts.push(`${Math.round(c.reviewedShare * 100)} % reviewed`);
  return parts.join(" · ");
}

export const ClaimKey = z.enum([
  /** Core 7 §3: how often other people accept the work, cleaned of repository, reviewer and the
   *  newcomer effect. The only claim since 2026-10-15. */
  "decisions_by_others",
]);

/** The unit each claim is counted in. A claim is NAMED BY ITS UNIT: a definition change that moves
 *  the unit gets a new name here. */
export const ClaimUnit = z.enum([
  /** Core 7 §2: a pull request whose fate somebody other than its author decided (W1). */
  "prs_decided_by_others",
]);

/** Why a claim is not published yet (Core 7 §3.3). */
export const ClaimBlocker = z.enum([
  "no_observations",
  /** Below the floor of observations: no number at all, not even for the owner. */
  "min_observations",
  /** Past the floor, but the 90 % interval is still wider than the threshold. */
  "interval",
]);

export const ClaimProgress = z
  .strictObject({
    have: z.number().min(0),
    need: z.number().min(0),
    unit: z.string().min(1),
    /** Whether `need` is a projection rather than a count: how many observations the interval
     *  takes depends on how the person's work is decided, so the card says "about 45" (`r_expected_observations`). */
    approximate: z.boolean().default(false),
  })
  .meta({ id: "ClaimProgress", title: "ClaimProgress" });

export const Claim = z
  .strictObject({
    key: ClaimKey,
    unit: ClaimUnit,
    /** Observations of THIS claim's unit. */
    n_observations: nonNegativeInt,
    /** How many of them were reconstructed from history rather than observed live. Recorded, not
     * weighted: the point is that it CAN be weighted later. */
    n_backfilled: nonNegativeInt,
    /** PRs other people decided whose context could not be measured (fewer than 5 other decided
     *  PRs in that repository and year, or the repository could not be read). Not observations:
     *  "could not measure" is not a zero (Core 7 §2). */
    n_without_context: nonNegativeInt.default(0),
    proven: z.boolean(),
    /** ARCH-3: an unproven claim carries no value and no interval. Both are null together. */
    value: z.number().min(0).max(1).nullable(),
    ci90: ValueInterval.nullable(),
    /** The rule in words, as shown next to the claim. */
    threshold: z.string().min(1),
    /** Width of the 90 % interval in percentage points; null below the floor. */
    measured_ci90_pp: z.number().min(0).nullable(),
    blocked_by: ClaimBlocker.nullable(),
    progress: ClaimProgress.nullable(),
    /**
     * The OWNER's preliminary reading (decision of 2026-10-08): past the floor of observations and
     * not yet proven, the estimate WITH its full 90 % interval. Not the claim's value: `value` and
     * `ci90` stay null, `proven` stays false, the status does not move. Owner-only — the
     * stranger's projection (`publicClaims`) is an allow-list that does not name this key; held by
     * a test in the service. Null below the floor.
     */
    preliminary: z
      .strictObject({ value: z.number().min(0).max(1), ci90: ValueInterval })
      .nullable()
      .default(null),
    /** Which class of evidence this claim rests on. Decisions by others are `carrier`. */
    evidence_class: z.enum(["carrier", "client", "mixed"]),
    definition_version: z.literal("R-7.0"),
  })
  .meta({ id: "Claim", title: "Claim" });

export type ClaimKey = z.infer<typeof ClaimKey>;
export type Claim = z.infer<typeof Claim>;

export const PassportClaims = z
  .strictObject({
    decisions_by_others: Claim,
  })
  .meta({ id: "PassportClaims", title: "PassportClaims" });

/** One habit trace, summed over the sessions the reader saw (Core 7 §4). Owner-only. */
export const HabitTotal = z
  .strictObject({
    opportunities: nonNegativeInt,
    hits: nonNegativeInt,
    /** Sessions in which the trace had at least one occasion. */
    sessions: nonNegativeInt,
  })
  .meta({ id: "HabitTotal", title: "HabitTotal" });

export const HABIT_KEYS = [
  "plan_before_edit",
  "names_files",
  "diff_before_commit",
  "located_corrections",
] as const;

/** Habit facts (Core 7 §4): counts from the device, never an interval, a grade or a scale. A trace
 *  that never had an occasion is absent rather than "0 of 0". Owner-only: public habits wait for
 *  human experts. */
/** Editor habits (Core 7 §7: drafts in the editor stay a fact). Counted by the public rules
 *  `ed-1.0` over the suggestions the editor saw accepted; owner-only like every habit, never a
 *  grade, never a claim input. Null until the editor has reported an accepted suggestion. */
export const EditorHabits = z
  .strictObject({
    rules_version: z.literal("ed-1.0"),
    /** Suggestions accepted (or saved) with the editor watching. */
    accepted: z.number().int().positive(),
    /** Of those, read before accepting: scrolled through or changed, and on screen at least as
     *  long as reading it takes (3 s + 0.8 s per line) and not left open far longer (15x). */
    read_before_accepting: nonNegativeInt,
    /** Of those, changed before being kept. */
    changed_before_keeping: nonNegativeInt,
  })
  .meta({ id: "EditorHabits", title: "EditorHabits" });

export const HabitsBlock = z
  .strictObject({
    /** Sessions whose reader counted habits (rules hb-1.0). */
    sessions_read: nonNegativeInt,
    traces: z.partialRecord(z.enum(HABIT_KEYS), HabitTotal),
    editor: EditorHabits.nullable().default(null),
  })
  .meta({ id: "HabitsBlock", title: "HabitsBlock" });

/** The practice index (pi-1.0): how a person works with AI agents,
 *  as the labs recommend it — one number 0–100 with its 90 % interval, from 14 practices in four
 *  groups. Counted facts per practice (occasions and hits) aggregated by fixed, equal weights; not a
 *  measure of results and never part of Verified. */
export const PRACTICE_GROUPS = ["security", "verification", "setup", "environment", "communication"] as const;
/** pi-1.2: the level word of the index, from fixed bands (below 40, 40–59, 60–79, 80 and above). */
/** pi-1.6: the level words, lowest first. "Getting started" (pi-1.2–1.5) is still read on older
 *  snapshots and is never written. */
export const PRACTICE_LEVELS = ["Building", "Solid", "Strong", "Expert"] as const;
export const READABLE_PRACTICE_LEVELS = [...PRACTICE_LEVELS, "Getting started"] as const;
export const PRACTICE_KEYS = [
  "security_review",
  "dependency_audit",
  "no_secrets",
  "permissions_on",
  "risky_confirmed",
  "tests_after_edit",
  "tests_with_code",
  "saw_diff_before_commit",
  "independent_review",
  "explore_before_edit",
  "plan_complex",
  "names_files",
  "memory_alive",
  "code_stands_14d",
  // pi-1.2: communication (hb-2.1); `risky_confirmed` above is read on pi-1.0/1.1 snapshots only.
  "clear_goal",
  "one_task",
  "gives_context",
  "located_corrections",
  // pi-1.3: computed on the server from GitHub (one occasion per landing, or per repository for
  // `gh_security_scanning`), so a person who connected only GitHub still gets the index.
  "gh_security_scanning",
  "gh_tests_with_code",
  "gh_green_before_merge",
  "gh_small_changes",
] as const;
/** The practices read on the server from GitHub, not from the device: the survival fact
 *  `code_stands_14d` (a landing's code still standing after 14 days) and the four `gh_*` items of
 *  pi-1.3 — the scorer's `SERVER_ITEMS`, held equal by a drift test in the monorepo. Until
 *  2026-10-29 the survival fact was missing here, so the owner's card said it came from the terminal
 *  and every "practices on your machine" count was one too high. */
export const GITHUB_PRACTICE_KEYS = [
  "code_stands_14d",
  "gh_security_scanning",
  "gh_tests_with_code",
  "gh_green_before_merge",
  "gh_small_changes",
] as const satisfies readonly (typeof PRACTICE_KEYS)[number][];
/** Practices that are counted and shown to the owner as facts but do not enter the number:
 *  `explore_before_edit` (J-43, near-constant) and, since pi-1.4, `one_task` (solo review B4: its
 *  misses are pasted machine text, not bundled asks). */
export const PRACTICES_OUTSIDE_INDEX = ["explore_before_edit", "one_task"] as const;
/** The practices of the DEVICE that make up the number: every key except the retired
 *  `risky_confirmed` (merged into `permissions_on`), the practices outside the index and the ones
 *  read from GitHub (a person may have only those). What a sentence like "14 practices" reads. */
export const PRACTICES_IN_INDEX = PRACTICE_KEYS.filter(
  (k) =>
    k !== "risky_confirmed" &&
    !(PRACTICES_OUTSIDE_INDEX as readonly string[]).includes(k) &&
    !(GITHUB_PRACTICE_KEYS as readonly string[]).includes(k),
);
export const PracticeItem = z
  .strictObject({
    group: z.enum(PRACTICE_GROUPS),
    opportunities: nonNegativeInt,
    hits: nonNegativeInt,
    /** Smoothed share (hits + 1) / (opportunities + 2); null below the per-item floor. */
    share: unitInterval.nullable(),
    /** pi-1.2: false for a practice that is counted and shown but does not enter the index
     *  (`explore_before_edit`). */
    in_index: z.boolean().default(true),
  })
  .meta({ id: "PracticeItem", title: "PracticeItem" });
export const PracticeIndex = z
  .strictObject({
    /** pi-1.1 since the cap on sessions per day, the editor in item 8 and the weekly movement;
     *  snapshots written under pi-1.0 are still read. */
    rules_version: z.enum(["pi-1.0", "pi-1.1", "pi-1.2", "pi-1.3", "pi-1.4", "pi-1.5", "pi-1.6", "pi-1.7"]),
    /** published: past the floor with a narrow interval; preliminary: owner-only reading; collecting:
     *  not enough yet (no number anywhere). */
    state: z.enum(["published", "preliminary", "collecting"]),
    /** 0–100, integer. Only when state is published (public) or preliminary (owner only). */
    value: z.number().int().min(0).max(100).nullable(),
    ci90: z.strictObject({ lo: z.number().int().min(0).max(100), hi: z.number().int().min(0).max(100) }).nullable(),
    n_sessions: nonNegativeInt,
    /** Sessions the number needs before it is published (configuration). */
    min_sessions: nonNegativeInt,
    /** pi-1.3: landings (merged pull requests, runs of commits) that count toward the GitHub items,
     *  and the landings the number needs when there are no sessions to count. 0 on older snapshots. */
    n_landings: nonNegativeInt.default(0),
    min_landings: nonNegativeInt.default(0),
    /** pi-1.4: distinct UTC days with counted work, and the days a stranger's number needs (the
     *  day is also the unit of the interval). 0 on older snapshots. */
    n_days: nonNegativeInt.default(0),
    min_days: nonNegativeInt.default(0),
    /** pi-1.5: practices past their floor that the number rests on, and how many it needs. */
    n_items: nonNegativeInt.default(0),
    min_items: nonNegativeInt.default(0),
    /** pi-1.6: what the number rests on — the device (terminal, editor), GitHub alone, or both.
     *  A GitHub-only number counts engineering practice on every landing, with or without an
     *  agent, and its scale is not the terminal's, so every surface names the source. Public. */
    source: z.enum(["device", "github", "both"]).nullable().default(null),
    /** pi-1.6: landings that carry an AI trace (an agent's co-author trailer, a bound session). */
    n_landings_ai: nonNegativeInt.default(0),
    groups: z.partialRecord(z.enum(PRACTICE_GROUPS), unitInterval),
    items: z.partialRecord(z.enum(PRACTICE_KEYS), PracticeItem),
    /** OWNER ONLY (never in `publicPracticeIndex`): the value now minus the value seven days ago,
     *  computed by the same function on the observations available then. Null when either side has
     *  no value, and on pi-1.0 snapshots. */
    delta_7d: z.number().int().nullable().default(null),
    /** The practice whose share moved most in the direction of the delta; null under one point. */
    delta_reason: z.enum(PRACTICE_KEYS).nullable().default(null),
    /** pi-1.2: the level word of `value`; present exactly where a value is (published, or
     *  preliminary to the owner). Derived from the number, so it is also public. */
    level: z.enum(READABLE_PRACTICE_LEVELS).nullable().default(null),
    /** pi-1.2, OWNER ONLY: the two practices with the highest smoothed share among those in the
     *  index and past the floor. Empty where there is no value. */
    strengths: z.array(z.enum(PRACTICE_KEYS)).default([]),
    /** pi-1.2, OWNER ONLY: the in-index practice past the floor with the lowest share. */
    next_step: z.enum(PRACTICE_KEYS).nullable().default(null),
    /** pi-1.7 (decision 1 of 2026-10-20): the counted sessions by agent, after the daily cap they
     *  share. The number is pooled over all of them. OWNER ONLY. */
    agents: z.partialRecord(z.enum(AGENTS), nonNegativeInt).default({}),
    /** pi-1.7 (decision 3), OWNER ONLY: the agent whose sessions, entering in the last seven days,
     *  moved the number by more than half the interval it had without them — the owner card then
     *  says "Recomputed with Codex sessions" and the journal has the row. Null otherwise. */
    recomputed_with: z.enum(AGENTS).nullable().default(null),
  })
  .meta({ id: "PracticeIndex", title: "PracticeIndex" });

/** What a STRANGER receives of the practice index: the number, its interval and the session count,
 *  only once published. An allow-list; the per-practice breakdown is the owner's. */
export type PublicPracticeIndex = {
  value: number;
  ci90: { lo: number; hi: number };
  n_sessions: number;
  /** pi-1.3: landings the GitHub items rest on (absent on snapshots written before it). */
  n_landings?: number;
  /** The level word of the published value (null on snapshots written before pi-1.2). */
  level: (typeof READABLE_PRACTICE_LEVELS)[number] | null;
  /** pi-1.6: what the number rests on (absent before it). */
  source?: "device" | "github" | "both" | null;
  /** pi-1.6: of the landings, how many carry an AI trace (absent before it). */
  n_landings_ai?: number;
} | null;
export function publicPracticeIndex(p: z.infer<typeof PracticeIndex> | null | undefined): PublicPracticeIndex {
  if (!p || p.state !== "published" || p.value === null || p.ci90 === null) return null;
  return {
    value: p.value,
    ci90: { lo: p.ci90.lo, hi: p.ci90.hi },
    n_sessions: p.n_sessions,
    n_landings: p.n_landings,
    level: p.level,
    source: p.source,
    n_landings_ai: p.n_landings_ai,
  };
}

/** The habit traces as a person says them (Core 7 §4): "A plan before the agent's first edit: 3 of
 *  5 times, in 5 sessions". One wording for every owner surface — the terminal, the email, History. */
export const HABIT_WORDS: Record<(typeof HABIT_KEYS)[number], string> = {
  plan_before_edit: "A plan before the agent's first edit",
  names_files: "Prompts that name the files the agent then opens",
  diff_before_commit: "Changes looked at before the agent's commit",
  located_corrections: "Corrections that point at a place",
};

// `habitLines` printed the hb-1.0 traces on the owner's surfaces; it is gone (founder, 2026-10-18):
// they contradicted the practice index beside them. The traces stay in the snapshot (the stand's
// oracle and the passport's evidence read them); no surface prints them.

/** 6.1 §11: the passport discloses the context it was measured in instead of hiding a
 * penalty for single-context work. A single-repository user gets a full Verified passport; what
 * they do not get is a transferability claim. */
export const ContextBreadth = z
  .strictObject({
    projects: nonNegativeInt,
    /** Ready-to-render wording, e.g. "measured across 1 project". */
    label: z.string().min(1),
  })
  .meta({ id: "ContextBreadth", title: "ContextBreadth" });


export const Snapshot = z
  .strictObject({
    snapshot_id: uuid,
    user_id: uuid,
    created_at: rfc3339,
    status: PassportStatus,
    provenance: EngineProvenance,
    volumes: z
      .strictObject({
        n_carriers: nonNegativeInt,
        n_episodes: nonNegativeInt,
        /** Episodes that EVER had a 72-hour decision — finals included, so it overlaps
         *  `n_outcomes_final` and the two must never be added up (audit 2026-10-08 #2). Kept, with
         *  that meaning, so a snapshot written before 2.3 still says what it counted; surfaces
         *  read `n_outcomes_pending`. */
        n_outcomes_provisional: nonNegativeInt,
        /** Outcomes decided at 72 hours and NOT yet final: what is actually pending. Disjoint from
         *  `n_outcomes_final`, so pending + final <= episodes. */
        n_outcomes_pending: nonNegativeInt.optional(),
        n_outcomes_final: nonNegativeInt,
        /** How the final outcomes landed, by category (6.1 §3): "0".."3" -> count of outcomes
         * pinned to exactly that category (y_lo == y_hi). An interval is never counted under its
         * lower bound — "landed, or maybe not" is not "did not land" (audit 2026-10-08 #1). */
        outcome_categories: z.record(z.enum(["0", "1", "2", "3"]), nonNegativeInt),
        /** The final outcomes the evidence could only bound, by interval: categories plus these
         *  add up to `n_outcomes_final`, so nothing is dropped silently. */
        outcome_ranges: z
          .array(
            z.strictObject({
              y_lo: z.number().int().min(0).max(3),
              y_hi: z.number().int().min(0).max(3),
              n: z.number().int().positive(),
            }),
          )
          .optional(),
        /** The sum of `outcome_ranges[].n`: final outcomes not pinned to a single category.
         *  ABSENT, never 0, on a snapshot from before 2.3 (review 2026-10-08 #11): such a snapshot
         *  bucketed every interval under its lower bound, so its `outcome_categories` is not a
         *  histogram of pinned grades and surfaces must not print it as one. The same for
         *  `n_outcomes_pending` and `outcome_ranges`: a count nobody made is not a zero. */
        n_outcomes_ungraded: nonNegativeInt.optional(),
        n_repositories: nonNegativeInt,
        history_from: rfc3339.nullable(),
        history_to: rfc3339.nullable(),
      })
      .meta({ id: "SnapshotVolumes", title: "SnapshotVolumes" }),
    /** The composition of the evidence behind this passport, by freshness mass (B1.6): who
     *  witnessed each episode of the history. A fact, not a claim input. */
    witness_mix: WitnessMix,
    /** Which carriers the history is made of, by freshness mass: pull requests, runs of commits,
     *  releases. The card names it, because "214 episodes" says nothing about what they were. */
    carrier_mix: z.partialRecord(CarrierKind, z.number().min(0).max(1)),
    /** Where the knowledge of AI participation came from, by freshness mass (6.2 §5.1, §17).
     *  `wedge` — telemetry says HOW the person worked; `carrier_marked` — the carrier's own
     *  commits carry an agent's trailer, so AI took part and how is unknown, and no mode is
     *  assigned; `none` — nothing says it took part. */
    ai_attribution_mix: z
      .partialRecord(z.enum(["wedge", "carrier_marked", "none"]), z.number().min(0).max(1))
      .default({}),
    /** How much of this person's work sits in a carrier kind they also work in another way
     *  (6.2 §6, §17). The transfer contour can only compare people once the relative difficulty
     *  of the carrier KINDS is identified, and it is identified through those who have both:
     *  T18 measured RMSE(b) ≤ 0.02 at a share of 10 % or more against 0.059 at zero. The own-mix
     *  contour is unaffected at any share, so this is a publication condition for the transfer
     *  contour and a diagnostic everywhere else. */
    bridge_share: z.number().min(0).max(1).default(0),
    /**
     * §11.4 — how much of the work is still standing, as a FACT.
     *
     * A carrier stands after D days when nothing reverted it and no more than
     * `survival_rewrite_threshold` of the lines it wrote were written over. It is counted from
     * the repository's own history, it enters no model, and it needs no CI — which is why it is
     * the one thing that can be said honestly about a landing nobody but its author saw.
     *
     * Three horizons rather than one, because the shape is the answer: 90 % standing at fourteen
     * days and 60 % at ninety is a different statement from either number alone. A horizon with
     * no carriers old enough to judge is absent rather than zero.
     */
    survival: z
      .strictObject({
        self_witnessed: z.array(SurvivalHorizon),
        witnessed: z.array(SurvivalHorizon),
        /** The turns a person typed before their work landed, as a median over carriers that
         *  reached a confirmed outcome. Null when no session names a carrier that landed. */
        median_prompts_to_landing: z.number().min(0).nullable(),
      })
      .meta({ id: "SurvivalBlock", title: "SurvivalBlock" })
      // Absent on snapshots written before §11.4: a passport already published must stay
      // readable, and an empty survival block is honestly empty rather than a claim of zero.
      .default({ self_witnessed: [], witnessed: [], median_prompts_to_landing: null }),
    weekly_grid: z.array(WeekCell),
    /** B3.1: the descriptive history behind the History page. Deliberately a sibling of `claims`
     *  and never merged into it — facts about what happened, with nothing gated. */
    history: HistoryBlock,
    agents: AgentsBlock,
    claims: PassportClaims,
    /** Core 7 has one claim: 1 when it is proven, else 0. */
    claims_proven: z.number().int().min(0).max(1),
    /** Always 1 under Core 7 (the claim applies to every way of working). */
    claims_total: z.literal(1),
    /** Habit facts (Core 7 §4), owner-only. Empty until a reader counted habits. */
    habits: HabitsBlock.default({ sessions_read: 0, traces: {}, editor: null }),
    /** The practice index (pi-1.0). Null on snapshots written before it existed. */
    practice_index: PracticeIndex.nullable().default(null),
    /** The mode the passport was measured in, derived from the episodes — never user-selected
     * (6.1 §10). `mixed` = both instruments inside the freshness window; `unattributed` = no
     * wedge evidence, the carrier alone. Pre-κ `delegate` covers delegate ∪ orchestrate. */
    work_mode: z.enum(["assist", "delegate", "orchestrate", "unattributed", "mixed"]),
    /** The proven claim that leads the passport; null while nothing is proven. */
    headline_claim: ClaimKey.nullable(),
    /** Distinct days of process telemetry so far — a volume, not a gate. */
    telemetry_days: nonNegativeInt,
    context_breadth: ContextBreadth,
  })
  .meta({ id: "Snapshot", title: "Snapshot" });
export type Snapshot = z.infer<typeof Snapshot>;

export const BackfillProgress = z
  .strictObject({
    phase: z.enum(["shallow", "deep", "done"]),
    days_covered: nonNegativeInt,
    days_total: nonNegativeInt,
    repositories_done: nonNegativeInt,
    repositories_total: nonNegativeInt,
    pulls_indexed: nonNegativeInt,
  })
  .meta({ id: "BackfillProgress", title: "BackfillProgress" });

/** GET /v1/me/passport — owner view. `init` = no snapshot yet (before/while backfill runs). */
export const PassportView = z
  .discriminatedUnion("status", [
    z
      .strictObject({
        status: z.literal("init"),
        /** `failed` = the backfill job dead-lettered; the UI must not claim it is done. */
        backfill: z.enum(["not_started", "queued", "running", "done", "failed"]),
        /** Per-pass progress (collector §2.1): the first 30 days are synchronous, the rest of the
         * freshness window is a background pass. Null before anything started. */
        backfill_progress: BackfillProgress.nullable(),
        metadata_collected: z.array(z.string().min(1)),
      })
      .meta({ id: "PassportInit", title: "PassportInit" }),
    z
      .strictObject({
        status: PassportStatus,
        snapshot: Snapshot,
        metadata_collected: z.array(z.string().min(1)),
      })
      .meta({ id: "PassportReady", title: "PassportReady" }),
  ])
  .meta({ id: "PassportView", title: "PassportView" });
export type PassportView = z.infer<typeof PassportView>;

// The closed list of areas of work, and the two names a company gives a task, kept in ONE place so
// that every shape that uses them shares a single definition.
//
//   * AREAS — the words a person's `history.domains` (snapshot.ts) and an episode's `evidence.areas`
//     (episode.ts) are written in. The data plane keeps a mirror of the list; a word added on one
//     side only is a snapshot the owner's dashboard refuses to parse.
//   * CompanyName and RoleTitle — the name of the company that gave a task and the title of its
//     role, as they reach a person's screen and terminal. Held to what cannot be an address, a link,
//     markup or a command.
//
// Declarative on purpose, the way task.ts is: strict shapes, limits as exported constants, no
// `.transform()`.

import { z } from "zod";

// --- areas of work ----------------------------------------------------------------------------------

/** The one vocabulary of areas of work. */
export const AREAS = [
  "backend_apis",
  "payments",
  "data_sql",
  "event_streaming",
  "infra_ci",
  "distributed_systems",
  "ml_evaluation",
  "frontend",
  "design_systems",
] as const;
export const WorkArea = z.enum(AREAS);
export type WorkArea = z.infer<typeof WorkArea>;
export const AREA_LABELS: Readonly<Record<WorkArea, string>> = {
  backend_apis: "Backend APIs",
  payments: "Payments",
  data_sql: "Data & SQL",
  event_streaming: "Event streaming",
  infra_ci: "Infrastructure & CI",
  distributed_systems: "Distributed systems",
  ml_evaluation: "ML evaluation",
  frontend: "Frontend",
  design_systems: "Design systems",
};

// --- names ------------------------------------------------------------------------------------------

/** The longest a company's name or a person's name is, in characters. */
export const COMPANY_NAME_MAX = 80;
/** The longest a role's title is, in characters. */
export const ROLE_TITLE_MAX = 80;

/** At least one character that is not whitespace: a name of spaces is not a name. */
const NOT_BLANK = /\S/;
/** No control characters (a newline in a name breaks the line it is printed on). */
const NO_CONTROL = /^[^\p{Cc}]*$/u;

/** A company's name, as the operator wrote it. */
export const CompanyName = z
  .string()
  .min(1)
  .max(COMPANY_NAME_MAX)
  .regex(NOT_BLANK)
  .regex(NO_CONTROL);
export type CompanyName = z.infer<typeof CompanyName>;

/**
 * A role's title as the company typed it. It is free text that reaches a person's screen and
 * terminal, so it is held to what cannot be an address, a link, markup or a command: no `@`, `:`,
 * `/`, `\`, `<`, `>`, quotes, backticks, pipes, `$`, `;`, braces, brackets, `=`, `*`, `~` or `^`, no
 * control characters and none of the characters that reorder the text around them (the
 * left-to-right and right-to-left marks, embeddings, overrides and isolates), which can make one
 * word read as another.
 * "Senior Backend Engineer", "ML Engineer, Evaluation", "C++ Developer (Payments)" and "Олена" pass.
 * Trimmed by the server before it is kept.
 */
const NO_LINK_OR_COMMAND = /^[^<>@:\/\\`$|;{}\[\]=*~^"‎‏‪-‮⁦-⁩]*$/;
export const RoleTitle = z
  .string()
  .min(1)
  .max(ROLE_TITLE_MAX)
  .regex(NOT_BLANK)
  .regex(NO_CONTROL)
  .regex(NO_LINK_OR_COMMAND);
export type RoleTitle = z.infer<typeof RoleTitle>;

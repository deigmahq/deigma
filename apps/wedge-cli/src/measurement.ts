/**
 * The wedge's view of the shared measurement constants.
 *
 * There is exactly ONE TypeScript mirror of the data plane's definitions, in `@mentat/schemas`,
 * and it is checked against the Python source by a test. This file used to hold a second copy of
 * the session gap — two mirrors is the same defect as no mirror, one step later.
 */

export { SESSION_IDLE_GAP_HOURS } from "@mentat/schemas";

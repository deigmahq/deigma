/**
 * The build script is plain ESM so it can run with `node` and no toolchain — but its registry
 * table is a fact the tests assert, so the table has a type and the tests read it rather than
 * repeating the two publishers a third time.
 */
export declare const REGISTRIES: Record<
  "vscode" | "openvsx",
  { publisher: string; tool: string; note: string }
>;

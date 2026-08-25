/**
 * SPEC: docs/SPEC.md — Module E, CLI:
 * `npx envcontract --target preview --project my-app [--json] [--dir .]`
 * Exit codes: 0 pass, 1 fail, 2 error.
 */

import type { RunDeps } from "./run.js";

export type CliArgs = {
  target: string;
  project: string | null;
  teamId: string | null;
  branch: string | null;
  dir: string;
  token: string | null;
  json: boolean;
  failOn: string;
  include: string[];
  exclude: string[];
  ignore: string[];
  optional: string[];
  required: string[];
  includeTests: boolean;
  help: boolean;
};

export type CliError = { message: string; exitCode: 2 };

export const USAGE = `envcontract — does this commit need config this environment doesn't have?

Usage:
  envcontract --target <production|preview|development> [options]

Options:
  --project <id|name>      Vercel project (default: auto-detect)
  --team-id <id>           Vercel team id
  --branch <name>          Branch for preview-scoped variables
  --dir <path>             Directory to scan (default: .)
  --token <token>          Vercel token (default: $VERCEL_TOKEN)
  --fail-on <missing|elsewhere|never>
  --include/--exclude <glob>
  --ignore/--optional/--required <key>
  --include-tests
  --json                   Print the JSON report instead of the text block
  --help

Exit codes: 0 pass, 1 fail, 2 error.
`;

/** Parses argv (without `node` and the script path). Throws nothing; returns a CliError. */
export function parseArgs(_argv: readonly string[]): CliArgs | CliError {
  throw new Error("not implemented");
}

/** The CLI, with injected deps and an injected writer. Returns the exit code. */
export function cli(
  _argv: readonly string[],
  _deps: RunDeps,
  _write: (line: string) => void,
): Promise<0 | 1 | 2> {
  throw new Error("not implemented");
}

/** Process wiring: builds real deps, writes to stdout, sets `process.exitCode`. */
export function cliMain(): Promise<void> {
  throw new Error("not implemented");
}

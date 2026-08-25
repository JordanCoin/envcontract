/**
 * SPEC: docs/SPEC.md — Module E `run` / Action entry, plus invariants I2 (fail
 * closed) and I4 (the PR comment is the only write).
 *
 * Every dependency is injected: `fetch`, the filesystem, the environment map,
 * the GitHub client, and the writers for the step summary, annotations and
 * outputs. `main.ts` is the only place that builds real ones.
 */

import type { FailOn, Report } from "./compare.js";
import type { Annotation } from "./report/annotations.js";
import type { FileSystemAdapter } from "./scanner/files.js";
import type { FindProjectResult, Target, VercelClient } from "./vercel/client.js";

/**
 * Raw action inputs. Every value is the string `@actions/core` hands us; parsing
 * happens inside `runEnvContract`. The key set is asserted against action.yml.
 */
export type Inputs = {
  vercel_token: string;
  target: string;
  project: string;
  team_id: string;
  branch: string;
  path: string;
  include: string;
  exclude: string;
  ignore: string;
  optional: string;
  required: string;
  fail_on: string;
  on_error: string;
  comment: string;
  github_token: string;
  license_key: string;
  report_url: string;
  include_tests: string;
};

export const INPUT_NAMES = [
  "vercel_token",
  "target",
  "project",
  "team_id",
  "branch",
  "path",
  "include",
  "exclude",
  "ignore",
  "optional",
  "required",
  "fail_on",
  "on_error",
  "comment",
  "github_token",
  "license_key",
  "report_url",
  "include_tests",
] as const satisfies readonly (keyof Inputs)[];

/** Compile-time proof that INPUT_NAMES covers every key of Inputs. */
type _InputNamesAreExhaustive =
  Exclude<keyof Inputs, (typeof INPUT_NAMES)[number]> extends never ? true : never;
const _inputNamesAreExhaustive: _InputNamesAreExhaustive = true;
void _inputNamesAreExhaustive;

export type OutputName = "status" | "missing" | "missing_count" | "report_json" | "summary";

export const OUTPUT_NAMES = [
  "status",
  "missing",
  "missing_count",
  "report_json",
  "summary",
] as const satisfies readonly OutputName[];

export type IssueComment = { id: number; body: string };

export interface GitHubDeps {
  /** `push`, `pull_request`, … */
  eventName: string;
  repo: { owner: string; repo: string };
  sha: string;
  /** The repository's default branch, used by `target: auto`. */
  defaultBranch: string;
  /** Null outside a pull request. */
  prNumber: number | null;
  listComments(prNumber: number): Promise<IssueComment[]>;
  createComment(prNumber: number, body: string): Promise<IssueComment>;
  updateComment(commentId: number, body: string): Promise<IssueComment>;
}

export interface Logger {
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface OutputWriter {
  setOutput(name: OutputName, value: string): void;
}

export interface SummaryWriter {
  write(markdown: string): Promise<void>;
}

export interface AnnotationWriter {
  emit(annotation: Annotation): void;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RunDeps = {
  fetch: FetchLike;
  fs: FileSystemAdapter;
  /** Writes the JSON report; the only file this tool creates. */
  writeFile(path: string, content: string): Promise<void>;
  /** The process environment, as data. */
  env: Record<string, string | undefined>;
  cwd: string;
  github: GitHubDeps;
  logger: Logger;
  outputs: OutputWriter;
  summary: SummaryWriter;
  annotations: AnnotationWriter;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Overrides the client built from `fetch` — used to inject a scripted client. */
  client?: VercelClient;
};

export type RunResult = {
  report: Report;
  /** 0 pass, 1 fail or error, 2 reserved for the CLI's usage errors. */
  exitCode: 0 | 1 | 2;
  markdown: string;
  annotations: Annotation[];
  outputs: Record<OutputName, string>;
};

export type ProjectSource = "input" | "env" | "project_json" | "repo_link" | "none";

export type ProjectResolution = {
  idOrName: string | null;
  source: ProjectSource;
  /** Set when the repo link matched more than one project. */
  candidates?: string[];
};

/** The whole Action, minus process wiring. Never throws for an expected failure. */
export function runEnvContract(_inputs: Inputs, _deps: RunDeps): Promise<RunResult> {
  throw new Error("not implemented");
}

/** `auto` → production on a push to the default branch, preview otherwise. */
export function resolveTarget(_inputs: Inputs, _deps: RunDeps): Target {
  throw new Error("not implemented");
}

/**
 * `branch` input → `GITHUB_HEAD_REF` → `GITHUB_REF_NAME`. A `<n>/merge` ref name
 * is an unknown branch → null.
 */
export function resolveBranch(_inputs: Inputs, _deps: RunDeps): string | null {
  throw new Error("not implemented");
}

/**
 * Precedence baked in here (refines the SPEC prose): `project` input →
 * `VERCEL_PROJECT_ID` env → `.vercel/project.json` → the Vercel repo link.
 */
export function resolveProject(
  _inputs: Inputs,
  _deps: RunDeps,
  _client: VercelClient,
): Promise<ProjectResolution> {
  throw new Error("not implemented");
}

/** `team_id` input → `VERCEL_ORG_ID` → `VERCEL_TEAM_ID` → `.vercel/project.json` orgId. */
export function resolveTeamId(_inputs: Inputs, _deps: RunDeps): Promise<string | null> {
  throw new Error("not implemented");
}

/** Splits a newline- or comma-separated action input into trimmed, non-empty entries. */
export function parseList(_raw: string): string[] {
  throw new Error("not implemented");
}

/** `true`/`false`/`1`/`0`/`yes`/`no`, case-insensitive; anything else is `fallback`. */
export function parseBoolean(_raw: string, _fallback: boolean): boolean {
  throw new Error("not implemented");
}

export function parseFailOn(_raw: string): FailOn {
  throw new Error("not implemented");
}

/** Finds the marker comment and updates it, or creates one. Failures are warnings. */
export function upsertStickyComment(_body: string, _deps: RunDeps): Promise<IssueComment | null> {
  throw new Error("not implemented");
}

/** Body is `toJSON(report)` plus `{repo, sha, target}` and nothing else. Failures are warnings. */
export function uploadReport(
  _report: Report,
  _opts: { licenseKey: string; reportUrl: string },
  _deps: RunDeps,
): Promise<boolean> {
  throw new Error("not implemented");
}

/** Reads `.vercel/project.json` if present; never throws. */
export function readVercelProjectJson(
  _deps: RunDeps,
): Promise<{ projectId?: string; orgId?: string } | null> {
  throw new Error("not implemented");
}

export type { FindProjectResult };

/**
 * SPEC: docs/SPEC.md — Module E `run` / Action entry, plus invariants I2 (fail
 * closed) and I4 (the PR comment is the only write).
 *
 * Every dependency is injected: `fetch`, the filesystem, the environment map,
 * the GitHub client, and the writers for the step summary, annotations and
 * outputs. `main.ts` is the only place that builds real ones.
 */

import os from "node:os";
import path from "node:path";

import { compare, type FailOn, type Report, type ReportCounts } from "./compare.js";
import { renderAnnotations, type Annotation } from "./report/annotations.js";
import { toJSON } from "./report/json.js";
import { renderMarkdown } from "./report/markdown.js";
import { parseEnvExamples, type DeclaredMap } from "./scanner/envfile.js";
import {
  collectFiles,
  readSourceFiles,
  type FileSystemAdapter,
  type ScanDirectoryOptions,
} from "./scanner/files.js";
import { scanFiles, type ScanResult } from "./scanner/scanner.js";
import {
  createVercelClient,
  TARGETS,
  type EnvVar,
  type FindProjectResult,
  type Target,
  type VercelClient,
  type VercelClientOptions,
} from "./vercel/client.js";
import { USER_AGENT, VERSION } from "./version.js";

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

/** Where a licensed report is posted when the input is left empty. */
export const DEFAULT_REPORT_URL = "https://envcontract.vercel.app/api/report";

/** The single file this tool writes. */
export const REPORT_FILE_NAME = "envcontract-report.json";

/** `<n>/merge` — the ref name GitHub invents for a PR merge commit. Not a branch. */
const MERGE_REF = /^\d+\/merge$/;

/** The report upload gets the same 15s ceiling as a Vercel request. */
const UPLOAD_TIMEOUT_MS = 15_000;

const TRUE_WORDS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "n", "off"]);

/* ----------------------------------------------------------------- parsing */

/** Splits a newline- or comma-separated action input into trimmed, non-empty entries. */
export function parseList(raw: string): string[] {
  return raw
    .split(/[,\r\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** `true`/`false`/`1`/`0`/`yes`/`no`, case-insensitive; anything else is `fallback`. */
export function parseBoolean(raw: string, fallback: boolean): boolean {
  const word = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return fallback;
}

export function parseFailOn(raw: string): FailOn {
  const word = raw.trim().toLowerCase();
  if (word === "missing" || word === "elsewhere" || word === "never") return word;
  return "elsewhere";
}

function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

/**
 * `auto` → production on a push to the default branch, preview otherwise.
 * Returns null for a target string that is not one of the four documented words.
 */
function resolveTargetOrNull(inputs: Inputs, deps: RunDeps): Target | null {
  const word = inputs.target.trim().toLowerCase();
  if (word === "") return "preview";
  if (word === "auto") {
    const ref = (deps.env["GITHUB_REF_NAME"] ?? "").trim();
    const onDefaultBranch = ref !== "" && ref === deps.github.defaultBranch;
    return deps.github.eventName === "push" && onDefaultBranch ? "production" : "preview";
  }
  return isTarget(word) ? word : null;
}

/** `auto` → production on a push to the default branch, preview otherwise. */
export function resolveTarget(inputs: Inputs, deps: RunDeps): Target {
  const target = resolveTargetOrNull(inputs, deps);
  if (target === null) throw new Error(unknownTargetMessage(inputs.target));
  return target;
}

function unknownTargetMessage(raw: string): string {
  return `Unknown target "${raw.trim()}". Use production, preview, development, or auto.`;
}

/**
 * `branch` input → `GITHUB_HEAD_REF` → `GITHUB_REF_NAME`. A `<n>/merge` ref name
 * is an unknown branch → null.
 */
export function resolveBranch(inputs: Inputs, deps: RunDeps): string | null {
  const fromInput = inputs.branch.trim();
  if (fromInput !== "") return fromInput;

  const headRef = (deps.env["GITHUB_HEAD_REF"] ?? "").trim();
  if (headRef !== "") return headRef;

  const refName = (deps.env["GITHUB_REF_NAME"] ?? "").trim();
  if (refName === "" || MERGE_REF.test(refName)) return null;
  return refName;
}

/* -------------------------------------------------------------- resolution */

/** Reads `.vercel/project.json` if present; never throws. */
export async function readVercelProjectJson(
  deps: RunDeps,
): Promise<{ projectId?: string; orgId?: string } | null> {
  const file = path.join(deps.cwd, ".vercel", "project.json");

  let raw: string;
  try {
    raw = (await deps.fs.readFile(file)).toString("utf8");
  } catch {
    // Absent or unreadable is the normal case outside a `vercel link`ed repo.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    deps.logger.debug(`Ignoring ${file}: it is not valid JSON.`);
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const out: { projectId?: string; orgId?: string } = {};
  if (typeof record["projectId"] === "string") out.projectId = record["projectId"];
  if (typeof record["orgId"] === "string") out.orgId = record["orgId"];
  return out;
}

/**
 * Precedence baked in here (refines the SPEC prose): `project` input →
 * `VERCEL_PROJECT_ID` env → `.vercel/project.json` → the Vercel repo link.
 */
export async function resolveProject(
  inputs: Inputs,
  deps: RunDeps,
  client: VercelClient,
): Promise<ProjectResolution> {
  const fromInput = inputs.project.trim();
  if (fromInput !== "") return { idOrName: fromInput, source: "input" };

  const fromEnv = (deps.env["VERCEL_PROJECT_ID"] ?? "").trim();
  if (fromEnv !== "") return { idOrName: fromEnv, source: "env" };

  const linked = await readVercelProjectJson(deps);
  const fromJson = (linked?.projectId ?? "").trim();
  if (fromJson !== "") return { idOrName: fromJson, source: "project_json" };

  const { owner, repo } = deps.github.repo;
  if (owner !== "" && repo !== "") {
    const found = await client.findProject({ repo: `${owner}/${repo}` });
    if (found !== null && "error" in found) {
      return { idOrName: null, source: "none", candidates: found.candidates };
    }
    if (found !== null) return { idOrName: found.id, source: "repo_link" };
  }

  return { idOrName: null, source: "none" };
}

/** `team_id` input → `VERCEL_ORG_ID` → `VERCEL_TEAM_ID` → `.vercel/project.json` orgId. */
export async function resolveTeamId(inputs: Inputs, deps: RunDeps): Promise<string | null> {
  const fromInput = inputs.team_id.trim();
  if (fromInput !== "") return fromInput;

  const fromOrgId = (deps.env["VERCEL_ORG_ID"] ?? "").trim();
  if (fromOrgId !== "") return fromOrgId;

  const fromTeamId = (deps.env["VERCEL_TEAM_ID"] ?? "").trim();
  if (fromTeamId !== "") return fromTeamId;

  const linked = await readVercelProjectJson(deps);
  const fromJson = (linked?.orgId ?? "").trim();
  if (fromJson !== "") return fromJson;

  return null;
}

/* ------------------------------------------------------------------ writes */

/** Finds the marker comment and updates it, or creates one. Failures are warnings. */
export async function upsertStickyComment(
  body: string,
  deps: RunDeps,
): Promise<IssueComment | null> {
  const prNumber = deps.github.prNumber;
  if (prNumber === null) return null;

  const marker = firstLine(body);

  let existing: IssueComment | undefined;
  try {
    const comments = await deps.github.listComments(prNumber);
    existing = comments.find((comment) => comment.body.includes(marker));
  } catch (error) {
    deps.logger.warning(
      `Could not read the pull request comments, so the sticky comment was skipped: ${describe(error)}`,
    );
    return null;
  }

  try {
    if (existing !== undefined) return await deps.github.updateComment(existing.id, body);
    return await deps.github.createComment(prNumber, body);
  } catch (error) {
    deps.logger.warning(
      `Could not post the pull request comment (the check result is unaffected): ${describe(error)}`,
    );
    return null;
  }
}

/** Body is `toJSON(report)` plus `{repo, sha, target}` and nothing else. Failures are warnings. */
export async function uploadReport(
  report: Report,
  opts: { licenseKey: string; reportUrl: string },
  deps: RunDeps,
): Promise<boolean> {
  const { owner, repo } = deps.github.repo;
  // I1: an allow-listed projection plus three identifiers. Nothing else is sent.
  const body = JSON.stringify({
    repo: `${owner}/${repo}`,
    sha: deps.github.sha,
    target: report.target,
    report: toJSON(report),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const response = await deps.fetch(opts.reportUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.licenseKey}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      deps.logger.warning(
        `The report upload was rejected (HTTP ${response.status}); the check result is unaffected.`,
      );
      return false;
    }
    return true;
  } catch (error) {
    deps.logger.warning(
      `The report upload failed (the check result is unaffected): ${describe(error)}`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------- scan */

async function scanRepository(
  inputs: Inputs,
  deps: RunDeps,
): Promise<{ scan: ScanResult; declared: DeclaredMap }> {
  const requested = inputs.path.trim() === "" ? "." : inputs.path.trim();
  const root = path.isAbsolute(requested) ? requested : path.resolve(deps.cwd, requested);

  const options: ScanDirectoryOptions = {
    include: parseList(inputs.include),
    exclude: parseList(inputs.exclude),
    includeTests: parseBoolean(inputs.include_tests, false),
    fs: deps.fs,
  };

  const collected = await collectFiles(root, options);
  const code = collected.files.filter((file) => file.kind === "code");
  const examples = collected.files.filter((file) => file.kind === "env-example");

  const readCode = await readSourceFiles(code, options);
  const readExamples = await readSourceFiles(examples, options);

  const scanned = scanFiles(readCode.sources, {});
  const parsed = parseEnvExamples(readExamples.sources);

  const warnings = [
    ...collected.warnings,
    ...readCode.warnings,
    ...readExamples.warnings,
    ...scanned.warnings,
    ...parsed.warnings,
  ];
  for (const warning of warnings) {
    deps.logger.debug(`${warning.file}:${warning.line} ${warning.code}: ${warning.message}`);
  }

  return { scan: { ...scanned, warnings }, declared: parsed.declared };
}

/**
 * A key declared in `.env.example` but never referenced in code is a stale
 * declaration only when the environment does not configure it either. When
 * Vercel already has the key the deployment is fine, so there is nothing to
 * tell the user about — reporting it would be noise, not a finding.
 */
function pruneDeclared(
  declared: DeclaredMap,
  scan: ScanResult,
  env: readonly EnvVar[],
): DeclaredMap {
  const configured = new Set(env.map((entry) => entry.key));
  const kept: DeclaredMap = new Map();
  for (const [key, entry] of declared) {
    if (!scan.keys.has(key) && configured.has(key)) continue;
    kept.set(key, entry);
  }
  return kept;
}

/* ------------------------------------------------------------------ runner */

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** I1: belt and braces — a token can never survive into anything we emit. */
function redactToken(message: string, token: string): string {
  const secret = token.trim();
  if (secret.length === 0 || !message.includes(secret)) return message;
  return message.split(secret).join("[redacted]");
}

function firstLine(text: string): string {
  const end = text.indexOf("\n");
  return end === -1 ? text : text.slice(0, end);
}

function emptyCounts(): ReportCounts {
  return { missing: 0, missing_optional: 0, present: 0, elsewhere: 0, unused: 0, dynamic: 0 };
}

function errorReport(target: Target, branch: string | null): Report {
  return {
    status: "error",
    target,
    branch,
    counts: emptyCounts(),
    findings: [],
    dynamicAccess: 0,
    version: VERSION,
  };
}

type Settings = {
  onErrorWarn: boolean;
  licenseKey: string;
  reportUrl: string;
  comment: boolean;
};

function readSettings(inputs: Inputs, deps: RunDeps): Settings {
  // A comment needs somewhere to go (a pull request), something to post with (a
  // token), and permission (the input). Anything less and the run stays silent.
  const onPullRequest =
    deps.github.eventName.startsWith("pull_request") && deps.github.prNumber !== null;
  return {
    onErrorWarn: inputs.on_error.trim().toLowerCase() === "warn",
    licenseKey: inputs.license_key.trim(),
    reportUrl: inputs.report_url.trim() === "" ? DEFAULT_REPORT_URL : inputs.report_url.trim(),
    comment: parseBoolean(inputs.comment, true) && inputs.github_token.trim() !== "" && onPullRequest,
  };
}

/**
 * The one place a finished report turns into everything a run emits: the step
 * summary, the annotations, the outputs, the JSON file, the sticky comment and
 * (when licensed) the upload. I1 holds because every one of these is derived
 * from `report`, which the Vercel boundary already stripped of values.
 */
async function emitReport(
  report: Report,
  settings: Settings,
  deps: RunDeps,
): Promise<RunResult> {
  const markdown = renderMarkdown(report, { licensed: settings.licenseKey !== "" });
  const annotations = renderAnnotations(report);
  for (const annotation of annotations) deps.annotations.emit(annotation);

  // A step summary is a courtesy, never a verdict: a read-only summary file
  // must not turn a passing check red.
  try {
    await deps.summary.write(markdown);
  } catch (error) {
    deps.logger.warning(`Could not write the step summary: ${describe(error)}`);
  }

  const missing = report.findings
    .filter((finding) => finding.status === "missing")
    .map((finding) => finding.key);

  const reportDirectory = (deps.env["RUNNER_TEMP"] ?? "").trim() || os.tmpdir();
  const reportPath = path.join(reportDirectory, REPORT_FILE_NAME);
  let writtenPath = reportPath;
  try {
    await deps.writeFile(reportPath, `${JSON.stringify(toJSON(report), null, 2)}\n`);
  } catch (error) {
    writtenPath = "";
    deps.logger.warning(`Could not write the JSON report: ${describe(error)}`);
  }

  const outputs: Record<OutputName, string> = {
    status: report.status,
    missing: missing.join(","),
    missing_count: String(missing.length),
    report_json: writtenPath,
    summary: markdown,
  };
  for (const name of OUTPUT_NAMES) deps.outputs.setOutput(name, outputs[name]);

  if (settings.comment) await upsertStickyComment(markdown, deps);
  if (settings.licenseKey !== "") {
    await uploadReport(
      report,
      { licenseKey: settings.licenseKey, reportUrl: settings.reportUrl },
      deps,
    );
  }

  // I2: only an explicit `on_error: warn` may turn a broken run green.
  const exitCode: 0 | 1 | 2 =
    report.status === "pass" ? 0 : report.status === "error" && settings.onErrorWarn ? 0 : 1;

  return { report, exitCode, markdown, annotations, outputs };
}

/** The whole Action, minus process wiring. Never throws for an expected failure. */
export async function runEnvContract(inputs: Inputs, deps: RunDeps): Promise<RunResult> {
  const settings = readSettings(inputs, deps);
  const branch = resolveBranch(inputs, deps);

  const fail = async (message: string, target: Target): Promise<RunResult> => {
    const safe = redactToken(message, inputs.vercel_token);
    if (settings.onErrorWarn) deps.logger.warning(safe);
    else deps.logger.error(safe);
    return await emitReport(errorReport(target, branch), settings, deps);
  };

  const target = resolveTargetOrNull(inputs, deps);
  if (target === null) return await fail(unknownTargetMessage(inputs.target), "preview");

  try {
    const teamId = await resolveTeamId(inputs, deps);
    const clientOptions: VercelClientOptions = {
      token: inputs.vercel_token,
      fetch: deps.fetch,
    };
    if (teamId !== null) clientOptions.teamId = teamId;
    if (deps.sleep !== undefined) clientOptions.sleep = deps.sleep;
    if (deps.now !== undefined) clientOptions.now = deps.now;
    const client = deps.client ?? createVercelClient(clientOptions);

    const project = await resolveProject(inputs, deps, client);
    if (project.idOrName === null) {
      if (project.candidates !== undefined && project.candidates.length > 0) {
        return await fail(
          `The repository is linked to more than one Vercel project (${project.candidates.join(", ")}). Set the \`project\` input to the one to check.`,
          target,
        );
      }
      return await fail(
        "Could not work out which Vercel project to check. Set the `project` input, the VERCEL_PROJECT_ID environment variable, or link the repository in Vercel.",
        target,
      );
    }

    // No `gitBranch` filter: branch scoping is decided locally, so a variable
    // that exists only for another branch can still be reported as `elsewhere`.
    const env = await client.listEnv(project.idOrName, {});

    const { scan, declared } = await scanRepository(inputs, deps);

    const report = compare(scan, pruneDeclared(declared, scan, env), env, {
      target,
      branch: branch ?? undefined,
      ignore: parseList(inputs.ignore),
      optional: parseList(inputs.optional),
      required: parseList(inputs.required),
      failOn: parseFailOn(inputs.fail_on),
    });

    return await emitReport(report, settings, deps);
  } catch (error) {
    return await fail(describe(error), target);
  }
}

export type { FindProjectResult };

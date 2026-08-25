/**
 * SPEC: docs/SPEC.md — Module C `compare` (pure).
 */

import type { DeclaredMap } from "./scanner/envfile.js";
import type { ScanResult } from "./scanner/scanner.js";
import type { EnvVar, Target } from "./vercel/client.js";
import { VERSION } from "./version.js";

export type FindingStatus =
  | "missing"
  | "missing_optional"
  | "present"
  | "elsewhere"
  | "unused"
  | "ignored";

export type FindingSite = { file: string; line: number };

export type Finding = {
  key: string;
  status: FindingStatus;
  /** Human sentence for `elsewhere` ("in Production only"); omitted otherwise. */
  detail?: string;
  /** Sorted by file, then line. Empty for keys that only exist in `.env.example`. */
  sites: FindingSite[];
  /** Targets the key was actually found in, in production/preview/development order. */
  foundIn: Target[];
};

export type ReportCounts = {
  missing: number;
  missing_optional: number;
  present: number;
  elsewhere: number;
  unused: number;
  dynamic: number;
};

export type ReportStatus = "pass" | "fail" | "error";

/** Which statuses fail the run. `elsewhere` (default) fails on missing + elsewhere. */
export type FailOn = "missing" | "elsewhere" | "never";

export type Report = {
  status: ReportStatus;
  target: Target;
  branch: string | null;
  counts: ReportCounts;
  /** Sorted: missing → missing_optional → elsewhere → unused → present → ignored, then key asc. */
  findings: Finding[];
  dynamicAccess: number;
  version: string;
};

export type CompareOptions = {
  target: Target;
  branch?: string | undefined;
  customEnvironmentId?: string | undefined;
  ignore: readonly string[];
  optional: readonly string[];
  required: readonly string[];
  /** Defaults to `"elsewhere"`. */
  failOn?: FailOn;
};

/** The order findings are grouped in. */
export const FINDING_ORDER: readonly FindingStatus[] = [
  "missing",
  "missing_optional",
  "elsewhere",
  "unused",
  "present",
  "ignored",
];

/** production → preview → development, the canonical order everything is emitted in. */
const TARGET_ORDER: readonly Target[] = ["production", "preview", "development"];

const TARGET_LABELS: Record<Target, string> = {
  production: "Production",
  preview: "Preview",
  development: "Development",
};

/** Code-unit ordering — locale-independent, so the output is byte-stable (I3). */
function byString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact key, or a `PREFIX_*` glob. `*` matches any run of characters. */
export function matchesPattern(pattern: string, key: string): boolean {
  if (!pattern.includes("*")) return pattern === key;
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`).test(key);
}

function matchesAny(patterns: readonly string[], key: string): boolean {
  for (const pattern of patterns) {
    if (matchesPattern(pattern, key)) return true;
  }
  return false;
}

/**
 * SPEC presence rule: present for `target` iff `targets` includes it (or the
 * given customEnvironmentId is listed) AND (`gitBranch` is null OR (target is
 * preview AND gitBranch === branch)). A non-preview var carrying a gitBranch is
 * treated as present.
 */
export function isPresent(
  envVar: EnvVar,
  opts: { target: Target; branch?: string | undefined; customEnvironmentId?: string | undefined },
): boolean {
  const inTargets = envVar.targets.includes(opts.target);
  const inCustomEnv =
    opts.customEnvironmentId !== undefined &&
    envVar.customEnvironmentIds.includes(opts.customEnvironmentId);
  if (!inTargets && !inCustomEnv) return false;
  if (envVar.gitBranch === null) return true;
  if (opts.target !== "preview") return true;
  return envVar.gitBranch === opts.branch;
}

/** The targets a key exists in at all, ignoring the requested target. */
export function targetsFor(key: string, env: readonly EnvVar[]): Target[] {
  const seen = new Set<Target>();
  for (const envVar of env) {
    if (envVar.key !== key) continue;
    for (const target of envVar.targets) seen.add(target);
  }
  return TARGET_ORDER.filter((target) => seen.has(target));
}

/** The branches a key is pinned to on preview, sorted and de-duplicated. */
function previewBranchesFor(key: string, env: readonly EnvVar[]): string[] {
  const branches = new Set<string>();
  for (const envVar of env) {
    if (envVar.key !== key) continue;
    if (!envVar.targets.includes("preview")) continue;
    if (envVar.gitBranch !== null) branches.add(envVar.gitBranch);
  }
  return [...branches].sort(byString);
}

/** "in Production only", "in Preview for branch `staging` only", "in Production and Development". */
export function describeElsewhere(key: string, env: readonly EnvVar[]): string {
  const targets = targetsFor(key, env);
  if (targets.length === 0) return "";

  if (targets.length === 1 && targets[0] === "preview") {
    const branch = previewBranchesFor(key, env)[0];
    if (branch !== undefined) return `in Preview for branch \`${branch}\` only`;
  }

  const labels = targets.map((target) => TARGET_LABELS[target]);
  if (labels.length === 1) return `in ${labels[0]} only`;

  const last = labels[labels.length - 1];
  const head = labels.slice(0, -1).join(", ");
  return `in ${head} and ${last}`;
}

/** Which finding statuses fail under a `fail_on` setting. */
export function failingStatuses(failOn: FailOn): FindingStatus[] {
  if (failOn === "never") return [];
  if (failOn === "missing") return ["missing"];
  return ["missing", "elsewhere"];
}

function sitesFor(scan: ScanResult, key: string): FindingSite[] {
  const info = scan.keys.get(key);
  if (!info) return [];
  return [...info.sites]
    .sort((a, b) => byString(a.file, b.file) || a.line - b.line || a.col - b.col)
    .map((reference) => ({ file: reference.file, line: reference.line }));
}

export function compare(
  scan: ScanResult,
  declared: DeclaredMap,
  env: readonly EnvVar[],
  opts: CompareOptions,
): Report {
  const presenceOpts: {
    target: Target;
    branch?: string | undefined;
    customEnvironmentId?: string | undefined;
  } = { target: opts.target, branch: opts.branch, customEnvironmentId: opts.customEnvironmentId };

  const keys = new Set<string>();
  for (const key of scan.keys.keys()) keys.add(key);
  for (const key of declared.keys()) keys.add(key);
  // A literal `required` entry pulls a key into the report even when nothing
  // else mentions it. A glob cannot conjure a key name, so it is skipped here.
  for (const pattern of opts.required) {
    if (!pattern.includes("*")) keys.add(pattern);
  }

  const findings: Finding[] = [];

  for (const key of [...keys].sort(byString)) {
    const sites = sitesFor(scan, key);
    const foundIn = targetsFor(key, env);

    if (matchesAny(opts.ignore, key)) {
      findings.push({ key, status: "ignored", sites, foundIn });
      continue;
    }

    const inCode = scan.keys.has(key);
    const declaration = declared.get(key);
    const forcedRequired = matchesAny(opts.required, key);
    const forcedOptional = matchesAny(opts.optional, key);

    // Declared in `.env.example` but never dereferenced: informational only,
    // unless the user explicitly demanded the key.
    if (!inCode && !forcedRequired && declaration !== undefined) {
      findings.push({ key, status: "unused", sites, foundIn });
      continue;
    }

    let required: boolean;
    if (forcedRequired) required = true;
    else if (forcedOptional) required = false;
    else if (inCode) required = scan.keys.get(key)?.required ?? true;
    else if (declaration !== undefined) required = !declaration.optional;
    else required = true;

    const present = env.some(
      (envVar) => envVar.key === key && isPresent(envVar, presenceOpts),
    );

    if (present) {
      findings.push({ key, status: "present", sites, foundIn });
    } else if (!required) {
      findings.push({ key, status: "missing_optional", sites, foundIn });
    } else if (foundIn.length > 0) {
      findings.push({
        key,
        status: "elsewhere",
        detail: describeElsewhere(key, env),
        sites,
        foundIn,
      });
    } else {
      findings.push({ key, status: "missing", sites, foundIn });
    }
  }

  findings.sort(
    (a, b) =>
      FINDING_ORDER.indexOf(a.status) - FINDING_ORDER.indexOf(b.status) || byString(a.key, b.key),
  );

  const counts: ReportCounts = {
    missing: 0,
    missing_optional: 0,
    present: 0,
    elsewhere: 0,
    unused: 0,
    dynamic: scan.dynamicAccess.length,
  };
  for (const finding of findings) {
    if (finding.status === "missing") counts.missing += 1;
    else if (finding.status === "missing_optional") counts.missing_optional += 1;
    else if (finding.status === "present") counts.present += 1;
    else if (finding.status === "elsewhere") counts.elsewhere += 1;
    else if (finding.status === "unused") counts.unused += 1;
  }

  const failing = new Set<FindingStatus>(failingStatuses(opts.failOn ?? "elsewhere"));
  const failed = findings.some((finding) => failing.has(finding.status));

  return {
    status: failed ? "fail" : "pass",
    target: opts.target,
    branch: opts.branch ?? null,
    counts,
    findings,
    dynamicAccess: scan.dynamicAccess.length,
    version: VERSION,
  };
}

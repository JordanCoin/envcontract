/**
 * SPEC: docs/SPEC.md — Module C `compare` (pure).
 */

import type { DeclaredMap } from "./scanner/envfile.js";
import type { ScanResult } from "./scanner/scanner.js";
import type { EnvVar, Target } from "./vercel/client.js";

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

/**
 * SPEC presence rule: present for `target` iff `targets` includes it (or the
 * given customEnvironmentId is listed) AND (`gitBranch` is null OR (target is
 * preview AND gitBranch === branch)). A non-preview var carrying a gitBranch is
 * treated as present.
 */
export function isPresent(
  _envVar: EnvVar,
  _opts: { target: Target; branch?: string | undefined; customEnvironmentId?: string | undefined },
): boolean {
  throw new Error("not implemented");
}

/** The targets a key exists in at all, ignoring the requested target. */
export function targetsFor(_key: string, _env: readonly EnvVar[]): Target[] {
  throw new Error("not implemented");
}

/** "in Production only", "in Preview for branch `staging` only", "in Production and Development". */
export function describeElsewhere(_key: string, _env: readonly EnvVar[]): string {
  throw new Error("not implemented");
}

/** Which finding statuses fail under a `fail_on` setting. */
export function failingStatuses(_failOn: FailOn): FindingStatus[] {
  throw new Error("not implemented");
}

export function compare(
  _scan: ScanResult,
  _declared: DeclaredMap,
  _env: readonly EnvVar[],
  _opts: CompareOptions,
): Report {
  throw new Error("not implemented");
}

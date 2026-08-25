/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `toJSON` + invariant I3
 * (deterministic: sorted keys, stable ordering, no timestamps).
 */

import type { Report } from "../compare.js";
import { safeFindings } from "./format.js";

export type JsonFinding = {
  key: string;
  status: string;
  detail?: string;
  sites: { file: string; line: number }[];
  foundIn: string[];
};

export type JsonReport = {
  branch: string | null;
  counts: { [k: string]: number };
  dynamicAccess: number;
  findings: JsonFinding[];
  status: string;
  target: string;
  version: string;
};

/** The only count names that survive the projection, already in ascending order. */
const COUNT_KEYS = [
  "dynamic",
  "elsewhere",
  "missing",
  "missing_optional",
  "present",
  "unused",
] as const;

/** Allow-listed projection. Any field not named here — `value` above all — is dropped. */
export function toJSON(report: Report): JsonReport {
  const counts: { [k: string]: number } = {};
  for (const name of COUNT_KEYS) {
    counts[name] = Number(report.counts?.[name] ?? 0);
  }

  const findings: JsonFinding[] = safeFindings(report).map((finding) => {
    // Object keys are written in ascending order so JSON.stringify is stable.
    const rest = {
      foundIn: finding.foundIn.map((target) => String(target)),
      key: finding.key,
      sites: finding.sites.map((site) => ({ file: site.file, line: site.line })),
      status: String(finding.status),
    };
    if (finding.detail !== "") return { detail: finding.detail, ...rest };
    return rest;
  });

  return {
    branch: report.branch === null || report.branch === undefined ? null : String(report.branch),
    counts,
    dynamicAccess: Number(report.dynamicAccess ?? 0),
    findings,
    status: String(report.status),
    target: String(report.target),
    version: String(report.version),
  };
}

/** `JSON.stringify(toJSON(r))` with deterministic key order. */
export function stringifyReport(report: Report): string {
  return JSON.stringify(toJSON(report));
}

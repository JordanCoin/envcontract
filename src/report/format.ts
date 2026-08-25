/**
 * Private helpers shared by the Module D renderers. Not part of the public API.
 *
 * Every renderer reads findings through the allow-list accessors here, so a
 * field planted upstream (a `value`, above all) can never reach an output (I1).
 */

import type { Finding, FindingStatus, Report, ReportStatus } from "../compare.js";
import type { Target } from "../vercel/client.js";

export const KNOWN_TARGETS: readonly Target[] = ["production", "preview", "development"];

export const TARGET_LABELS: Record<string, string> = {
  production: "Production",
  preview: "Preview",
  development: "Development",
};

/** "preview" → "Preview". Falls back to capitalising an unexpected target. */
export function targetLabel(target: string): string {
  const known = TARGET_LABELS[target];
  if (known !== undefined) return known;
  return target.charAt(0).toUpperCase() + target.slice(1);
}

export const STATUS_EMOJI: Record<FindingStatus, string> = {
  missing: "🔴",
  missing_optional: "🟡",
  elsewhere: "🟡",
  unused: "ℹ️",
  present: "✅",
  ignored: "ℹ️",
};

/** Statuses that describe a problem worth naming in a rendered body. */
export const REPORTABLE: readonly FindingStatus[] = [
  "missing",
  "missing_optional",
  "elsewhere",
  "unused",
];

export function isReportable(status: FindingStatus): boolean {
  return REPORTABLE.includes(status);
}

export function readinessWord(status: ReportStatus): string {
  if (status === "fail") return "FAIL";
  if (status === "error") return "ERROR";
  return "PASS";
}

/* -------------------------------------------------------------- allow-lists */

export type SafeSite = { file: string; line: number };

export type SafeFinding = {
  key: string;
  status: FindingStatus;
  detail: string;
  sites: SafeSite[];
  foundIn: Target[];
};

/** Copies exactly the five fields a renderer may read. Everything else is dropped. */
export function safeFinding(finding: Finding): SafeFinding {
  const sites: SafeSite[] = [];
  for (const site of finding.sites ?? []) {
    sites.push({ file: String(site.file), line: Number(site.line) });
  }
  const found = finding.foundIn ?? [];
  return {
    key: String(finding.key),
    status: finding.status,
    detail: typeof finding.detail === "string" ? finding.detail : "",
    sites,
    foundIn: KNOWN_TARGETS.filter((target) => found.includes(target)),
  };
}

export function safeFindings(report: Report): SafeFinding[] {
  return (report.findings ?? []).map(safeFinding);
}

/** The first site as `file:line`, or undefined when a finding has no site. */
export function firstSite(finding: SafeFinding): SafeSite | undefined {
  return finding.sites[0];
}

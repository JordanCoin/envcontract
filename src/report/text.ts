/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `renderText` (the CLI block).
 */

import type { Report } from "../compare.js";
import {
  firstSite,
  readinessWord,
  safeFindings,
  STATUS_EMOJI,
  targetLabel,
  type SafeFinding,
} from "./format.js";

function location(finding: SafeFinding): string {
  const site = firstSite(finding);
  if (!site) return "";
  return `  (${site.file}:${site.line})`;
}

function lineFor(finding: SafeFinding, target: string): string | null {
  const emoji = STATUS_EMOJI[finding.status];
  const where = location(finding);

  switch (finding.status) {
    case "missing":
      return `${emoji} ${finding.key} referenced but missing from ${target}${where}`;
    case "missing_optional":
      return `${emoji} ${finding.key} optional, missing from ${target}${where}`;
    case "elsewhere": {
      const detail = finding.detail === "" ? "" : ` ${finding.detail}`;
      return `${emoji} ${finding.key} exists${detail}${where}`;
    }
    case "unused":
      return `${emoji} ${finding.key} declared but never referenced${where}`;
    default:
      return null;
  }
}

export function renderText(report: Report): string {
  const target = targetLabel(report.target);
  const lines: string[] = [];

  for (const finding of safeFindings(report)) {
    const line = lineFor(finding, target);
    if (line !== null) lines.push(line);
  }

  const present = Number(report.counts?.present ?? 0);
  if (present > 0) {
    const noun = present === 1 ? "variable" : "variables";
    lines.push(`✅ ${present} other required ${noun} covered`);
  }

  lines.push(`Environment readiness: ${readinessWord(report.status)}`);
  return lines.join("\n");
}

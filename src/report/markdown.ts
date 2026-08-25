/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `renderMarkdown`.
 */

import type { Report } from "../compare.js";
import {
  firstSite,
  isReportable,
  readinessWord,
  safeFindings,
  STATUS_EMOJI,
  targetLabel,
  type SafeFinding,
} from "./format.js";

/** First line of every rendered body — the sticky-comment lookup key. */
export const REPORT_MARKER = "<!-- envcontract:report -->";

/** Present keys are collapsed into a `<details>` block above this count. */
export const PRESENT_DETAILS_THRESHOLD = 10;

export const FOOTER_TEXT =
  "Continuously monitor every environment → https://envcontract.vercel.app";

export type MarkdownOptions = {
  /** When true the free footer is omitted. */
  licensed?: boolean;
};

const HEADER_BADGE: Record<string, string> = {
  pass: "✅ PASS",
  fail: "🔴 FAIL",
  error: "⚠️ ERROR",
};

const STATUS_LABEL: Record<string, string> = {
  missing: "Missing",
  missing_optional: "Missing (optional)",
  elsewhere: "Elsewhere",
  unused: "Unused",
};

/** Neither a pipe nor a backtick may escape a table cell and break the layout. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/`/g, "\\`");
}

function statusText(finding: SafeFinding): string {
  const label = STATUS_LABEL[finding.status] ?? finding.status;
  if (finding.status === "elsewhere" && finding.detail !== "") {
    return `${label} — ${finding.detail}`;
  }
  return label;
}

function referencedAt(finding: SafeFinding): string {
  const site = firstSite(finding);
  if (!site) return "—";
  const extra = finding.sites.length - 1;
  const suffix = extra > 0 ? ` +${extra} more` : "";
  return `${cell(site.file)}:${site.line}${suffix}`;
}

export function renderMarkdown(report: Report, opts?: MarkdownOptions): string {
  const findings = safeFindings(report);
  const problems = findings.filter((finding) => isReportable(finding.status));
  const present = findings.filter((finding) => finding.status === "present");

  const target = targetLabel(report.target);
  const badge = HEADER_BADGE[report.status] ?? readinessWord(report.status);

  const lines: string[] = [REPORT_MARKER, `## EnvContract — ${target} readiness: ${badge}`];

  if (report.branch !== null && report.branch !== undefined && report.branch !== "") {
    lines.push("", `Branch \`${cell(String(report.branch))}\``);
  }

  if (problems.length > 0) {
    lines.push("", "| | Key | Status | Referenced at |", "| --- | --- | --- | --- |");
    for (const finding of problems) {
      const emoji = STATUS_EMOJI[finding.status];
      lines.push(
        `| ${emoji} | \`${cell(finding.key)}\` | ${cell(statusText(finding))} | ${referencedAt(finding)} |`,
      );
    }
  }

  if (present.length > 0) {
    const bullets = present.map((finding) => `- \`${cell(finding.key)}\``);
    if (present.length > PRESENT_DETAILS_THRESHOLD) {
      lines.push(
        "",
        "<details>",
        `<summary>${present.length} keys present in ${target}</summary>`,
        "",
        ...bullets,
        "",
        "</details>",
      );
    } else {
      lines.push("", `${present.length} keys present in ${target}:`, "", ...bullets);
    }
  }

  if (opts?.licensed !== true) {
    lines.push("", FOOTER_TEXT);
  }

  return lines.join("\n");
}

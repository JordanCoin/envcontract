/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `renderAnnotations`.
 */

import type { Report } from "../compare.js";
import { firstSite, safeFindings, targetLabel, type SafeFinding } from "./format.js";

export type AnnotationLevel = "error" | "warning" | "notice";

export type Annotation = {
  level: AnnotationLevel;
  file: string;
  line: number;
  title: string;
  /** Never longer than MAX_ANNOTATION_MESSAGE. */
  message: string;
};

export const MAX_ANNOTATION_MESSAGE = 200;

/** Levels are static: they never vary with the report status or `fail_on`. */
const LEVELS: Record<string, AnnotationLevel> = {
  missing: "error",
  elsewhere: "warning",
  missing_optional: "warning",
};

/** Collapses newlines and clips to the cap, ending in an ellipsis when clipped. */
function clip(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_ANNOTATION_MESSAGE) return flat;
  return `${flat.slice(0, MAX_ANNOTATION_MESSAGE - 1)}…`;
}

function messageFor(finding: SafeFinding, target: string): string {
  if (finding.status === "elsewhere") {
    const detail = finding.detail === "" ? "another environment" : finding.detail;
    return clip(`${finding.key} is missing from ${target}; it exists ${detail}.`);
  }
  if (finding.status === "missing_optional") {
    return clip(`${finding.key} is optional and missing from ${target}.`);
  }
  return clip(`${finding.key} is referenced in code but missing from ${target}.`);
}

/** One annotation per missing / elsewhere / missing_optional key, at its FIRST site. */
export function renderAnnotations(report: Report): Annotation[] {
  const target = targetLabel(report.target);
  const annotations: Annotation[] = [];

  for (const finding of safeFindings(report)) {
    const level = LEVELS[finding.status];
    if (level === undefined) continue;

    // A GitHub annotation needs an honest file and line, so a key with no site
    // in code (a user-`required` key, say) is skipped rather than faked.
    const site = firstSite(finding);
    if (!site) continue;

    annotations.push({
      level,
      file: site.file,
      line: site.line,
      title: `EnvContract: ${finding.key}`,
      message: messageFor(finding, target),
    });
  }

  return annotations;
}

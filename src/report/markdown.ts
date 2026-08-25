/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `renderMarkdown`.
 */

import type { Report } from "../compare.js";

/** First line of every rendered body — the sticky-comment lookup key. */
export const REPORT_MARKER = "<!-- envcontract:report -->";

/** Present keys are collapsed into a `<details>` block above this count. */
export const PRESENT_DETAILS_THRESHOLD = 10;

export const FOOTER_TEXT =
  "Continuously monitor every environment → https://envcontract.dev";

export type MarkdownOptions = {
  /** When true the free footer is omitted. */
  licensed?: boolean;
};

export function renderMarkdown(_report: Report, _opts?: MarkdownOptions): string {
  throw new Error("not implemented");
}

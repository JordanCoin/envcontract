/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `renderAnnotations`.
 */

import type { Report } from "../compare.js";

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

/** One annotation per missing / elsewhere / missing_optional key, at its FIRST site. */
export function renderAnnotations(_report: Report): Annotation[] {
  throw new Error("not implemented");
}

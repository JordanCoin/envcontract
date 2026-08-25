/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `toJSON` + invariant I3
 * (deterministic: sorted keys, stable ordering, no timestamps).
 */

import type { Report } from "../compare.js";

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

/** Allow-listed projection. Any field not named here — `value` above all — is dropped. */
export function toJSON(_report: Report): JsonReport {
  throw new Error("not implemented");
}

/** `JSON.stringify(toJSON(r))` with deterministic key order. */
export function stringifyReport(_report: Report): string {
  throw new Error("not implemented");
}

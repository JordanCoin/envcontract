/**
 * SPEC: docs/SPEC.md — Module A `scanner`, "`.env.example` parsing".
 *
 * I1: a real `.env` (no `.example`/`.sample`/`.template` suffix) is NEVER read.
 * `isEnvExampleFile` is the single gate that decides what may be opened.
 */

import type { ScanWarning, SourceFile } from "./scanner.js";

export type DeclaredEntry = {
  /** True when the declaration is commented out (`# KEY=`) — declared-optional. */
  optional: boolean;
  file: string;
  /** 1-based. */
  line: number;
};

export type DeclaredMap = Map<string, DeclaredEntry>;

export type ParseEnvExampleResult = {
  declared: DeclaredMap;
  warnings: ScanWarning[];
};

/** Parses one `.env.example`-shaped file. Never throws on malformed lines. */
export function parseEnvExample(_content: string, _file: string): ParseEnvExampleResult {
  throw new Error("not implemented");
}

/** Parses many; later files win on a duplicate key and record a warning. */
export function parseEnvExamples(_files: readonly SourceFile[]): ParseEnvExampleResult {
  throw new Error("not implemented");
}

/**
 * True only for `.env.example`, `.env.sample`, `.env.template` and
 * `.env.<anything>.example`. False for `.env`, `.env.local`, `.env.production`.
 */
export function isEnvExampleFile(_path: string): boolean {
  throw new Error("not implemented");
}

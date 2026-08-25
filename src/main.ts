/**
 * SPEC: docs/SPEC.md — Module E. The Action entry point: builds real
 * dependencies and hands them to `runEnvContract`. No logic lives here.
 */

import type { Inputs, RunDeps } from "./run.js";

/** Reads every action.yml input through `@actions/core`. */
export function readInputs(): Inputs {
  throw new Error("not implemented");
}

/** Real `fetch`, real filesystem, real `@actions/core` + `@actions/github` writers. */
export function buildDeps(): Promise<RunDeps> {
  throw new Error("not implemented");
}

/** Runs the action and sets `process.exitCode`. Never throws. */
export function main(): Promise<void> {
  throw new Error("not implemented");
}

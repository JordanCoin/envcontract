/**
 * SPEC: docs/SPEC.md — Module A `scanner`, "Built-in ignore list".
 *
 * Real data, not a stub: these constants ARE the contract. Keys matched here are
 * dropped from BOTH `references` and `keys`, and surfaced as `ignoredBuiltins`.
 */

import type { RefKind } from "./scanner.js";

/** Exact-match built-ins that the platform always provides on `process.env`. */
export const BUILTIN_IGNORE: readonly string[] = [
  // Node / generic runtime
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "PORT",
  "HOSTNAME",
  "HOME",
  "PATH",
  "PWD",
  "TZ",
  "LANG",
  "CI",
  "TMPDIR",
  "DEBUG",
  "COLOR",
  "NO_COLOR",
  "FORCE_COLOR",
  "TERM",
  "SHELL",
  "USER",
  // Next.js
  "NEXT_RUNTIME",
  "NEXT_PHASE",
  "NEXT_TELEMETRY_DISABLED",
  "NEXT_MANUAL_SIG_HANDLE",
  // Vercel system environment variables
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_REGION",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_TARGET_ENV",
  "VERCEL_OIDC_TOKEN",
  "VERCEL_SKEW_PROTECTION_ENABLED",
  "VERCEL_HASH_SALT",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
  // AWS Lambda (Vercel functions run on Lambda)
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_EXECUTION_ENV",
  "_HANDLER",
  "LAMBDA_TASK_ROOT",
];

/** Prefix-matched built-in families. A key starting with any of these is ignored. */
export const BUILTIN_IGNORE_PREFIXES: readonly string[] = [
  "npm_",
  "NEXT_PRIVATE_",
  "__NEXT_",
  "VERCEL_GIT_",
  "NEXT_PUBLIC_VERCEL_",
  "AWS_LAMBDA_",
];

/**
 * Vite built-ins. These are ignored ONLY for `kind: "import.meta.env"` — a
 * `process.env.MODE` reference is a real user variable.
 */
export const VITE_BUILTIN_IGNORE: readonly string[] = ["MODE", "BASE_URL", "PROD", "DEV", "SSR"];

/** True when `key` is a platform built-in for the given reference kind. */
export function isBuiltinIgnored(_key: string, _kind: RefKind): boolean {
  throw new Error("not implemented");
}

/**
 * Matches a key against a user ignore pattern: an exact key, or a `PREFIX_*`
 * glob (trailing `*` only).
 */
export function matchesIgnorePattern(_key: string, _pattern: string): boolean {
  throw new Error("not implemented");
}

/** True when `key` matches any of `patterns`. */
export function matchesAnyIgnorePattern(_key: string, _patterns: readonly string[]): boolean {
  throw new Error("not implemented");
}

/**
 * SPEC: docs/SPEC.md — Module B `vercel` client, and invariants I1 (never see a
 * value) and I4 (read-only: GET requests only, `decrypt` never sent).
 */

export type Target = "production" | "preview" | "development";

export const TARGETS: readonly Target[] = ["production", "preview", "development"];

/**
 * The ONLY shape a value ever takes inside this tool. `toEnvVar` produces
 * objects with exactly these five own keys — no `value`, not even `undefined`.
 */
export type EnvVar = {
  key: string;
  targets: Target[];
  gitBranch: string | null;
  type: string;
  customEnvironmentIds: string[];
};

export type VercelErrorCode =
  | "unauthorized"
  | "forbidden"
  | "project_not_found"
  | "rate_limited"
  | "server_error"
  | "network"
  | "bad_response";

/** `.message` is templated from the status and our own hint — never from the body. */
export class VercelError extends Error {
  readonly code: VercelErrorCode;
  readonly status: number | null;

  constructor(code: VercelErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "VercelError";
    this.code = code;
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type VercelClientOptions = {
  token: string;
  teamId?: string | undefined;
  fetch?: FetchLike;
  /** Defaults to `https://api.vercel.com`. */
  baseUrl?: string;
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Defaults to `envcontract/<version>`. */
  userAgent?: string;
  /** Per-request timeout in ms. Defaults to 15_000. */
  timeoutMs?: number;
};

export type ListEnvOptions = {
  gitBranch?: string | undefined;
  customEnvironmentId?: string | undefined;
};

export type ProjectRef = { id: string; name: string };

export type AmbiguousProject = { error: "ambiguous"; candidates: string[] };

export type FindProjectResult = ProjectRef | AmbiguousProject | null;

export type FindProjectQuery = { repo: string } | { idOrName: string };

export interface VercelClient {
  listEnv(projectIdOrName: string, opts?: ListEnvOptions): Promise<EnvVar[]>;
  findProject(query: FindProjectQuery): Promise<FindProjectResult>;
}

/** Per-request timeout (ms). */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Pagination loop guard. */
export const MAX_PAGES = 50;
/** Retries for 429. */
export const MAX_RATE_LIMIT_RETRIES = 3;
/** Retries for 5xx. */
export const MAX_SERVER_ERROR_RETRIES = 1;
/** Backoff used when `Retry-After` is absent. */
export const BACKOFF_MS: readonly number[] = [1000, 2000, 4000];

/**
 * Pure boundary mapper. Picks exactly `key`, `targets`, `gitBranch`, `type`,
 * `customEnvironmentIds`; normalizes a `target` string to an array; drops
 * `value` and every other field. Keeps no reference to `raw`.
 */
export function toEnvVar(_raw: unknown): EnvVar {
  throw new Error("not implemented");
}

export function createVercelClient(_options: VercelClientOptions): VercelClient {
  throw new Error("not implemented");
}

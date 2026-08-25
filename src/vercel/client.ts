/**
 * SPEC: docs/SPEC.md — Module B `vercel` client, and invariants I1 (never see a
 * value) and I4 (read-only: GET requests only, `decrypt` never sent).
 */

import { USER_AGENT } from "../version.js";

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

const DEFAULT_BASE_URL = "https://api.vercel.com";
const REDACTED = "[redacted]";

/*
 * Every message below is built from the HTTP status and our own hint. No part
 * of a response body ever reaches an error surface (I1).
 */
const MESSAGES = {
  unauthorized:
    "Vercel rejected the credentials (HTTP 401). Check that the token is set and has not been revoked.",
  forbidden:
    "Vercel refused the request (HTTP 403). Check the token scope and whether a team id is required.",
  projectNotFound:
    "Vercel has no such project (HTTP 404). Check the project id or name, and the team it belongs to.",
  rateLimited: (retries: number): string =>
    `Vercel rate-limited the request (HTTP 429) and it did not recover after ${retries} retries.`,
  serverError: (status: number): string =>
    `Vercel returned a server error (HTTP ${status}). This is usually transient — try again.`,
  network: "Could not reach the Vercel API (network error, or the request timed out).",
  badJson: "The Vercel API returned a body that is not valid JSON.",
  badShape: (status: number): string =>
    `The Vercel API returned an unexpected response (HTTP ${status}).`,
  badRow: "The Vercel API returned an environment variable row in an unexpected shape.",
} as const;

/* ------------------------------------------------------------------ helpers */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Belt and braces: a token must never survive into a string we hand out. */
function redact(text: string, token: string): string {
  if (token.length === 0 || !text.includes(token)) return text;
  return text.split(token).join(REDACTED);
}

function isTarget(value: unknown): value is Target {
  return typeof value === "string" && (TARGETS as readonly string[]).includes(value);
}

function normalizeTargets(raw: unknown): Target[] {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const out: Target[] = [];
  for (const entry of list) if (isTarget(entry)) out.push(entry);
  return out;
}

function normalizeStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) if (typeof entry === "string") out.push(entry);
  return out;
}

/** Seconds-only `Retry-After`; an HTTP-date falls back to the backoff ladder. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds)) return null;
  return seconds * 1000;
}

function backoffFor(attempt: number): number {
  return BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 1000;
}

function paginationNext(body: Record<string, unknown>): number | null {
  const pagination = body["pagination"];
  if (!isRecord(pagination)) return null;
  const next = pagination["next"];
  if (typeof next !== "number" || !Number.isFinite(next)) return null;
  return next;
}

/**
 * Pure boundary mapper. Picks exactly `key`, `targets`, `gitBranch`, `type`,
 * `customEnvironmentIds`; normalizes a `target` string to an array; drops
 * `value` and every other field. Keeps no reference to `raw`.
 */
export function toEnvVar(raw: unknown): EnvVar {
  if (!isRecord(raw)) throw new VercelError("bad_response", MESSAGES.badRow);
  const key = raw["key"];
  if (typeof key !== "string") throw new VercelError("bad_response", MESSAGES.badRow);
  const gitBranch = raw["gitBranch"];
  const type = raw["type"];
  return {
    key,
    targets: normalizeTargets(raw["target"]),
    gitBranch: typeof gitBranch === "string" && gitBranch.length > 0 ? gitBranch : null,
    type: typeof type === "string" ? type : "",
    customEnvironmentIds: normalizeStrings(raw["customEnvironmentIds"]),
  };
}

/* ------------------------------------------------------------------- client */

export function createVercelClient(options: VercelClientOptions): VercelClient {
  const token = options.token;
  const teamId = options.teamId;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const userAgent = options.userAgent ?? USER_AGENT;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const doSleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  const fail = (code: VercelErrorCode, message: string, status: number | null = null): never => {
    throw new VercelError(code, redact(message, token), status);
  };

  const buildUrl = (path: string, params: Record<string, string | undefined>): string => {
    const url = new URL(`${baseUrl}${path}`);
    if (teamId !== undefined && teamId !== "") url.searchParams.set("teamId", teamId);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    return url.toString();
  };

  /** One GET, with the 15s abort guard. Any transport failure is `network`. */
  const getOnce = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": userAgent,
          accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch {
      // The cause is deliberately dropped: it may quote the URL or the token.
      return fail("network", MESSAGES.network);
    } finally {
      clearTimeout(timer);
    }
  };

  const parseJson = async (response: Response): Promise<unknown> => {
    let text: string;
    try {
      text = await response.text();
    } catch {
      return fail("network", MESSAGES.network);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return fail("bad_response", MESSAGES.badJson, response.status);
    }
  };

  /** GET + retry ladder + JSON parse. The body never reaches an error message. */
  const getJson = async (url: string): Promise<unknown> => {
    let rateLimitRetries = 0;
    let serverErrorRetries = 0;

    for (;;) {
      const response = await getOnce(url);
      const status = response.status;

      if (response.ok) return await parseJson(response);

      if (status === 401) fail("unauthorized", MESSAGES.unauthorized, status);
      if (status === 403) fail("forbidden", MESSAGES.forbidden, status);
      if (status === 404) fail("project_not_found", MESSAGES.projectNotFound, status);

      if (status === 429) {
        if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
          fail("rate_limited", MESSAGES.rateLimited(MAX_RATE_LIMIT_RETRIES), status);
        }
        const waitMs = retryAfterMs(response) ?? backoffFor(rateLimitRetries);
        rateLimitRetries += 1;
        await doSleep(waitMs);
        continue;
      }

      if (status >= 500) {
        if (serverErrorRetries >= MAX_SERVER_ERROR_RETRIES) {
          fail("server_error", MESSAGES.serverError(status), status);
        }
        serverErrorRetries += 1;
        continue;
      }

      fail("bad_response", MESSAGES.badShape(status), status);
    }
  };

  const listEnv = async (
    projectIdOrName: string,
    opts: ListEnvOptions = {},
  ): Promise<EnvVar[]> => {
    const path = `/v10/projects/${encodeURIComponent(projectIdOrName)}/env`;
    const out: EnvVar[] = [];
    const seenIds = new Set<string>();
    let until: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await getJson(
        buildUrl(path, {
          gitBranch: opts.gitBranch,
          customEnvironmentId: opts.customEnvironmentId,
          until,
        }),
      );
      if (!isRecord(body)) fail("bad_response", MESSAGES.badShape(200));
      const record = body as Record<string, unknown>;
      const rows = record["envs"];
      if (!Array.isArray(rows)) fail("bad_response", MESSAGES.badShape(200));

      for (const raw of rows as unknown[]) {
        const id = isRecord(raw) && typeof raw["id"] === "string" ? raw["id"] : null;
        if (id !== null) {
          if (seenIds.has(id)) continue;
          seenIds.add(id);
        }
        out.push(toEnvVar(raw));
      }

      const next = paginationNext(record);
      if (next === null) break;
      until = String(next);
    }

    return out;
  };

  const toProjectRef = (candidate: unknown): ProjectRef | null => {
    if (!isRecord(candidate)) return null;
    const id = candidate["id"];
    const name = candidate["name"];
    if (typeof id !== "string" || typeof name !== "string") return null;
    return { id, name };
  };

  const projectList = (body: unknown): unknown[] => {
    if (Array.isArray(body)) return body;
    if (isRecord(body) && Array.isArray(body["projects"])) return body["projects"] as unknown[];
    return fail("bad_response", MESSAGES.badShape(200));
  };

  const linksTo = (candidate: unknown, org: string, repo: string): boolean => {
    if (!isRecord(candidate)) return false;
    const link = candidate["link"];
    if (!isRecord(link)) return false;
    const linkOrg = link["org"];
    const linkRepo = link["repo"];
    if (typeof linkOrg !== "string" || typeof linkRepo !== "string") return false;
    return linkOrg.toLowerCase() === org.toLowerCase() && linkRepo.toLowerCase() === repo.toLowerCase();
  };

  const findByRepo = async (repoSlug: string): Promise<FindProjectResult> => {
    const slash = repoSlug.indexOf("/");
    const org = slash === -1 ? "" : repoSlug.slice(0, slash);
    const repo = slash === -1 ? repoSlug : repoSlug.slice(slash + 1);

    const byLink = projectList(
      await getJson(buildUrl("/v10/projects", { repoUrl: `https://github.com/${org}/${repo}` })),
    ).filter((candidate) => linksTo(candidate, org, repo));

    if (byLink.length === 1) {
      const ref = toProjectRef(byLink[0]);
      if (ref !== null) return ref;
    }
    if (byLink.length > 1) {
      const candidates = byLink
        .map((candidate) => toProjectRef(candidate))
        .filter((ref): ref is ProjectRef => ref !== null)
        .map((ref) => ref.name)
        .sort();
      return { error: "ambiguous", candidates };
    }

    // Fallback: a project may carry the repo name without a git link.
    const bySearch = projectList(await getJson(buildUrl("/v10/projects", { search: repo })));
    for (const candidate of bySearch) {
      const ref = toProjectRef(candidate);
      if (ref !== null && ref.name.toLowerCase() === repo.toLowerCase()) return ref;
    }
    return null;
  };

  const findByIdOrName = async (idOrName: string): Promise<FindProjectResult> => {
    try {
      const body = await getJson(
        buildUrl(`/v10/projects/${encodeURIComponent(idOrName)}`, {}),
      );
      return toProjectRef(body);
    } catch (error) {
      // "Which project?" has "none" as a valid answer; only listEnv errors on 404.
      if (error instanceof VercelError && error.code === "project_not_found") return null;
      throw error;
    }
  };

  const findProject = async (query: FindProjectQuery): Promise<FindProjectResult> =>
    "repo" in query ? await findByRepo(query.repo) : await findByIdOrName(query.idOrName);

  return { listEnv, findProject };
}

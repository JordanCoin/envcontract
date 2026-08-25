/**
 * SPEC: docs/SPEC.md — Module B `vercel` client (VERIFIED API FACTS,
 * `createVercelClient`, `toEnvVar`, `findProject`, Errors, Timeout, Pagination)
 * and the hard invariants:
 *   I1 — never see, log, store, or emit a value.
 *   I2 — fail closed.
 *   I4 — read-only: only GET requests, `decrypt` NEVER in any URL.
 *
 * Every test drives the client through an injected `fetch` recorder. No test
 * touches the network. `assertNoDecrypt` runs in `afterEach` for EVERY test in
 * this file.
 */

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BACKOFF_MS,
  MAX_PAGES,
  MAX_RATE_LIMIT_RETRIES,
  MAX_SERVER_ERROR_RETRIES,
  REQUEST_TIMEOUT_MS,
  TARGETS,
  VercelError,
  createVercelClient,
  toEnvVar,
} from "../../src/vercel/client.js";
import type {
  AmbiguousProject,
  FetchLike,
  ProjectRef,
  VercelClient,
  VercelClientOptions,
} from "../../src/vercel/client.js";
import { USER_AGENT, VERSION } from "../../src/version.js";
import {
  assertNoDecrypt,
  assertOnlyGets,
  createFetchRecorder,
  makeRawEnv,
} from "../helpers/fixtures.js";
import type {
  FetchHandler,
  FetchRecorder,
  RecordedRequest,
  ResponseSpec,
} from "../helpers/fixtures.js";

const TOKEN = "vcp_super_secret_token_do_not_leak";

/** The recorder used by the test currently running; asserted in afterEach. */
let recorder: FetchRecorder | null = null;

type ClientOverride = {
  token?: string;
  teamId?: string;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
};

function setup(
  handler: FetchHandler,
  over: ClientOverride = {},
): { rec: FetchRecorder; client: VercelClient } {
  const rec = (recorder = createFetchRecorder(handler));
  const options: VercelClientOptions = {
    token: over.token ?? TOKEN,
    fetch: over.fetch ?? rec.fetch,
  };
  if (over.teamId !== undefined) options.teamId = over.teamId;
  if (over.baseUrl !== undefined) options.baseUrl = over.baseUrl;
  if (over.sleep !== undefined) options.sleep = over.sleep;
  if (over.userAgent !== undefined) options.userAgent = over.userAgent;
  if (over.timeoutMs !== undefined) options.timeoutMs = over.timeoutMs;
  const client = createVercelClient(options);
  return { rec, client };
}

function setupWithSleep(
  handler: FetchHandler,
  over: ClientOverride = {},
): { rec: FetchRecorder; client: VercelClient; sleeps: number[] } {
  const sleeps: number[] = [];
  const { rec, client } = setup(handler, {
    ...over,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  return { rec, client, sleeps };
}

/** Captures the rejection of a promise without letting a resolution pass silently. */
async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

/**
 * The `.code` of the VercelError a synchronous call throws. Anything that is
 * not a VercelError is rethrown, so an unimplemented stub fails the test with
 * its own message rather than a misleading instanceof assertion.
 */
function thrownVercelCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof VercelError) return error.code;
    throw error;
  }
  throw new Error("expected the call to throw, but it returned");
}

function firstUrl(rec: FetchRecorder): URL {
  const request = rec.requests[0];
  if (!request) throw new Error("no request was recorded");
  return new URL(request.url);
}

/** A 200 response carrying the unpaginated `{ envs }` body shape. */
function envsBody(rows: Record<string, unknown>[]): ResponseSpec {
  return { body: { envs: rows } };
}

afterEach(() => {
  // I4/I1: `decrypt` must never appear in ANY URL this tool builds.
  if (recorder) {
    assertNoDecrypt(recorder);
    assertOnlyGets(recorder);
  }
  recorder = null;
  vi.useRealTimers();
});

/* ------------------------------------------------------------------------ */

describe("List env — request shape", () => {
  it("requests the v10 project env endpoint for the given project id", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("prj_abc123");
    expect(firstUrl(rec).origin + firstUrl(rec).pathname).toBe(
      "https://api.vercel.com/v10/projects/prj_abc123/env",
    );
  });

  it("accepts a project name in place of an id", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("my-app");
    expect(firstUrl(rec).pathname).toBe("/v10/projects/my-app/env");
  });

  it("omits teamId from the query when no team is configured", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("prj_abc123");
    expect(firstUrl(rec).searchParams.has("teamId")).toBe(false);
  });

  it("adds teamId to the query when a team is configured", async () => {
    const { rec, client } = setup(envsBody([]), { teamId: "team_xyz" });
    await client.listEnv("prj_abc123");
    expect(firstUrl(rec).searchParams.get("teamId")).toBe("team_xyz");
  });

  it("adds gitBranch to the query when a branch filter is passed", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("prj_abc123", { gitBranch: "feature/x" });
    expect(firstUrl(rec).searchParams.get("gitBranch")).toBe("feature/x");
  });

  it("omits gitBranch from the query when no branch filter is passed", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("prj_abc123");
    expect(firstUrl(rec).searchParams.has("gitBranch")).toBe(false);
  });

  it("adds customEnvironmentId to the query when one is passed", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("prj_abc123", { customEnvironmentId: "ce_1" });
    expect(firstUrl(rec).searchParams.get("customEnvironmentId")).toBe("ce_1");
  });

  it("carries both teamId and gitBranch on the same request", async () => {
    const { rec, client } = setup(envsBody([]), { teamId: "team_xyz" });
    await client.listEnv("prj_abc123", { gitBranch: "main" });
    const url = firstUrl(rec);
    expect(url.searchParams.get("teamId")).toBe("team_xyz");
    expect(url.searchParams.get("gitBranch")).toBe("main");
  });

  it("honors a custom baseUrl", async () => {
    const { rec, client } = setup(envsBody([]), { baseUrl: "https://api.test.local" });
    await client.listEnv("prj_abc123");
    expect(firstUrl(rec).origin).toBe("https://api.test.local");
    expect(firstUrl(rec).pathname).toBe("/v10/projects/prj_abc123/env");
  });

  it("url-encodes a project name containing a slash", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("scope/my-app");
    const request = rec.requests[0];
    expect(request?.url).toContain("scope%2Fmy-app");
    expect(request?.url).not.toContain("scope/my-app");
  });

  it("url-encodes a project name containing a space", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("my app");
    expect(rec.requests[0]?.url).toContain("my%20app");
  });

  it("url-encodes a branch name containing a slash in the query", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("prj_abc123", { gitBranch: "feature/a b" });
    // Round-trips through URL parsing regardless of the encoding chosen.
    expect(firstUrl(rec).searchParams.get("gitBranch")).toBe("feature/a b");
  });

  it("makes exactly one request for a single unpaginated page", async () => {
    const { rec, client } = setup(envsBody([makeRawEnv()]));
    await client.listEnv("prj_abc123");
    expect(rec.requests).toHaveLength(1);
  });
});

describe("Headers", () => {
  it("sends the token as an Authorization Bearer header", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("prj_abc123");
    expect(rec.requests[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("sends a User-Agent of envcontract/<version>", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("prj_abc123");
    expect(rec.requests[0]?.headers["user-agent"]).toBe(`envcontract/${VERSION}`);
  });

  it("uses the USER_AGENT constant exported alongside the version", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("prj_abc123");
    expect(rec.requests[0]?.headers["user-agent"]).toBe(USER_AGENT);
  });

  it("allows the User-Agent to be overridden for embedding hosts", async () => {
    const { rec, client } = setup(envsBody([]), { userAgent: "envcontract-cli/9.9.9" });
    await client.listEnv("prj_abc123");
    expect(rec.requests[0]?.headers["user-agent"]).toBe("envcontract-cli/9.9.9");
  });

  it("never puts the token in the URL", async () => {
    const { rec, client } = setup(envsBody([]), { teamId: "team_xyz" });
    await client.listEnv("prj_abc123");
    for (const url of rec.urls()) expect(url).not.toContain(TOKEN);
  });

  it("sends the same headers on every page of a paginated response", async () => {
    const { rec, client } = setup([
      { body: { envs: [makeRawEnv({ id: "a" })], pagination: { count: 1, next: 1700, prev: null } } },
      { body: { envs: [makeRawEnv({ id: "b" })], pagination: { count: 1, next: null, prev: null } } },
    ]);
    await client.listEnv("prj_abc123");
    expect(rec.requests).toHaveLength(2);
    for (const request of rec.requests) {
      expect(request.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(request.headers["user-agent"]).toBe(USER_AGENT);
    }
  });
});

describe("toEnvVar", () => {
  const EXPECTED_KEYS = ["customEnvironmentIds", "gitBranch", "key", "targets", "type"];

  it("produces an object with exactly the five allow-listed keys", () => {
    const result = toEnvVar(makeRawEnv());
    expect(Object.keys(result).sort()).toEqual(EXPECTED_KEYS);
  });

  it("drops `value` from plain vars", () => {
    const result = toEnvVar(makeRawEnv({ type: "plain", value: "cleartext-secret" }));
    expect("value" in result).toBe(false);
  });

  it("drops `value` from system vars", () => {
    const result = toEnvVar(makeRawEnv({ type: "system", value: "cleartext-secret" }));
    expect("value" in result).toBe(false);
  });

  it("drops `value` from encrypted vars", () => {
    const result = toEnvVar(makeRawEnv({ type: "encrypted", value: "ciphertext" }));
    expect("value" in result).toBe(false);
  });

  it("leaves no `value` key even as undefined", () => {
    const result = toEnvVar(makeRawEnv());
    expect(Object.prototype.hasOwnProperty.call(result, "value")).toBe(false);
  });

  it("keeps the key verbatim", () => {
    const result = toEnvVar(makeRawEnv({ key: "STRIPE_SECRET_KEY" }));
    expect(result.key).toBe("STRIPE_SECRET_KEY");
  });

  it("keeps a lowercase key verbatim", () => {
    const result = toEnvVar(makeRawEnv({ key: "port" }));
    expect(result.key).toBe("port");
  });

  it("normalizes a `target` string to a single-element array", () => {
    const result = toEnvVar(makeRawEnv({ target: "preview" }));
    expect(result.targets).toEqual(["preview"]);
  });

  it("keeps a `target` array as an array", () => {
    const result = toEnvVar(makeRawEnv({ target: ["preview"] }));
    expect(result.targets).toEqual(["preview"]);
  });

  it("preserves the order of a multi-target array", () => {
    const result = toEnvVar(makeRawEnv({ target: ["preview", "production"] }));
    expect(result.targets).toEqual(["preview", "production"]);
  });

  it("maps all three targets when the var is set everywhere", () => {
    const result = toEnvVar(makeRawEnv({ target: ["production", "preview", "development"] }));
    expect(result.targets).toEqual([...TARGETS]);
  });

  it("returns an empty targets array when `target` is missing", () => {
    const raw = makeRawEnv();
    delete raw["target"];
    expect(toEnvVar(raw).targets).toEqual([]);
  });

  it("returns an empty targets array when `target` is an empty array", () => {
    expect(toEnvVar(makeRawEnv({ target: [] })).targets).toEqual([]);
  });

  it("returns an empty targets array when `target` is null", () => {
    expect(toEnvVar(makeRawEnv({ target: null })).targets).toEqual([]);
  });

  it("filters out target values outside the known production/preview/development set", () => {
    // Resolution: `targets` is typed `Target[]`, so unknown strings are dropped
    // rather than smuggled through a cast.
    const result = toEnvVar(makeRawEnv({ target: ["production", "staging"] }));
    expect(result.targets).toEqual(["production"]);
  });

  it("returns null for gitBranch when the field is missing", () => {
    const raw = makeRawEnv();
    delete raw["gitBranch"];
    expect(toEnvVar(raw).gitBranch).toBeNull();
  });

  it("returns null for gitBranch when the field is explicitly null", () => {
    expect(toEnvVar(makeRawEnv({ gitBranch: null })).gitBranch).toBeNull();
  });

  it("normalizes an empty-string gitBranch to null", () => {
    // Resolution: "" is not a branch; it is normalized to null so the presence
    // rule has a single "not branch-scoped" representation.
    expect(toEnvVar(makeRawEnv({ gitBranch: "" })).gitBranch).toBeNull();
  });

  it("keeps a branch-scoped gitBranch verbatim", () => {
    expect(toEnvVar(makeRawEnv({ gitBranch: "feature/x" })).gitBranch).toBe("feature/x");
  });

  it("returns an empty array when customEnvironmentIds is missing", () => {
    const raw = makeRawEnv();
    delete raw["customEnvironmentIds"];
    expect(toEnvVar(raw).customEnvironmentIds).toEqual([]);
  });

  it("returns an empty array when customEnvironmentIds is null", () => {
    expect(toEnvVar(makeRawEnv({ customEnvironmentIds: null })).customEnvironmentIds).toEqual([]);
  });

  it("returns an empty array when customEnvironmentIds is not an array", () => {
    expect(toEnvVar(makeRawEnv({ customEnvironmentIds: "ce_1" })).customEnvironmentIds).toEqual([]);
  });

  it("keeps the custom environment ids it was given", () => {
    const result = toEnvVar(makeRawEnv({ customEnvironmentIds: ["ce_1", "ce_2"] }));
    expect(result.customEnvironmentIds).toEqual(["ce_1", "ce_2"]);
  });

  it.each(["plain", "encrypted", "secret", "sensitive", "system"])(
    "preserves the `%s` type verbatim",
    (type) => {
      expect(toEnvVar(makeRawEnv({ type })).type).toBe(type);
    },
  );

  it("still produces a string `type` when the field is missing", () => {
    const raw = makeRawEnv();
    delete raw["type"];
    const result = toEnvVar(raw);
    expect(typeof result.type).toBe("string");
    expect(Object.keys(result).sort()).toEqual(EXPECTED_KEYS);
  });

  it("drops every unknown field the API adds", () => {
    const result = toEnvVar(
      makeRawEnv({ someBrandNewField: "surprise", contentHint: { type: "postgres-url" } }),
    );
    expect(Object.keys(result).sort()).toEqual(EXPECTED_KEYS);
  });

  it("drops the id, timestamps and authorship fields", () => {
    const result = toEnvVar(makeRawEnv());
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("createdBy");
    expect(result).not.toHaveProperty("comment");
  });

  it("does not retain a value nested inside another field", () => {
    const result = toEnvVar(
      makeRawEnv({ contentHint: { type: "redis-url", value: "redis://user:pw@host" } }),
    );
    expect(JSON.stringify(result)).not.toContain("redis://");
  });

  it("keeps no reference to the raw target array", () => {
    const raw = makeRawEnv({ target: ["production"] });
    const mapped = toEnvVar(raw);
    (raw["target"] as string[]).push("preview");
    expect(mapped.targets).toEqual(["production"]);
  });

  it("keeps no reference to the raw customEnvironmentIds array", () => {
    const raw = makeRawEnv({ customEnvironmentIds: ["ce_1"] });
    const mapped = toEnvVar(raw);
    (raw["customEnvironmentIds"] as string[]).push("ce_2");
    expect(mapped.customEnvironmentIds).toEqual(["ce_1"]);
  });

  it("does not mutate the raw row it was given", () => {
    const raw = makeRawEnv();
    const snapshot = JSON.stringify(raw);
    toEnvVar(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  it("rejects a null raw row as a bad response", () => {
    expect(thrownVercelCode(() => toEnvVar(null))).toBe("bad_response");
  });

  it("rejects an undefined raw row as a bad response", () => {
    expect(thrownVercelCode(() => toEnvVar(undefined))).toBe("bad_response");
  });

  it("rejects a raw row that is a string as a bad response", () => {
    expect(thrownVercelCode(() => toEnvVar("STRIPE_SECRET_KEY"))).toBe("bad_response");
  });

  it("rejects a raw row that is an array as a bad response", () => {
    expect(thrownVercelCode(() => toEnvVar([makeRawEnv()]))).toBe("bad_response");
  });

  it("rejects a raw row without a string key as a bad response", () => {
    const raw = makeRawEnv();
    delete raw["key"];
    expect(thrownVercelCode(() => toEnvVar(raw))).toBe("bad_response");
  });

  it("rejects a raw row whose key is not a string as a bad response", () => {
    expect(thrownVercelCode(() => toEnvVar(makeRawEnv({ key: 42 })))).toBe("bad_response");
  });

  it("is pure: the same raw row maps to a deep-equal result every time", () => {
    const raw = makeRawEnv({ target: ["production", "preview"] });
    expect(toEnvVar(raw)).toEqual(toEnvVar(raw));
  });
});

describe("List env — response mapping", () => {
  it("maps every row in the response through the boundary mapper", async () => {
    const { client } = setup(
      envsBody([
        makeRawEnv({ id: "1", key: "A", target: ["production"] }),
        makeRawEnv({ id: "2", key: "B", target: "preview" }),
      ]),
    );
    const result = await client.listEnv("prj_abc123");
    expect(result).toEqual([
      { key: "A", targets: ["production"], gitBranch: null, type: "encrypted", customEnvironmentIds: [] },
      { key: "B", targets: ["preview"], gitBranch: null, type: "encrypted", customEnvironmentIds: [] },
    ]);
  });

  it("returns no object carrying a `value` key", async () => {
    const { client } = setup(
      envsBody([
        makeRawEnv({ id: "1", key: "A", type: "plain", value: "cleartext" }),
        makeRawEnv({ id: "2", key: "B", type: "system", value: "cleartext" }),
      ]),
    );
    const result = await client.listEnv("prj_abc123");
    for (const envVar of result) expect("value" in envVar).toBe(false);
  });

  it("returns an empty list for a project with no environment variables", async () => {
    const { client } = setup(envsBody([]));
    expect(await client.listEnv("prj_abc123")).toEqual([]);
  });

  it("preserves the order the API returned rows in", async () => {
    const { client } = setup(
      envsBody([
        makeRawEnv({ id: "1", key: "Z" }),
        makeRawEnv({ id: "2", key: "A" }),
        makeRawEnv({ id: "3", key: "M" }),
      ]),
    );
    const result = await client.listEnv("prj_abc123");
    expect(result.map((e) => e.key)).toEqual(["Z", "A", "M"]);
  });

  it("keeps duplicate keys that differ by target as separate entries", async () => {
    const { client } = setup(
      envsBody([
        makeRawEnv({ id: "1", key: "API_URL", target: ["production"] }),
        makeRawEnv({ id: "2", key: "API_URL", target: ["preview"] }),
      ]),
    );
    const result = await client.listEnv("prj_abc123");
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.targets)).toEqual([["production"], ["preview"]]);
  });
});

describe("Pagination", () => {
  it("follows pagination.next across three pages and concatenates the rows", async () => {
    const { client } = setup([
      {
        body: {
          envs: [makeRawEnv({ id: "1", key: "A" })],
          pagination: { count: 1, next: 1_700_000_000_003, prev: null },
        },
      },
      {
        body: {
          envs: [makeRawEnv({ id: "2", key: "B" })],
          pagination: { count: 1, next: 1_700_000_000_002, prev: null },
        },
      },
      {
        body: {
          envs: [makeRawEnv({ id: "3", key: "C" })],
          pagination: { count: 1, next: null, prev: null },
        },
      },
    ]);
    const result = await client.listEnv("prj_abc123");
    expect(result.map((e) => e.key)).toEqual(["A", "B", "C"]);
  });

  it("makes exactly one request per page", async () => {
    const { rec, client } = setup([
      { body: { envs: [makeRawEnv({ id: "1" })], pagination: { count: 1, next: 200, prev: null } } },
      { body: { envs: [makeRawEnv({ id: "2" })], pagination: { count: 1, next: 100, prev: null } } },
      { body: { envs: [makeRawEnv({ id: "3" })], pagination: { count: 1, next: null, prev: null } } },
    ]);
    await client.listEnv("prj_abc123");
    expect(rec.requests).toHaveLength(3);
  });

  it("passes the next timestamp as the `until` cursor on the following request", async () => {
    const { rec, client } = setup([
      {
        body: {
          envs: [makeRawEnv({ id: "1" })],
          pagination: { count: 1, next: 1_700_000_000_003, prev: null },
        },
      },
      { body: { envs: [makeRawEnv({ id: "2" })], pagination: { count: 1, next: null, prev: null } } },
    ]);
    await client.listEnv("prj_abc123");
    expect(new URL(rec.requests[1]?.url ?? "").searchParams.get("until")).toBe("1700000000003");
  });

  it("does not send an `until` cursor on the first request", async () => {
    const { rec, client } = setup([
      { body: { envs: [makeRawEnv({ id: "1" })], pagination: { count: 1, next: 900, prev: null } } },
      { body: { envs: [makeRawEnv({ id: "2" })], pagination: { count: 1, next: null, prev: null } } },
    ]);
    await client.listEnv("prj_abc123");
    expect(firstUrl(rec).searchParams.has("until")).toBe(false);
  });

  it("keeps teamId on every paginated follow-up request", async () => {
    const { rec, client } = setup(
      [
        { body: { envs: [makeRawEnv({ id: "1" })], pagination: { count: 1, next: 900, prev: null } } },
        { body: { envs: [makeRawEnv({ id: "2" })], pagination: { count: 1, next: null, prev: null } } },
      ],
      { teamId: "team_xyz" },
    );
    await client.listEnv("prj_abc123");
    for (const request of rec.requests) {
      expect(new URL(request.url).searchParams.get("teamId")).toBe("team_xyz");
    }
  });

  it("de-duplicates rows repeated across pages by id", async () => {
    const { client } = setup([
      {
        body: {
          envs: [makeRawEnv({ id: "dup", key: "A" })],
          pagination: { count: 1, next: 900, prev: null },
        },
      },
      {
        body: {
          envs: [makeRawEnv({ id: "dup", key: "A" }), makeRawEnv({ id: "new", key: "B" })],
          pagination: { count: 2, next: null, prev: null },
        },
      },
    ]);
    const result = await client.listEnv("prj_abc123");
    expect(result.map((e) => e.key)).toEqual(["A", "B"]);
  });

  it("stops when pagination.next is null", async () => {
    const { rec, client } = setup({
      body: { envs: [makeRawEnv()], pagination: { count: 1, next: null, prev: null } },
    });
    await client.listEnv("prj_abc123");
    expect(rec.requests).toHaveLength(1);
  });

  it("handles the non-paginated body shape that omits `pagination` entirely", async () => {
    const { rec, client } = setup(envsBody([makeRawEnv({ key: "A" })]));
    const result = await client.listEnv("prj_abc123");
    expect(result.map((e) => e.key)).toEqual(["A"]);
    expect(rec.requests).toHaveLength(1);
  });

  it("gives up at the MAX_PAGES loop guard when next is never null", async () => {
    let counter = 0;
    const { rec, client } = setup(() => {
      counter += 1;
      return {
        body: {
          envs: [makeRawEnv({ id: `id_${counter}`, key: `K${counter}` })],
          pagination: { count: 1, next: 1_000_000 - counter, prev: null },
        },
      };
    });
    await client.listEnv("prj_abc123");
    expect(rec.requests).toHaveLength(MAX_PAGES);
  });

  it("keeps MAX_PAGES at the specified guard of 50", () => {
    expect(MAX_PAGES).toBe(50);
  });
});

describe("Find project", () => {
  const linkedProject = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "prj_1",
    name: "my-app",
    link: {
      type: "github",
      org: "JordanCoin",
      repo: "envcontract",
      repoId: 1,
      productionBranch: "main",
    },
    ...over,
  });

  it("queries repoUrl with the full GitHub URL for the owner/repo pair", async () => {
    const { rec, client } = setup({ body: { projects: [linkedProject()] } });
    await client.findProject({ repo: "JordanCoin/envcontract" });
    expect(firstUrl(rec).searchParams.get("repoUrl")).toBe(
      "https://github.com/JordanCoin/envcontract",
    );
  });

  it("queries the v10 projects endpoint", async () => {
    const { rec, client } = setup({ body: { projects: [linkedProject()] } });
    await client.findProject({ repo: "JordanCoin/envcontract" });
    expect(firstUrl(rec).pathname).toBe("/v10/projects");
  });

  it("returns the id and name of the single matching project", async () => {
    const { client } = setup({ body: { projects: [linkedProject()] } });
    expect(await client.findProject({ repo: "JordanCoin/envcontract" })).toEqual({
      id: "prj_1",
      name: "my-app",
    });
  });

  it("returns only id and name, dropping the rest of the project payload", async () => {
    const { client } = setup({
      body: { projects: [linkedProject({ framework: "nextjs", accountId: "acc_1" })] },
    });
    const result = await client.findProject({ repo: "JordanCoin/envcontract" });
    expect(Object.keys(result as ProjectRef).sort()).toEqual(["id", "name"]);
  });

  it("accepts the bare-array response shape", async () => {
    const { client } = setup({ body: [linkedProject()] });
    expect(await client.findProject({ repo: "JordanCoin/envcontract" })).toEqual({
      id: "prj_1",
      name: "my-app",
    });
  });

  it("accepts the { projects } response shape", async () => {
    const { client } = setup({ body: { projects: [linkedProject()], pagination: { count: 1 } } });
    expect(await client.findProject({ repo: "JordanCoin/envcontract" })).toEqual({
      id: "prj_1",
      name: "my-app",
    });
  });

  it("matches the org case-insensitively", async () => {
    const { client } = setup({ body: { projects: [linkedProject()] } });
    expect(await client.findProject({ repo: "jordancoin/envcontract" })).toEqual({
      id: "prj_1",
      name: "my-app",
    });
  });

  it("matches the repo case-insensitively", async () => {
    const { client } = setup({ body: { projects: [linkedProject()] } });
    expect(await client.findProject({ repo: "JordanCoin/EnvContract" })).toEqual({
      id: "prj_1",
      name: "my-app",
    });
  });

  it("does not match a project linked to a different repo in the same org", async () => {
    const { client } = setup({
      body: {
        projects: [
          linkedProject({
            link: { type: "github", org: "JordanCoin", repo: "other-repo", repoId: 2 },
          }),
        ],
      },
    });
    expect(await client.findProject({ repo: "JordanCoin/envcontract" })).toBeNull();
  });

  it("does not match a project that has no link object", async () => {
    const { client } = setup({ body: { projects: [{ id: "prj_9", name: "unlinked" }] } });
    expect(await client.findProject({ repo: "JordanCoin/envcontract" })).toBeNull();
  });

  it("reports ambiguity when a monorepo links two projects to the same repo", async () => {
    const { client } = setup({
      body: {
        projects: [
          linkedProject({ id: "prj_1", name: "web" }),
          linkedProject({ id: "prj_2", name: "api" }),
        ],
      },
    });
    const result = await client.findProject({ repo: "JordanCoin/envcontract" });
    expect((result as AmbiguousProject).error).toBe("ambiguous");
  });

  it("sorts the ambiguous candidate names ascending for a deterministic message", async () => {
    // Resolution (I3): candidates are sorted by name, not left in API order.
    const { client } = setup({
      body: {
        projects: [
          linkedProject({ id: "prj_1", name: "web" }),
          linkedProject({ id: "prj_2", name: "api" }),
          linkedProject({ id: "prj_3", name: "docs" }),
        ],
      },
    });
    const result = await client.findProject({ repo: "JordanCoin/envcontract" });
    expect((result as AmbiguousProject).candidates).toEqual(["api", "docs", "web"]);
  });

  it("falls back to a search query when repoUrl matches nothing", async () => {
    const { rec, client } = setup([
      { body: { projects: [] } },
      { body: { projects: [{ id: "prj_5", name: "envcontract" }] } },
    ]);
    await client.findProject({ repo: "JordanCoin/envcontract" });
    expect(rec.requests).toHaveLength(2);
    expect(new URL(rec.requests[1]?.url ?? "").searchParams.get("search")).toBe("envcontract");
  });

  it("takes an exact name match from the search fallback", async () => {
    const { client } = setup([
      { body: { projects: [] } },
      {
        body: {
          projects: [
            { id: "prj_4", name: "envcontract-web" },
            { id: "prj_5", name: "envcontract" },
          ],
        },
      },
    ]);
    expect(await client.findProject({ repo: "JordanCoin/envcontract" })).toEqual({
      id: "prj_5",
      name: "envcontract",
    });
  });

  it("returns null when the search fallback has only near matches", async () => {
    const { client } = setup([
      { body: { projects: [] } },
      { body: { projects: [{ id: "prj_4", name: "envcontract-web" }] } },
    ]);
    expect(await client.findProject({ repo: "JordanCoin/envcontract" })).toBeNull();
  });

  it("returns null when neither the repo link nor the search finds anything", async () => {
    const { client } = setup({ body: { projects: [] } });
    expect(await client.findProject({ repo: "JordanCoin/envcontract" })).toBeNull();
  });

  it("looks a project up directly when given an idOrName", async () => {
    const { rec, client } = setup({ body: { id: "prj_7", name: "my-app" } });
    const result = await client.findProject({ idOrName: "my-app" });
    expect(firstUrl(rec).pathname).toBe("/v10/projects/my-app");
    expect(result).toEqual({ id: "prj_7", name: "my-app" });
  });

  it("sends teamId on a direct idOrName lookup", async () => {
    const { rec, client } = setup({ body: { id: "prj_7", name: "my-app" } }, { teamId: "team_xyz" });
    await client.findProject({ idOrName: "my-app" });
    expect(firstUrl(rec).searchParams.get("teamId")).toBe("team_xyz");
  });

  it("returns null when a direct idOrName lookup 404s", async () => {
    // Resolution: findProject answers "which project", and "none" is a valid
    // answer; only listEnv turns a 404 into a project_not_found error.
    const { client } = setup({ status: 404, body: { error: { code: "not_found" } } });
    expect(await client.findProject({ idOrName: "ghost" })).toBeNull();
  });

  it("sends teamId on the repoUrl lookup", async () => {
    const { rec, client } = setup({ body: { projects: [linkedProject()] } }, { teamId: "team_xyz" });
    await client.findProject({ repo: "JordanCoin/envcontract" });
    expect(firstUrl(rec).searchParams.get("teamId")).toBe("team_xyz");
  });

  it("never sends decrypt on a project lookup", async () => {
    const { rec, client } = setup({ body: { projects: [linkedProject()] } });
    await client.findProject({ repo: "JordanCoin/envcontract" });
    for (const url of rec.urls()) expect(url).not.toContain("decrypt");
  });
});

describe("Errors", () => {
  it("maps 401 to the unauthorized code", async () => {
    const { client } = setup({ status: 401, body: { error: { code: "forbidden" } } });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).code).toBe("unauthorized");
  });

  it("raises a VercelError instance, not a bare Error", async () => {
    const { client } = setup({ status: 401, body: {} });
    expect(await captureError(client.listEnv("prj_abc123"))).toBeInstanceOf(VercelError);
  });

  it("records the HTTP status on the error", async () => {
    const { client } = setup({ status: 401, body: {} });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).status).toBe(401);
  });

  it("maps 403 to the forbidden code", async () => {
    const { client } = setup({ status: 403, body: {} });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).code).toBe("forbidden");
  });

  it("hints at the team id or token scope in the 403 message", async () => {
    const { client } = setup({ status: 403, body: {} });
    const error = await captureError(client.listEnv("prj_abc123"));
    const message = (error as VercelError).message.toLowerCase();
    expect(message).toMatch(/team|scope/);
  });

  it("maps 404 to the project_not_found code", async () => {
    const { client } = setup({ status: 404, body: {} });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).code).toBe("project_not_found");
  });

  it("retries a 500 once and succeeds on the second attempt", async () => {
    const { rec, client } = setupWithSleep([{ status: 500, body: {} }, envsBody([makeRawEnv({ key: "A" })])]);
    const result = await client.listEnv("prj_abc123");
    expect(result.map((e) => e.key)).toEqual(["A"]);
    expect(rec.requests).toHaveLength(1 + MAX_SERVER_ERROR_RETRIES);
  });

  it("backs off before retrying a 500 instead of hammering the API", async () => {
    const { client, sleeps } = setupWithSleep([
      { status: 500, body: {} },
      envsBody([makeRawEnv({ key: "A" })]),
    ]);
    await client.listEnv("prj_abc123");
    expect(sleeps).toEqual([BACKOFF_MS[0]]);
  });

  it("maps two consecutive 500s to the server_error code", async () => {
    const { client } = setupWithSleep({ status: 500, body: {} });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).code).toBe("server_error");
  });

  it("stops after the server-error retry budget", async () => {
    const { rec, client } = setupWithSleep({ status: 500, body: {} });
    await captureError(client.listEnv("prj_abc123"));
    expect(rec.requests).toHaveLength(1 + MAX_SERVER_ERROR_RETRIES);
  });

  it("maps a 503 to the server_error code as well", async () => {
    const { client } = setupWithSleep({ status: 503, body: {} });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).code).toBe("server_error");
  });

  it("sleeps for the Retry-After seconds on a 429 and then succeeds", async () => {
    const { client, sleeps } = setupWithSleep([
      { status: 429, headers: { "retry-after": "2" }, body: {} },
      envsBody([makeRawEnv({ key: "A" })]),
    ]);
    const result = await client.listEnv("prj_abc123");
    expect(sleeps).toEqual([2000]);
    expect(result.map((e) => e.key)).toEqual(["A"]);
  });

  it("uses exponential backoff when a 429 carries no Retry-After", async () => {
    const { client, sleeps } = setupWithSleep([
      { status: 429, body: {} },
      envsBody([makeRawEnv({ key: "A" })]),
    ]);
    await client.listEnv("prj_abc123");
    expect(sleeps).toEqual([BACKOFF_MS[0]]);
  });

  it("falls back to backoff when Retry-After is not a number of seconds", async () => {
    const { client, sleeps } = setupWithSleep([
      { status: 429, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, body: {} },
      envsBody([makeRawEnv({ key: "A" })]),
    ]);
    await client.listEnv("prj_abc123");
    expect(sleeps).toEqual([BACKOFF_MS[0]]);
  });

  it("walks the full 1s/2s/4s backoff across repeated 429s", async () => {
    const { client, sleeps } = setupWithSleep({ status: 429, body: {} });
    await captureError(client.listEnv("prj_abc123"));
    expect(sleeps).toEqual([...BACKOFF_MS]);
  });

  it("maps a fourth consecutive 429 to the rate_limited code", async () => {
    const { client } = setupWithSleep({ status: 429, body: {} });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).code).toBe("rate_limited");
  });

  it("makes exactly one attempt plus the rate-limit retry budget", async () => {
    const { rec, client } = setupWithSleep({ status: 429, body: {} });
    await captureError(client.listEnv("prj_abc123"));
    expect(rec.requests).toHaveLength(1 + MAX_RATE_LIMIT_RETRIES);
  });

  it("maps a rejecting fetch to the network code", async () => {
    const { client } = setup(() => new TypeError("fetch failed"));
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).code).toBe("network");
  });

  it("maps a DNS-style failure to the network code", async () => {
    const { client } = setup(() => new TypeError("getaddrinfo ENOTFOUND api.vercel.com"));
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).code).toBe("network");
  });

  it("maps a body that is not JSON to the bad_response code", async () => {
    const { client } = setup({ status: 200, text: "<html>502 Bad Gateway</html>" });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).code).toBe("bad_response");
  });

  it("maps truncated JSON to the bad_response code", async () => {
    const { client } = setup({ status: 200, text: '{"envs": [{"key": "A"' });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).code).toBe("bad_response");
  });

  it("maps a 200 body with no envs array to the bad_response code", async () => {
    // Resolution (I2, fail closed): a body missing `envs` is malformed. Treating
    // it as "no variables" would render a confident, wrong FAIL report.
    const { client } = setup({ status: 200, body: {} });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).code).toBe("bad_response");
  });

  it("maps a 200 body whose envs is not an array to the bad_response code", async () => {
    const { client } = setup({ status: 200, body: { envs: "nope" } });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).code).toBe("bad_response");
  });

  it("never copies the API error body into the message", async () => {
    const { client } = setup({
      status: 403,
      body: { error: { code: "forbidden", message: "Not authorized to access env for prj_x" } },
    });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).message).not.toContain("Not authorized to access env");
  });

  it("never puts the token in the error message", async () => {
    const { client } = setup({ status: 401, body: {} });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).message).not.toContain(TOKEN);
  });

  it("never puts the token in the error stack", async () => {
    const { client } = setup({ status: 401, body: {} });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect((error as VercelError).stack ?? "").not.toContain(TOKEN);
  });

  it("never puts the token in the stringified error", async () => {
    const { client } = setupWithSleep({ status: 500, body: {} });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect(String(error)).not.toContain(TOKEN);
  });

  it("never puts the token in a network error either", async () => {
    const { client } = setup(() => new TypeError(`connect ECONNREFUSED using ${TOKEN}`));
    const error = await captureError(client.listEnv("prj_abc123"));
    expect(String(error)).not.toContain(TOKEN);
    expect((error as VercelError).message).not.toContain(TOKEN);
  });

  it("redacts the token if it somehow reaches an error string", async () => {
    const { client } = setup({ status: 401, text: `{"token":"${TOKEN}"}` });
    const error = await captureError(client.listEnv("prj_abc123"));
    expect(JSON.stringify({ m: (error as VercelError).message, s: String(error) })).not.toContain(
      TOKEN,
    );
  });

  it("surfaces errors from a project lookup as VercelErrors too", async () => {
    const { client } = setup({ status: 401, body: {} });
    const error = await captureError(client.findProject({ repo: "JordanCoin/envcontract" }));
    expect((error as VercelError).code).toBe("unauthorized");
  });
});

describe("Timeout", () => {
  it("aborts a request that never responds and reports the network code", async () => {
    vi.useFakeTimers();
    const rec = (recorder = createFetchRecorder({ body: { envs: [] } }));
    const hangingFetch: FetchLike = (input, init) => {
      const request: RecordedRequest = {
        url: String(input),
        method: (init?.method ?? "GET").toUpperCase(),
        headers: {},
        body: null,
      };
      rec.requests.push(request);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }
      });
    };
    const client = createVercelClient({ token: TOKEN, fetch: hangingFetch });
    const pending = captureError(client.listEnv("prj_abc123"));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 100);
    expect(((await pending) as VercelError).code).toBe("network");
  });

  it("keeps the per-request timeout at the specified 15 seconds", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
  });
});

describe("I1 — never see, log, store, or emit a value", () => {
  it("keeps a planted cleartext value out of the mapped result", async () => {
    const { client } = setup(
      envsBody([makeRawEnv({ type: "plain", value: "sk_live_planted_cleartext" })]),
    );
    const result = await client.listEnv("prj_abc123");
    expect(JSON.stringify(result)).not.toContain("sk_live_planted_cleartext");
  });

  it("keeps values out of the mapped result for arbitrary strings", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 8 }), async (v) => {
        const secret = `SEKRIT-${v}`;
        const { rec, client } = setup(envsBody([makeRawEnv({ type: "plain", value: secret })]));
        const result = await client.listEnv("prj_abc123");
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain(JSON.stringify(secret).slice(1, -1));
        expect(serialized).not.toContain("SEKRIT-");
        for (const url of rec.urls()) expect(url).not.toContain("SEKRIT-");
      }),
      { numRuns: 25 },
    );
  });

  it("keeps values out of every error surface for arbitrary strings", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 8 }), async (v) => {
        const secret = `SEKRIT-${v}`;
        const { client } = setup({
          status: 400,
          body: { error: { code: "bad_request", message: secret, value: secret } },
        });
        const error = await captureError(client.listEnv("prj_abc123"));
        expect(error).toBeInstanceOf(VercelError);
        const vercelError = error as VercelError;
        for (const surface of [
          vercelError.message,
          String(vercelError),
          vercelError.stack ?? "",
          JSON.stringify({ ...vercelError, message: vercelError.message }),
        ]) {
          expect(surface).not.toContain(secret);
          expect(surface).not.toContain("SEKRIT-");
        }
      }),
      { numRuns: 25 },
    );
  });

  it("keeps values out of a 500 error surface for arbitrary strings", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 8 }), async (v) => {
        const secret = `SEKRIT-${v}`;
        const { client } = setupWithSleep({ status: 500, body: { error: { message: secret } } });
        const error = await captureError(client.listEnv("prj_abc123"));
        const vercelError = error as VercelError;
        expect(vercelError.message).not.toContain("SEKRIT-");
        expect(String(vercelError)).not.toContain("SEKRIT-");
        expect(vercelError.stack ?? "").not.toContain("SEKRIT-");
      }),
      { numRuns: 25 },
    );
  });

  it("keeps a value out of the result when the API also echoes it in contentHint", async () => {
    const { client } = setup(
      envsBody([
        makeRawEnv({
          type: "plain",
          value: "postgres://u:planted@host/db",
          contentHint: { type: "postgres-url", storeId: "postgres://u:planted@host/db" },
        }),
      ]),
    );
    expect(JSON.stringify(await client.listEnv("prj_abc123"))).not.toContain("planted");
  });

  it("keeps values out of a paginated result across every page", async () => {
    const { client } = setup([
      {
        body: {
          envs: [makeRawEnv({ id: "1", type: "plain", value: "planted_page_one" })],
          pagination: { count: 1, next: 900, prev: null },
        },
      },
      {
        body: {
          envs: [makeRawEnv({ id: "2", type: "system", value: "planted_page_two" })],
          pagination: { count: 1, next: null, prev: null },
        },
      },
    ]);
    const serialized = JSON.stringify(await client.listEnv("prj_abc123"));
    expect(serialized).not.toContain("planted_page_one");
    expect(serialized).not.toContain("planted_page_two");
  });

  it("keeps no raw or debug field on the mapped objects", async () => {
    const { client } = setup(envsBody([makeRawEnv({ type: "plain", value: "planted" })]));
    const [envVar] = await client.listEnv("prj_abc123");
    expect(envVar).toBeDefined();
    expect(Object.keys(envVar ?? {}).sort()).toEqual([
      "customEnvironmentIds",
      "gitBranch",
      "key",
      "targets",
      "type",
    ]);
  });
});

describe("I4 — read-only", () => {
  it("uses GET for the env listing", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("prj_abc123");
    expect(rec.requests[0]?.method).toBe("GET");
  });

  it("uses GET for a project lookup", async () => {
    const { rec, client } = setup({ body: { projects: [] } });
    await client.findProject({ repo: "JordanCoin/envcontract" });
    for (const request of rec.requests) expect(request.method).toBe("GET");
  });

  it("sends no request body", async () => {
    const { rec, client } = setup(envsBody([]));
    await client.listEnv("prj_abc123");
    expect(rec.requests[0]?.body).toBeNull();
  });

  it("never sends decrypt on the env listing", async () => {
    const { rec, client } = setup(envsBody([makeRawEnv({ type: "plain" })]));
    await client.listEnv("prj_abc123");
    for (const url of rec.urls()) expect(url.toLowerCase()).not.toContain("decrypt");
  });

  it("never sends decrypt across a paginated listing", async () => {
    const { rec, client } = setup([
      { body: { envs: [makeRawEnv({ id: "1" })], pagination: { count: 1, next: 900, prev: null } } },
      { body: { envs: [makeRawEnv({ id: "2" })], pagination: { count: 1, next: null, prev: null } } },
    ]);
    await client.listEnv("prj_abc123");
    expect(rec.requests).toHaveLength(2);
    for (const url of rec.urls()) expect(url.toLowerCase()).not.toContain("decrypt");
  });

  it("uses GET even on the retried request after a 429", async () => {
    const { rec, client } = setupWithSleep([{ status: 429, body: {} }, envsBody([])]);
    await client.listEnv("prj_abc123");
    for (const request of rec.requests) expect(request.method).toBe("GET");
  });
});

/**
 * SPEC: docs/SPEC.md — Module E `run` / Action entry (inputs, outputs,
 * behaviour, sticky PR comment, CLI), plus the hard invariants:
 *   I1 never see, log, store or emit a value
 *   I2 fail closed (an API/network/auth error is `error` + non-zero exit)
 *   I3 deterministic (same inputs → byte-identical report)
 *   I4 read-only (only GETs to Vercel; the PR comment is the only write)
 *
 * Every dependency is injected. Nothing in this file touches the network, and
 * the only filesystem reads are of the checked-in fixture repos under
 * tests/fixtures/ (which are excluded from tsconfig and from vitest's include).
 */

import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CliArgs, CliError } from "../src/cli.js";
import { USAGE, cli, parseArgs } from "../src/cli.js";
import { REPORT_MARKER } from "../src/report/markdown.js";
import type { Inputs, RunDeps } from "../src/run.js";
import {
  parseBoolean,
  parseFailOn,
  parseList,
  resolveBranch,
  resolveProject,
  resolveTarget,
  resolveTeamId,
  runEnvContract,
} from "../src/run.js";
import { nodeFileSystem } from "../src/scanner/files.js";
import type { VercelClient } from "../src/vercel/client.js";
import type { FetchRecorder, RunRecorders } from "./helpers/fixtures.js";
import {
  assertNoDecrypt,
  createFakeGitHub,
  createFetchRecorder,
  createMemoryFs,
  createRunDeps,
  makeInputs,
  makeRawEnv,
} from "./helpers/fixtures.js";

/* ------------------------------------------------------------------ fixtures */

const FIXTURE_NEXT = fileURLToPath(new URL("./fixtures/nextjs-app", import.meta.url));
const FIXTURE_VITE = fileURLToPath(new URL("./fixtures/vite-app", import.meta.url));
const FIXTURE_MONOREPO = fileURLToPath(new URL("./fixtures/monorepo", import.meta.url));

/** Planted in every mocked Vercel response. Must never survive the boundary. */
const PLANTED = "sk_live_PLANTED_MUST_NEVER_LEAK";

/** Recorders created during a test; every one is swept for `decrypt` afterwards. */
let recorders: FetchRecorder[] = [];

beforeEach(() => {
  recorders = [];
});

afterEach(() => {
  // I4 / I1: `decrypt` must never appear in any URL this tool builds, in ANY test.
  for (const recorder of recorders) assertNoDecrypt(recorder);
});

function rawEnv(
  key: string,
  target: string[] | string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return makeRawEnv({ id: `env_${key}`, key, target, value: PLANTED, ...over });
}

const ENV_ALL_PRESENT = [
  rawEnv("NEXT_PUBLIC_SITE_URL", ["production", "preview"]),
  rawEnv("NEXT_PUBLIC_ANALYTICS_ID", ["preview"]),
  rawEnv("STRIPE_SECRET_KEY", ["production", "preview"]),
  rawEnv("DATABASE_URL", ["production", "preview", "development"]),
];

/** STRIPE_SECRET_KEY and DATABASE_URL exist in no target at all. */
const ENV_TWO_MISSING = [
  rawEnv("NEXT_PUBLIC_SITE_URL", ["production", "preview"]),
  rawEnv("NEXT_PUBLIC_ANALYTICS_ID", ["preview"]),
];

/** STRIPE_SECRET_KEY exists, but only in Production — `elsewhere` for a preview run. */
const ENV_STRIPE_ELSEWHERE = [
  rawEnv("NEXT_PUBLIC_SITE_URL", ["production", "preview"]),
  rawEnv("NEXT_PUBLIC_ANALYTICS_ID", ["preview"]),
  rawEnv("STRIPE_SECRET_KEY", ["production"]),
  rawEnv("DATABASE_URL", ["production", "preview"]),
];

type VercelScript = {
  envs?: Record<string, unknown>[];
  envStatus?: number;
  envBody?: unknown;
  envError?: Error;
  projects?: Record<string, unknown>[];
  reportStatus?: number;
  reportError?: Error;
};

/** An injected `fetch` that answers the Vercel API and the license report endpoint. */
function vercelRecorder(script: VercelScript = {}): FetchRecorder {
  const recorder = createFetchRecorder((request) => {
    if (request.method === "POST") {
      if (script.reportError) return script.reportError;
      return { status: script.reportStatus ?? 200, body: { ok: true, alerted: [] } };
    }
    if (/\/projects\/[^/?]+\/env/.test(request.url)) {
      if (script.envError) return script.envError;
      if (script.envBody !== undefined) {
        return { status: script.envStatus ?? 200, body: script.envBody };
      }
      return { status: script.envStatus ?? 200, body: { envs: script.envs ?? [] } };
    }
    if (/\/projects(\?|$)/.test(request.url)) {
      return { body: { projects: script.projects ?? [] } };
    }
    return { status: 404, body: {} };
  });
  recorders.push(recorder);
  return recorder;
}

/** Deps pointed at a real fixture directory on disk. */
function fixtureDeps(
  root: string,
  script: VercelScript = {},
  over: Partial<RunDeps> = {},
): { deps: RunDeps; rec: RunRecorders; recorder: FetchRecorder } {
  const recorder = vercelRecorder(script);
  const { deps, rec } = createRunDeps({
    fetch: recorder.fetch,
    fs: nodeFileSystem,
    cwd: root,
    env: {},
    ...over,
  });
  return { deps, rec, recorder };
}

function nextInputs(over: Partial<Inputs> = {}): Inputs {
  return makeInputs({ project: "prj_next", path: ".", target: "preview", ...over });
}

/** Every property name appearing anywhere in a parsed JSON body. */
function deepKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) deepKeys(entry, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      deepKeys(entry, out);
    }
  }
  return out;
}

/** Everything a run can possibly surface to a human, as one searchable string. */
function everythingEmitted(
  result: { markdown: string; outputs: Record<string, string>; annotations: unknown },
  rec: RunRecorders,
): string {
  return JSON.stringify({
    markdown: result.markdown,
    outputs: result.outputs,
    annotations: result.annotations,
    emittedAnnotations: rec.annotations,
    logs: rec.logs.all(),
    summaries: rec.summaries,
    written: rec.writtenFiles,
    comments: rec.github.created.concat(rec.github.updated.map((u) => u.body)),
  });
}

function fakeClient(over: Partial<VercelClient> = {}): VercelClient {
  return {
    listEnv: over.listEnv ?? (async () => []),
    findProject: over.findProject ?? (async () => null),
  };
}

function isCliError(value: CliArgs | CliError): value is CliError {
  return "message" in value;
}

/* -------------------------------------------------------------------------- */

describe("Inputs — parsing the raw action input strings", () => {
  it("splits a comma-separated list into entries", () => {
    expect(parseList("A,B,C")).toEqual(["A", "B", "C"]);
  });

  it("splits a newline-separated list into entries", () => {
    expect(parseList("A\nB\nC")).toEqual(["A", "B", "C"]);
  });

  it("splits a list that mixes commas and newlines", () => {
    expect(parseList("A,B\nC, D")).toEqual(["A", "B", "C", "D"]);
  });

  it("trims surrounding whitespace from every entry", () => {
    expect(parseList("  A  ,\tB\t\n  C ")).toEqual(["A", "B", "C"]);
  });

  it("drops empty entries left by trailing separators", () => {
    expect(parseList("A,,B,\n\n")).toEqual(["A", "B"]);
  });

  it("returns an empty list for an empty input", () => {
    expect(parseList("")).toEqual([]);
  });

  it("returns an empty list for whitespace only", () => {
    expect(parseList("   \n  ")).toEqual([]);
  });

  it("reads true and false case-insensitively", () => {
    expect(parseBoolean("TRUE", false)).toBe(true);
    expect(parseBoolean("False", true)).toBe(false);
  });

  it("reads 1 and 0 as booleans", () => {
    expect(parseBoolean("1", false)).toBe(true);
    expect(parseBoolean("0", true)).toBe(false);
  });

  it("reads yes and no as booleans", () => {
    expect(parseBoolean("yes", false)).toBe(true);
    expect(parseBoolean("no", true)).toBe(false);
  });

  it("falls back for a value it does not recognise", () => {
    expect(parseBoolean("maybe", true)).toBe(true);
    expect(parseBoolean("maybe", false)).toBe(false);
  });

  it("falls back for an empty string", () => {
    expect(parseBoolean("", true)).toBe(true);
  });

  it("accepts each documented fail_on value", () => {
    expect(parseFailOn("missing")).toBe("missing");
    expect(parseFailOn("elsewhere")).toBe("elsewhere");
    expect(parseFailOn("never")).toBe("never");
  });

  it("falls back to elsewhere for an unrecognised fail_on", () => {
    expect(parseFailOn("sometimes")).toBe("elsewhere");
  });
});

describe("Behaviour — a passing run", () => {
  it("exits 0 when every referenced key is present in the target", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.exitCode).toBe(0);
  });

  it("reports status pass on the report and the output", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.report.status).toBe("pass");
    expect(result.outputs.status).toBe("pass");
    expect(rec.outputs.values.status).toBe("pass");
  });

  it("writes the step summary exactly once", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    await runEnvContract(nextInputs(), deps);
    expect(rec.summaries).toHaveLength(1);
  });

  it("emits no annotations when nothing is missing", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.annotations).toEqual([]);
    expect(rec.annotations).toEqual([]);
  });

  it("reports zero missing keys on the outputs", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.outputs.missing).toBe("");
    expect(result.outputs.missing_count).toBe("0");
  });

  it("treats a key declared in .env.example but absent from code as unused, not a failure", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs(), deps);
    const legacy = result.report.findings.find((f) => f.key === "LEGACY_API_TOKEN");
    expect(legacy?.status).toBe("unused");
    expect(result.report.status).toBe("pass");
  });

  it("never reports a platform built-in such as NODE_ENV", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.report.findings.map((f) => f.key)).not.toContain("NODE_ENV");
  });

  it("scans an absolute path input without resolving it against cwd", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT }, { cwd: "/nowhere" });
    const result = await runEnvContract(nextInputs({ path: FIXTURE_NEXT }), deps);
    expect(result.report.status).toBe("pass");
  });

  it("scans a Vite app through import.meta.env", async () => {
    const { deps } = fixtureDeps(FIXTURE_VITE, {
      envs: [
        rawEnv("VITE_API_URL", ["preview"]),
        rawEnv("VITE_SENTRY_DSN", ["preview"]),
        rawEnv("VITE_ANALYTICS_URL", ["preview"]),
      ],
    });
    const result = await runEnvContract(nextInputs({ project: "prj_vite" }), deps);
    expect(result.report.status).toBe("pass");
    expect(result.report.findings.map((f) => f.key)).not.toContain("MODE");
  });

  it("scans every package of a monorepo", async () => {
    const { deps } = fixtureDeps(FIXTURE_MONOREPO, { envs: [] });
    const result = await runEnvContract(nextInputs({ project: "prj_mono" }), deps);
    const keys = result.report.findings.map((f) => f.key);
    expect(keys).toContain("API_SECRET");
    expect(keys).toContain("NEXT_PUBLIC_WEB_URL");
  });
});

describe("Behaviour — a failing run", () => {
  it("exits 1 when a required key is missing from the target", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe("fail");
  });

  it("sets the status output to fail", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.outputs.status).toBe("fail");
    expect(rec.outputs.values.status).toBe("fail");
  });

  it("lists the missing keys as a sorted comma-separated output", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.outputs.missing).toBe("DATABASE_URL,STRIPE_SECRET_KEY");
  });

  it("counts the missing keys on the missing_count output", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.outputs.missing_count).toBe("2");
  });

  it("names a report_json path that was actually written", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.outputs.report_json).not.toBe("");
    expect(rec.writtenFiles[result.outputs.report_json]).toBeDefined();
  });

  it("writes a report_json file whose contents parse as the JSON report", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(nextInputs(), deps);
    const written = rec.writtenFiles[result.outputs.report_json] ?? "";
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed["status"]).toBe("fail");
    expect(parsed["target"]).toBe("preview");
    expect(Array.isArray(parsed["findings"])).toBe(true);
  });

  it("writes the report under RUNNER_TEMP when the runner provides one", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING }, {
      env: { RUNNER_TEMP: "/runner/tmp" },
    });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.outputs.report_json.startsWith("/runner/tmp")).toBe(true);
  });

  it("puts the rendered markdown on the summary output", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.outputs.summary).toBe(result.markdown);
    expect(result.markdown.startsWith(REPORT_MARKER)).toBe(true);
  });

  it("writes the step summary on a failing run too", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    await runEnvContract(nextInputs(), deps);
    expect(rec.summaries).toHaveLength(1);
  });

  it("emits one annotation per missing key", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(nextInputs(), deps);
    const missing = result.annotations.filter((a) => a.level === "error");
    expect(missing).toHaveLength(2);
    expect(rec.annotations).toEqual(result.annotations);
  });

  it("points each annotation at the file and line of the first reference", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(nextInputs(), deps);
    const stripe = result.annotations.find((a) => a.title.includes("STRIPE_SECRET_KEY"));
    expect(stripe?.file).toContain("stripe.ts");
    expect(stripe?.line).toBeGreaterThan(0);
  });

  it("produces a byte-identical report across two identical runs (I3)", async () => {
    const first = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const second = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const a = await runEnvContract(nextInputs(), first.deps);
    const b = await runEnvContract(nextInputs(), second.deps);
    expect(a.markdown).toBe(b.markdown);
    expect(first.rec.writtenFiles[a.outputs.report_json]).toBe(
      second.rec.writtenFiles[b.outputs.report_json],
    );
  });

  it("produces the same report when the Vercel rows arrive in a different order (I3)", async () => {
    const forward = fixtureDeps(FIXTURE_NEXT, { envs: ENV_STRIPE_ELSEWHERE });
    const reversed = fixtureDeps(FIXTURE_NEXT, { envs: [...ENV_STRIPE_ELSEWHERE].reverse() });
    const a = await runEnvContract(nextInputs(), forward.deps);
    const b = await runEnvContract(nextInputs(), reversed.deps);
    expect(a.markdown).toBe(b.markdown);
  });
});

describe("Behaviour — fail_on", () => {
  it("fails on an elsewhere finding by default", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_STRIPE_ELSEWHERE });
    const result = await runEnvContract(nextInputs({ fail_on: "elsewhere" }), deps);
    expect(result.report.status).toBe("fail");
    expect(result.exitCode).toBe(1);
  });

  it("passes an elsewhere finding when fail_on is missing", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_STRIPE_ELSEWHERE });
    const result = await runEnvContract(nextInputs({ fail_on: "missing" }), deps);
    expect(result.report.status).toBe("pass");
    expect(result.exitCode).toBe(0);
  });

  it("still fails a genuinely missing key when fail_on is missing", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(nextInputs({ fail_on: "missing" }), deps);
    expect(result.report.status).toBe("fail");
  });

  it("passes a missing key when fail_on is never", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(nextInputs({ fail_on: "never" }), deps);
    expect(result.report.status).toBe("pass");
    expect(result.exitCode).toBe(0);
  });

  it("still reports the missing keys on the outputs when fail_on is never", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(nextInputs({ fail_on: "never" }), deps);
    expect(result.outputs.missing_count).toBe("2");
  });
});

describe("Behaviour — scan-shaping inputs", () => {
  it("skips test files by default", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.report.findings.map((f) => f.key)).not.toContain("STRIPE_TEST_ONLY_KEY");
  });

  it("scans test files when include_tests is on", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs({ include_tests: "true" }), deps);
    expect(result.report.findings.map((f) => f.key)).toContain("STRIPE_TEST_ONLY_KEY");
  });

  it("drops a directory named by the exclude input", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs({ exclude: "lib/**" }), deps);
    expect(result.report.findings.map((f) => f.key)).not.toContain("STRIPE_SECRET_KEY");
  });

  it("drops a key named by the ignore input", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(
      nextInputs({ ignore: "STRIPE_SECRET_KEY,DATABASE_URL" }),
      deps,
    );
    expect(result.report.status).toBe("pass");
    expect(result.outputs.missing).toBe("");
  });

  it("drops keys matched by a PREFIX_* ignore glob", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(nextInputs({ ignore: "DATABASE_*\nSTRIPE_*" }), deps);
    expect(result.outputs.missing).toBe("");
  });

  it("downgrades a key named by the optional input", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    const result = await runEnvContract(
      nextInputs({ optional: "STRIPE_SECRET_KEY,DATABASE_URL" }),
      deps,
    );
    const stripe = result.report.findings.find((f) => f.key === "STRIPE_SECRET_KEY");
    expect(stripe?.status).toBe("missing_optional");
    expect(result.report.status).toBe("pass");
  });

  it("forces a key named by the required input even when it is not in the code", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs({ required: "SENTRY_DSN" }), deps);
    const sentry = result.report.findings.find((f) => f.key === "SENTRY_DSN");
    expect(sentry?.status).toBe("missing");
    expect(result.report.status).toBe("fail");
  });
});

describe("Sticky PR comment", () => {
  it("creates a comment carrying the report marker on a pull request", async () => {
    const github = createFakeGitHub({ eventName: "pull_request", prNumber: 7 });
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING }, { github });
    await runEnvContract(nextInputs({ comment: "true" }), deps);
    expect(rec.github.created).toHaveLength(1);
    expect(rec.github.created[0]).toContain(REPORT_MARKER);
  });

  it("updates the existing marker comment on a second run instead of duplicating it", async () => {
    const github = createFakeGitHub({ eventName: "pull_request", prNumber: 7 });
    const first = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING }, { github });
    await runEnvContract(nextInputs({ comment: "true" }), first.deps);
    const second = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT }, { github });
    await runEnvContract(nextInputs({ comment: "true" }), second.deps);
    expect(github.created).toHaveLength(1);
    expect(github.updated).toHaveLength(1);
    expect(github.comments).toHaveLength(1);
  });

  it("leaves an unrelated comment alone when picking the sticky one", async () => {
    const github = createFakeGitHub({ eventName: "pull_request", prNumber: 7 });
    await github.createComment(7, "a human wrote this");
    github.created.length = 0;
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING }, { github });
    await runEnvContract(nextInputs({ comment: "true" }), deps);
    expect(github.updated).toHaveLength(0);
    expect(github.created).toHaveLength(1);
    expect(github.comments[0]?.body).toBe("a human wrote this");
  });

  it("posts nothing when comment is false", async () => {
    const github = createFakeGitHub({ eventName: "pull_request", prNumber: 7 });
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING }, { github });
    await runEnvContract(nextInputs({ comment: "false" }), deps);
    expect(github.created).toHaveLength(0);
    expect(github.updated).toHaveLength(0);
  });

  it("posts nothing on a push event even when comment is true", async () => {
    const github = createFakeGitHub({ eventName: "push", prNumber: null });
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING }, { github });
    await runEnvContract(nextInputs({ comment: "true" }), deps);
    expect(github.created).toHaveLength(0);
  });

  it("downgrades a GitHub 403 on create to a warning without changing the status", async () => {
    const github = createFakeGitHub({
      eventName: "pull_request",
      prNumber: 7,
      createComment: async () => {
        throw new Error("HttpError: Resource not accessible by integration (403)");
      },
    });
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING }, { github });
    const result = await runEnvContract(nextInputs({ comment: "true" }), deps);
    expect(result.report.status).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(rec.logs.warnings.join("\n")).toMatch(/comment/i);
  });

  it("downgrades a GitHub 403 on update to a warning without changing the status", async () => {
    const github = createFakeGitHub({
      eventName: "pull_request",
      prNumber: 7,
      listComments: async () => [{ id: 99, body: `${REPORT_MARKER}\nold report` }],
      updateComment: async () => {
        throw new Error("HttpError: Resource not accessible by integration (403)");
      },
    });
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT }, { github });
    const result = await runEnvContract(nextInputs({ comment: "true" }), deps);
    expect(result.report.status).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(rec.logs.warnings.join("\n")).toMatch(/comment/i);
  });

  it("downgrades a failure to list comments to a warning", async () => {
    const github = createFakeGitHub({
      eventName: "pull_request",
      prNumber: 7,
      listComments: async () => {
        throw new Error("HttpError: 403");
      },
    });
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT }, { github });
    const result = await runEnvContract(nextInputs({ comment: "true" }), deps);
    expect(result.report.status).toBe("pass");
    expect(rec.logs.warnings.length).toBeGreaterThan(0);
  });
});

describe("Project auto-detect", () => {
  it("uses the project input verbatim", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const resolution = await resolveProject(nextInputs({ project: "prj_input" }), deps, fakeClient());
    expect(resolution).toEqual({ idOrName: "prj_input", source: "input" });
  });

  it("falls back to the VERCEL_PROJECT_ID environment variable", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, {}, { env: { VERCEL_PROJECT_ID: "prj_env" } });
    const resolution = await resolveProject(nextInputs({ project: "" }), deps, fakeClient());
    expect(resolution).toEqual({ idOrName: "prj_env", source: "env" });
  });

  it("falls back to .vercel/project.json", async () => {
    const { deps } = createRunDeps({
      cwd: "/repo",
      env: {},
      files: {
        "/repo/.vercel/project.json": JSON.stringify({ projectId: "prj_json", orgId: "team_json" }),
      },
    });
    const resolution = await resolveProject(nextInputs({ project: "" }), deps, fakeClient());
    expect(resolution).toEqual({ idOrName: "prj_json", source: "project_json" });
  });

  it("falls back to the Vercel repository link", async () => {
    const { deps } = createRunDeps({ cwd: "/repo", env: {} });
    const client = fakeClient({ findProject: async () => ({ id: "prj_link", name: "envcontract" }) });
    const resolution = await resolveProject(nextInputs({ project: "" }), deps, client);
    expect(resolution.idOrName).toBe("prj_link");
    expect(resolution.source).toBe("repo_link");
  });

  it("prefers the input over every other source", async () => {
    const { deps } = createRunDeps({
      cwd: "/repo",
      env: { VERCEL_PROJECT_ID: "prj_env" },
      files: { "/repo/.vercel/project.json": JSON.stringify({ projectId: "prj_json" }) },
    });
    const client = fakeClient({ findProject: async () => ({ id: "prj_link", name: "x" }) });
    const resolution = await resolveProject(nextInputs({ project: "prj_input" }), deps, client);
    expect(resolution.idOrName).toBe("prj_input");
  });

  it("prefers the environment variable over .vercel/project.json and the repo link", async () => {
    const { deps } = createRunDeps({
      cwd: "/repo",
      env: { VERCEL_PROJECT_ID: "prj_env" },
      files: { "/repo/.vercel/project.json": JSON.stringify({ projectId: "prj_json" }) },
    });
    const client = fakeClient({ findProject: async () => ({ id: "prj_link", name: "x" }) });
    const resolution = await resolveProject(nextInputs({ project: "" }), deps, client);
    expect(resolution.idOrName).toBe("prj_env");
  });

  it("prefers .vercel/project.json over the repo link", async () => {
    const { deps } = createRunDeps({
      cwd: "/repo",
      env: {},
      files: { "/repo/.vercel/project.json": JSON.stringify({ projectId: "prj_json" }) },
    });
    const client = fakeClient({ findProject: async () => ({ id: "prj_link", name: "x" }) });
    const resolution = await resolveProject(nextInputs({ project: "" }), deps, client);
    expect(resolution.idOrName).toBe("prj_json");
  });

  it("requests the resolved project id from the Vercel API", async () => {
    const { deps, recorder } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    await runEnvContract(nextInputs({ project: "prj_from_input" }), deps);
    const envRequest = recorder.requests.find((r) => r.url.includes("/env"));
    expect(envRequest?.url).toContain("/projects/prj_from_input/env");
  });

  it("reports an error status when no project can be resolved", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { projects: [] });
    const result = await runEnvContract(nextInputs({ project: "" }), deps);
    expect(result.report.status).toBe("error");
    expect(result.exitCode).toBe(1);
    expect(rec.logs.errors.join("\n")).toMatch(/project/i);
  });

  it("reports an error naming the candidates when the repo link is ambiguous", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, {
      projects: [
        { id: "prj_a", name: "web", link: { type: "github", org: "JordanCoin", repo: "envcontract" } },
        { id: "prj_b", name: "api", link: { type: "github", org: "JordanCoin", repo: "envcontract" } },
      ],
    });
    const result = await runEnvContract(nextInputs({ project: "" }), deps);
    expect(result.report.status).toBe("error");
    const message = rec.logs.errors.join("\n");
    expect(message).toContain("web");
    expect(message).toContain("api");
  });
});

describe("Team id", () => {
  it("uses the team_id input verbatim", async () => {
    const { deps } = createRunDeps({ cwd: "/repo", env: {} });
    await expect(resolveTeamId(nextInputs({ team_id: "team_input" }), deps)).resolves.toBe(
      "team_input",
    );
  });

  it("falls back to VERCEL_ORG_ID", async () => {
    const { deps } = createRunDeps({ cwd: "/repo", env: { VERCEL_ORG_ID: "team_org" } });
    await expect(resolveTeamId(nextInputs({ team_id: "" }), deps)).resolves.toBe("team_org");
  });

  it("falls back to VERCEL_TEAM_ID when VERCEL_ORG_ID is absent", async () => {
    const { deps } = createRunDeps({ cwd: "/repo", env: { VERCEL_TEAM_ID: "team_alt" } });
    await expect(resolveTeamId(nextInputs({ team_id: "" }), deps)).resolves.toBe("team_alt");
  });

  it("prefers VERCEL_ORG_ID over VERCEL_TEAM_ID", async () => {
    const { deps } = createRunDeps({
      cwd: "/repo",
      env: { VERCEL_ORG_ID: "team_org", VERCEL_TEAM_ID: "team_alt" },
    });
    await expect(resolveTeamId(nextInputs({ team_id: "" }), deps)).resolves.toBe("team_org");
  });

  it("falls back to the orgId in .vercel/project.json", async () => {
    const { deps } = createRunDeps({
      cwd: "/repo",
      env: {},
      files: { "/repo/.vercel/project.json": JSON.stringify({ orgId: "team_json" }) },
    });
    await expect(resolveTeamId(nextInputs({ team_id: "" }), deps)).resolves.toBe("team_json");
  });

  it("resolves to null when no team id is configured anywhere", async () => {
    const { deps } = createRunDeps({ cwd: "/repo", env: {} });
    await expect(resolveTeamId(nextInputs({ team_id: "" }), deps)).resolves.toBeNull();
  });

  it("sends the resolved team id as a teamId query parameter", async () => {
    const { deps, recorder } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    await runEnvContract(nextInputs({ team_id: "team_xyz" }), deps);
    const envRequest = recorder.requests.find((r) => r.url.includes("/env"));
    expect(envRequest?.url).toContain("teamId=team_xyz");
  });

  it("omits teamId from the request when no team id is configured", async () => {
    const { deps, recorder } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    await runEnvContract(nextInputs({ team_id: "" }), deps);
    const envRequest = recorder.requests.find((r) => r.url.includes("/env"));
    expect(envRequest?.url).not.toContain("teamId");
  });
});

describe("Branch", () => {
  it("uses the branch input verbatim", () => {
    const { deps } = createRunDeps({
      env: { GITHUB_HEAD_REF: "from-head", GITHUB_REF_NAME: "from-ref" },
    });
    expect(resolveBranch(nextInputs({ branch: "from-input" }), deps)).toBe("from-input");
  });

  it("prefers GITHUB_HEAD_REF over GITHUB_REF_NAME", () => {
    const { deps } = createRunDeps({
      env: { GITHUB_HEAD_REF: "feature/x", GITHUB_REF_NAME: "12/merge" },
    });
    expect(resolveBranch(nextInputs({ branch: "" }), deps)).toBe("feature/x");
  });

  it("uses GITHUB_REF_NAME when GITHUB_HEAD_REF is absent", () => {
    const { deps } = createRunDeps({ env: { GITHUB_REF_NAME: "main" } });
    expect(resolveBranch(nextInputs({ branch: "" }), deps)).toBe("main");
  });

  it("uses GITHUB_REF_NAME when GITHUB_HEAD_REF is set but empty", () => {
    const { deps } = createRunDeps({ env: { GITHUB_HEAD_REF: "", GITHUB_REF_NAME: "main" } });
    expect(resolveBranch(nextInputs({ branch: "" }), deps)).toBe("main");
  });

  it("treats a <n>/merge ref name as an unknown branch", () => {
    const { deps } = createRunDeps({ env: { GITHUB_REF_NAME: "12/merge" } });
    expect(resolveBranch(nextInputs({ branch: "" }), deps)).toBeNull();
  });

  it("resolves to null when neither ref variable is set", () => {
    const { deps } = createRunDeps({ env: {} });
    expect(resolveBranch(nextInputs({ branch: "" }), deps)).toBeNull();
  });

  it("carries the resolved branch onto the report", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs({ branch: "feature/x" }), deps);
    expect(result.report.branch).toBe("feature/x");
  });
});

describe("target: auto", () => {
  it("resolves to production on a push to the default branch", () => {
    const github = createFakeGitHub({ eventName: "push", defaultBranch: "main", prNumber: null });
    const { deps } = createRunDeps({ github, env: { GITHUB_REF_NAME: "main" } });
    expect(resolveTarget(nextInputs({ target: "auto" }), deps)).toBe("production");
  });

  it("resolves to preview on a push to any other branch", () => {
    const github = createFakeGitHub({ eventName: "push", defaultBranch: "main", prNumber: null });
    const { deps } = createRunDeps({ github, env: { GITHUB_REF_NAME: "feature/x" } });
    expect(resolveTarget(nextInputs({ target: "auto" }), deps)).toBe("preview");
  });

  it("resolves to preview on a pull request against the default branch", () => {
    const github = createFakeGitHub({ eventName: "pull_request", defaultBranch: "main" });
    const { deps } = createRunDeps({ github, env: { GITHUB_HEAD_REF: "feature/x" } });
    expect(resolveTarget(nextInputs({ target: "auto" }), deps)).toBe("preview");
  });

  it("passes an explicit production target straight through", () => {
    const github = createFakeGitHub({ eventName: "pull_request" });
    const { deps } = createRunDeps({ github, env: {} });
    expect(resolveTarget(nextInputs({ target: "production" }), deps)).toBe("production");
  });

  it("passes an explicit development target straight through", () => {
    const github = createFakeGitHub({ eventName: "push", defaultBranch: "main" });
    const { deps } = createRunDeps({ github, env: { GITHUB_REF_NAME: "main" } });
    expect(resolveTarget(nextInputs({ target: "development" }), deps)).toBe("development");
  });

  it("checks the production environment end to end when auto resolves to production", async () => {
    const github = createFakeGitHub({ eventName: "push", defaultBranch: "main", prNumber: null });
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT }, {
      github,
      env: { GITHUB_REF_NAME: "main" },
    });
    const result = await runEnvContract(nextInputs({ target: "auto" }), deps);
    expect(result.report.target).toBe("production");
  });

  it("reports an error for a target string it does not recognise", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs({ target: "staging" }), deps);
    expect(result.report.status).toBe("error");
    expect(result.exitCode).toBe(1);
  });
});

describe("License report upload", () => {
  it("posts nothing when no license key is configured", async () => {
    const { deps, recorder } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    await runEnvContract(nextInputs({ license_key: "" }), deps);
    expect(recorder.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("posts the report exactly once to report_url when a license key is set", async () => {
    const { deps, recorder } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    await runEnvContract(
      nextInputs({ license_key: "lic_abc", report_url: "https://envcontract.dev/api/report" }),
      deps,
    );
    const posts = recorder.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("https://envcontract.dev/api/report");
  });

  it("authenticates the upload with the license key as a bearer token", async () => {
    const { deps, recorder } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    await runEnvContract(nextInputs({ license_key: "lic_abc" }), deps);
    const post = recorder.requests.find((r) => r.method === "POST");
    expect(post?.headers["authorization"]).toBe("Bearer lic_abc");
  });

  it("uploads only repo, sha, target and report", async () => {
    const { deps, recorder } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING });
    await runEnvContract(nextInputs({ license_key: "lic_abc" }), deps);
    const post = recorder.requests.find((r) => r.method === "POST");
    const body = JSON.parse(post?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["repo", "sha", "target", "report"].sort());
  });

  it("uploads a body that carries no value field anywhere (I1)", async () => {
    const { deps, recorder } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    await runEnvContract(nextInputs({ license_key: "lic_abc" }), deps);
    const post = recorder.requests.find((r) => r.method === "POST");
    const body = JSON.parse(post?.body ?? "{}") as unknown;
    expect(deepKeys(body)).not.toContain("value");
    expect(post?.body ?? "").not.toContain(PLANTED);
  });

  it("identifies the repository and commit in the uploaded body", async () => {
    const github = createFakeGitHub({ repo: { owner: "JordanCoin", repo: "envcontract" }, sha: "b".repeat(40) });
    const { deps, recorder } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_TWO_MISSING }, { github });
    await runEnvContract(nextInputs({ license_key: "lic_abc" }), deps);
    const post = recorder.requests.find((r) => r.method === "POST");
    const body = JSON.parse(post?.body ?? "{}") as Record<string, unknown>;
    expect(body["repo"]).toBe("JordanCoin/envcontract");
    expect(body["sha"]).toBe("b".repeat(40));
  });

  it("downgrades a 500 from report_url to a warning without changing the status", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, {
      envs: ENV_TWO_MISSING,
      reportStatus: 500,
    });
    const result = await runEnvContract(nextInputs({ license_key: "lic_abc" }), deps);
    expect(result.report.status).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(rec.logs.warnings.length).toBeGreaterThan(0);
  });

  it("downgrades a rejected upload to a warning without changing the status", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, {
      envs: ENV_ALL_PRESENT,
      reportError: new TypeError("fetch failed"),
    });
    const result = await runEnvContract(nextInputs({ license_key: "lic_abc" }), deps);
    expect(result.report.status).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(rec.logs.warnings.length).toBeGreaterThan(0);
  });

  it("omits the free footer from the summary when a license key is configured", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs({ license_key: "lic_abc" }), deps);
    expect(result.markdown).not.toContain("https://envcontract.dev\n");
  });
});

describe("I1 — never see, log, store or emit a value", () => {
  it("never leaks a planted value on a successful run", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs(), deps);
    expect(everythingEmitted(result, rec)).not.toContain(PLANTED);
  });

  it("never leaks a planted value on a failing run", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_STRIPE_ELSEWHERE });
    const result = await runEnvContract(nextInputs(), deps);
    expect(everythingEmitted(result, rec)).not.toContain(PLANTED);
  });

  it("never leaks a value carried in an error body", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, {
      envStatus: 401,
      envBody: { error: { code: "forbidden", message: `token rejected: ${PLANTED}` } },
    });
    const result = await runEnvContract(nextInputs({ on_error: "warn" }), deps);
    expect(everythingEmitted(result, rec)).not.toContain(PLANTED);
  });

  it("never echoes the Vercel token into the summary, logs or outputs", async () => {
    const token = "vcp_super_secret_token_value";
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envStatus: 403, envBody: {} });
    const result = await runEnvContract(
      nextInputs({ vercel_token: token, on_error: "warn" }),
      deps,
    );
    expect(everythingEmitted(result, rec)).not.toContain(token);
  });

  it("never puts a value field on any finding", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    const result = await runEnvContract(nextInputs(), deps);
    expect(deepKeys(result.report.findings)).not.toContain("value");
  });
});

describe("I2 — fail closed", () => {
  it("reports an error status and exits 1 when the token is rejected", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envStatus: 401, envBody: {} });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.report.status).toBe("error");
    expect(result.exitCode).toBe(1);
  });

  it("says the token is invalid when Vercel answers 401", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envStatus: 401, envBody: {} });
    await runEnvContract(nextInputs(), deps);
    expect(rec.logs.errors.join("\n")).toMatch(/token/i);
  });

  it("hints at the team id or token scope when Vercel answers 403", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envStatus: 403, envBody: {} });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.report.status).toBe("error");
    expect(rec.logs.errors.join("\n")).toMatch(/team|scope/i);
  });

  it("reports an error status when the project is not found", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envStatus: 404, envBody: {} });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.report.status).toBe("error");
    expect(result.exitCode).toBe(1);
  });

  it("reports an error status when the network fails", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envError: new TypeError("fetch failed") });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.report.status).toBe("error");
    expect(result.exitCode).toBe(1);
  });

  it("reports an error status when Vercel returns malformed JSON", async () => {
    const recorder = createFetchRecorder({ status: 200, text: "<html>gateway</html>" });
    recorders.push(recorder);
    const { deps } = createRunDeps({
      fetch: recorder.fetch,
      fs: nodeFileSystem,
      cwd: FIXTURE_NEXT,
      env: {},
    });
    const result = await runEnvContract(nextInputs(), deps);
    expect(result.report.status).toBe("error");
  });

  it("downgrades an error to a warning and exits 0 when on_error is warn", async () => {
    const { deps, rec } = fixtureDeps(FIXTURE_NEXT, { envStatus: 401, envBody: {} });
    const result = await runEnvContract(nextInputs({ on_error: "warn" }), deps);
    expect(result.exitCode).toBe(0);
    expect(rec.logs.warnings.length).toBeGreaterThan(0);
  });

  it("still marks the report as error when on_error is warn", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envStatus: 401, envBody: {} });
    const result = await runEnvContract(nextInputs({ on_error: "warn" }), deps);
    expect(result.report.status).toBe("error");
    expect(result.outputs.status).toBe("error");
  });

  it("keeps exit 1 when on_error is left at its fail default", async () => {
    const { deps } = fixtureDeps(FIXTURE_NEXT, { envStatus: 500, envBody: {} });
    const result = await runEnvContract(nextInputs({ on_error: "fail" }), deps);
    expect(result.exitCode).toBe(1);
  });
});

describe("I4 — read-only", () => {
  it("sends only GET requests to the Vercel API", async () => {
    const { deps, recorder } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    await runEnvContract(nextInputs({ license_key: "lic_abc" }), deps);
    for (const request of recorder.requests) {
      if (request.url.startsWith("https://api.vercel.com")) expect(request.method).toBe("GET");
    }
  });

  it("sends the only non-GET request to report_url", async () => {
    const { deps, recorder } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    await runEnvContract(nextInputs({ license_key: "lic_abc" }), deps);
    for (const request of recorder.requests) {
      if (request.method !== "GET") expect(request.url).toBe("https://envcontract.dev/api/report");
    }
  });

  it("never asks Vercel to decrypt a value", async () => {
    const { deps, recorder } = fixtureDeps(FIXTURE_NEXT, { envs: ENV_ALL_PRESENT });
    await runEnvContract(nextInputs(), deps);
    assertNoDecrypt(recorder);
  });
});

describe("CLI", () => {
  function cliDeps(script: VercelScript, over: Partial<RunDeps> = {}) {
    const recorder = vercelRecorder(script);
    const lines: string[] = [];
    const { deps, rec } = createRunDeps({
      fetch: recorder.fetch,
      fs: nodeFileSystem,
      cwd: FIXTURE_NEXT,
      env: {},
      ...over,
    });
    return { deps, rec, recorder, lines, write: (line: string) => void lines.push(line) };
  }

  const baseArgv = ["--target", "preview", "--project", "prj_next", "--dir", FIXTURE_NEXT];

  it("exits 0 when the environment is ready", async () => {
    const { deps, write } = cliDeps({ envs: ENV_ALL_PRESENT });
    await expect(cli([...baseArgv, "--token", "vcp_x"], deps, write)).resolves.toBe(0);
  });

  it("exits 1 when a required key is missing", async () => {
    const { deps, write } = cliDeps({ envs: ENV_TWO_MISSING });
    await expect(cli([...baseArgv, "--token", "vcp_x"], deps, write)).resolves.toBe(1);
  });

  it("exits 2 when a required argument is missing", async () => {
    const { deps, write } = cliDeps({ envs: ENV_ALL_PRESENT });
    await expect(cli(["--target"], deps, write)).resolves.toBe(2);
  });

  it("exits 2 for an unknown flag", async () => {
    const { deps, write } = cliDeps({ envs: ENV_ALL_PRESENT });
    await expect(cli([...baseArgv, "--wat"], deps, write)).resolves.toBe(2);
  });

  it("exits 2 when Vercel cannot be reached", async () => {
    const { deps, write } = cliDeps({ envError: new TypeError("fetch failed") });
    await expect(cli([...baseArgv, "--token", "vcp_x"], deps, write)).resolves.toBe(2);
  });

  it("prints the text block on a failing run", async () => {
    const { deps, write, lines } = cliDeps({ envs: ENV_TWO_MISSING });
    await cli([...baseArgv, "--token", "vcp_x"], deps, write);
    const output = lines.join("\n");
    expect(output).toContain("STRIPE_SECRET_KEY");
    expect(output).toContain("Environment readiness: FAIL");
  });

  it("prints parseable JSON with --json", async () => {
    const { deps, write, lines } = cliDeps({ envs: ENV_TWO_MISSING });
    await cli([...baseArgv, "--token", "vcp_x", "--json"], deps, write);
    const parsed = JSON.parse(lines.join("\n")) as Record<string, unknown>;
    expect(parsed["status"]).toBe("fail");
    expect(parsed["target"]).toBe("preview");
  });

  it("prints the same JSON report shape the action writes", async () => {
    const { deps, write, lines } = cliDeps({ envs: ENV_TWO_MISSING });
    await cli([...baseArgv, "--token", "vcp_x", "--json"], deps, write);
    const parsed = JSON.parse(lines.join("\n")) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "branch",
      "counts",
      "dynamicAccess",
      "findings",
      "status",
      "target",
      "version",
    ]);
  });

  it("prints byte-identical JSON across two runs (I3)", async () => {
    const first = cliDeps({ envs: ENV_TWO_MISSING });
    await cli([...baseArgv, "--token", "vcp_x", "--json"], first.deps, first.write);
    const second = cliDeps({ envs: ENV_TWO_MISSING });
    await cli([...baseArgv, "--token", "vcp_x", "--json"], second.deps, second.write);
    expect(first.lines.join("\n")).toBe(second.lines.join("\n"));
  });

  it("prints the usage block and exits 0 for --help", async () => {
    const { deps, write, lines } = cliDeps({ envs: ENV_ALL_PRESENT });
    await expect(cli(["--help"], deps, write)).resolves.toBe(0);
    expect(lines.join("\n")).toContain(USAGE.trimEnd());
  });

  it("falls back to VERCEL_TOKEN from the environment", async () => {
    const { deps, write, recorder } = cliDeps({ envs: ENV_ALL_PRESENT }, {
      env: { VERCEL_TOKEN: "vcp_from_env" },
    });
    await cli(baseArgv, deps, write);
    const envRequest = recorder.requests.find((r) => r.url.includes("/env"));
    expect(envRequest?.headers["authorization"]).toBe("Bearer vcp_from_env");
  });

  it("exits 2 when no token is available at all", async () => {
    const { deps, write } = cliDeps({ envs: ENV_ALL_PRESENT });
    await expect(cli(baseArgv, deps, write)).resolves.toBe(2);
  });

  it("never leaks a planted value to stdout", async () => {
    const { deps, write, lines } = cliDeps({ envs: ENV_ALL_PRESENT });
    await cli([...baseArgv, "--token", "vcp_x"], deps, write);
    expect(lines.join("\n")).not.toContain(PLANTED);
  });
});

describe("CLI — parseArgs", () => {
  it("defaults the scanned directory to the working directory", () => {
    const parsed = parseArgs(["--target", "preview"]);
    expect(isCliError(parsed)).toBe(false);
    if (!isCliError(parsed)) expect(parsed.dir).toBe(".");
  });

  it("defaults fail_on to elsewhere", () => {
    const parsed = parseArgs(["--target", "preview"]);
    if (!isCliError(parsed)) expect(parsed.failOn).toBe("elsewhere");
  });

  it("collects a repeated --ignore flag into a list", () => {
    const parsed = parseArgs(["--target", "preview", "--ignore", "A_*", "--ignore", "B"]);
    if (!isCliError(parsed)) expect(parsed.ignore).toEqual(["A_*", "B"]);
  });

  it("collects repeated --include and --exclude globs", () => {
    const parsed = parseArgs([
      "--target",
      "preview",
      "--include",
      "app/**",
      "--exclude",
      "lib/**",
    ]);
    if (!isCliError(parsed)) {
      expect(parsed.include).toEqual(["app/**"]);
      expect(parsed.exclude).toEqual(["lib/**"]);
    }
  });

  it("reads --include-tests as a flag with no argument", () => {
    const parsed = parseArgs(["--target", "preview", "--include-tests"]);
    if (!isCliError(parsed)) expect(parsed.includeTests).toBe(true);
  });

  it("returns a CliError rather than throwing for a bad --fail-on", () => {
    const parsed = parseArgs(["--target", "preview", "--fail-on", "sometimes"]);
    expect(isCliError(parsed)).toBe(true);
    if (isCliError(parsed)) expect(parsed.exitCode).toBe(2);
  });

  it("returns a CliError rather than throwing for a bad --target", () => {
    const parsed = parseArgs(["--target", "staging"]);
    expect(isCliError(parsed)).toBe(true);
  });

  it("returns a CliError for a flag that is missing its argument", () => {
    const parsed = parseArgs(["--target", "preview", "--project"]);
    expect(isCliError(parsed)).toBe(true);
  });

  it("sets help without requiring any other argument", () => {
    const parsed = parseArgs(["--help"]);
    expect(isCliError(parsed)).toBe(false);
    if (!isCliError(parsed)) expect(parsed.help).toBe(true);
  });

  it("reads --team-id and --branch", () => {
    const parsed = parseArgs([
      "--target",
      "preview",
      "--team-id",
      "team_1",
      "--branch",
      "feature/x",
    ]);
    if (!isCliError(parsed)) {
      expect(parsed.teamId).toBe("team_1");
      expect(parsed.branch).toBe("feature/x");
    }
  });
});

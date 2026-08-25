/**
 * SPEC: docs/SPEC.md — Module C `compare` (pure), plus invariant I3
 * ("Deterministic. Same inputs → byte-identical report. Sorted keys, stable
 * ordering, no timestamps in the body.").
 *
 * The presence oracle below is written straight from the SPEC prose and is the
 * authority every generated matrix case is checked against.
 *
 * Ambiguities resolved here (baked into the assertions):
 *  - Override precedence is `ignore` > `required` > `optional` > inference from
 *    code/`.env.example`. An ignored key is reported with status "ignored" and
 *    is counted in NO counter (ReportCounts has no `ignored` field).
 *  - A key declared optional in `.env.example` (`# KEY=`) but dereferenced
 *    without a fallback in code is REQUIRED — code evidence beats the file.
 *  - `elsewhere` detail grammar: targets in production/preview/development
 *    order, Title Case; one target → "in Production only"; a branch-scoped
 *    preview var → "in Preview for branch `staging` only"; two targets →
 *    "in Production and Development"; three → "in Production, Preview and
 *    Development" (no trailing "only" once there is more than one).
 *  - `compare` never yields status "error"; only the runner sets that (I2).
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  compare,
  describeElsewhere,
  failingStatuses,
  isPresent,
  targetsFor,
  FINDING_ORDER,
  type CompareOptions,
  type Finding,
  type Report,
} from "../src/compare.js";
import type { EnvVar, Target } from "../src/vercel/client.js";
import { VERSION } from "../src/version.js";
import {
  makeDeclared,
  makeEnvVar,
  makeReference,
  makeScanResult,
} from "./helpers/fixtures.js";

/* ------------------------------------------------------------------ oracle */

type PresenceOpts = {
  target: Target;
  branch?: string | undefined;
  customEnvironmentId?: string | undefined;
};

/**
 * The SPEC presence rule, hand-written:
 *
 *   present for `target` iff the var has the key AND (`targets` includes target
 *   OR (customEnvironmentId given AND customEnvironmentIds includes it)) AND
 *   (`gitBranch` is null OR (target === "preview" AND gitBranch === branch))
 *
 * plus the SPEC's addendum: a var scoped to a git branch on a NON-preview target
 * is something Vercel does not allow, so it is treated as present.
 */
function oraclePresent(envVar: EnvVar, opts: PresenceOpts): boolean {
  const inTargets = envVar.targets.includes(opts.target);
  const inCustomEnv =
    opts.customEnvironmentId !== undefined &&
    envVar.customEnvironmentIds.includes(opts.customEnvironmentId);
  if (!inTargets && !inCustomEnv) return false;
  if (envVar.gitBranch === null) return true;
  if (opts.target !== "preview") return true;
  return envVar.gitBranch === opts.branch;
}

/* ----------------------------------------------------------------- helpers */

function options(over: Partial<CompareOptions> = {}): CompareOptions {
  const opts: CompareOptions = {
    target: over.target ?? "preview",
    ignore: over.ignore ?? [],
    optional: over.optional ?? [],
    required: over.required ?? [],
  };
  if (over.branch !== undefined) opts.branch = over.branch;
  if (over.customEnvironmentId !== undefined) opts.customEnvironmentId = over.customEnvironmentId;
  if (over.failOn !== undefined) opts.failOn = over.failOn;
  return opts;
}

function findingFor(report: Report, key: string): Finding {
  const found = report.findings.find((f) => f.key === key);
  if (!found) throw new Error(`no finding for ${key}`);
  return found;
}

function statusOf(report: Report, key: string): string {
  return findingFor(report, key).status;
}

function keysInOrder(report: Report): string[] {
  return report.findings.map((f) => f.key);
}

/** A scan where every listed key is referenced once, non-optionally. */
function scanOf(keys: readonly string[]) {
  return makeScanResult({
    references: keys.map((key, index) =>
      makeReference({ key, file: `src/${key.toLowerCase()}.ts`, line: index + 1 }),
    ),
  });
}

/* ------------------------------------------------------------ Presence rule */

const TARGETS: readonly Target[] = ["production", "preview", "development"];

const TARGET_SETS: readonly { label: string; targets: Target[] }[] = [
  { label: "[]", targets: [] },
  { label: "[production]", targets: ["production"] },
  { label: "[preview]", targets: ["preview"] },
  { label: "[development]", targets: ["development"] },
  { label: "[production,preview]", targets: ["production", "preview"] },
  {
    label: "[production,preview,development]",
    targets: ["production", "preview", "development"],
  },
];

const GIT_BRANCHES: readonly (string | null)[] = [null, "main", "feature/x"];
const BRANCH_INPUTS: readonly (string | undefined)[] = [undefined, "feature/x", "main"];

describe("Presence rule", () => {
  describe("target × var targets × gitBranch × branch input", () => {
    for (const target of TARGETS) {
      for (const set of TARGET_SETS) {
        for (const gitBranch of GIT_BRANCHES) {
          for (const branch of BRANCH_INPUTS) {
            const envVar = makeEnvVar({ targets: [...set.targets], gitBranch });
            const opts: PresenceOpts = { target, branch };
            const expected = oraclePresent(envVar, opts);
            const title =
              `a var scoped to ${set.label} on branch ${String(gitBranch)} ` +
              `is ${expected ? "present" : "absent"} for ${target} ` +
              `when the branch input is ${String(branch)}`;

            it(title, () => {
              expect(isPresent(envVar, opts)).toBe(expected);
            });
          }
        }
      }
    }
  });

  describe("customEnvironmentId", () => {
    it("counts a var with no targets as present when its custom environment matches", () => {
      const envVar = makeEnvVar({ targets: [], customEnvironmentIds: ["ce_alpha"] });
      expect(isPresent(envVar, { target: "preview", customEnvironmentId: "ce_alpha" })).toBe(true);
    });

    it("counts a var as absent when the custom environment does not match", () => {
      const envVar = makeEnvVar({ targets: [], customEnvironmentIds: ["ce_beta"] });
      expect(isPresent(envVar, { target: "preview", customEnvironmentId: "ce_alpha" })).toBe(false);
    });

    it("ignores customEnvironmentIds entirely when no custom environment is requested", () => {
      const envVar = makeEnvVar({ targets: [], customEnvironmentIds: ["ce_alpha"] });
      expect(isPresent(envVar, { target: "preview" })).toBe(false);
    });

    it("still honours a matching target when the custom environment does not match", () => {
      const envVar = makeEnvVar({ targets: ["preview"], customEnvironmentIds: ["ce_beta"] });
      expect(isPresent(envVar, { target: "preview", customEnvironmentId: "ce_alpha" })).toBe(true);
    });

    it("applies the branch rule to a custom-environment match on preview", () => {
      const envVar = makeEnvVar({
        targets: [],
        customEnvironmentIds: ["ce_alpha"],
        gitBranch: "feature/x",
      });
      expect(
        isPresent(envVar, {
          target: "preview",
          branch: "other",
          customEnvironmentId: "ce_alpha",
        }),
      ).toBe(false);
    });
  });

  describe("targetsFor", () => {
    it("lists every target a key exists in, in production/preview/development order", () => {
      const env = [
        makeEnvVar({ key: "A", targets: ["development"] }),
        makeEnvVar({ key: "A", targets: ["production"] }),
      ];
      expect(targetsFor("A", env)).toEqual(["production", "development"]);
    });

    it("returns an empty list for a key that exists in no environment", () => {
      expect(targetsFor("NOPE", [makeEnvVar({ key: "A" })])).toEqual([]);
    });

    it("de-duplicates a target listed by more than one var", () => {
      const env = [
        makeEnvVar({ key: "A", targets: ["preview"], gitBranch: "one" }),
        makeEnvVar({ key: "A", targets: ["preview"], gitBranch: "two" }),
      ];
      expect(targetsFor("A", env)).toEqual(["preview"]);
    });
  });
});

/* ------------------------------------------------------------------ missing */

describe("missing", () => {
  it("reports a required key that exists in no target as missing", () => {
    const report = compare(scanOf(["STRIPE_SECRET_KEY"]), makeDeclared(), [], options());
    expect(statusOf(report, "STRIPE_SECRET_KEY")).toBe("missing");
  });

  it("leaves foundIn empty for a missing key", () => {
    const report = compare(scanOf(["STRIPE_SECRET_KEY"]), makeDeclared(), [], options());
    expect(findingFor(report, "STRIPE_SECRET_KEY").foundIn).toEqual([]);
  });

  it("omits the detail sentence for a missing key", () => {
    const report = compare(scanOf(["STRIPE_SECRET_KEY"]), makeDeclared(), [], options());
    expect("detail" in findingFor(report, "STRIPE_SECRET_KEY")).toBe(false);
  });

  it("fails the report when a required key is missing", () => {
    const report = compare(scanOf(["STRIPE_SECRET_KEY"]), makeDeclared(), [], options());
    expect(report.status).toBe("fail");
  });

  it("does not report a key that is present in the requested target as missing", () => {
    const env = [makeEnvVar({ key: "STRIPE_SECRET_KEY", targets: ["preview"] })];
    const report = compare(scanOf(["STRIPE_SECRET_KEY"]), makeDeclared(), env, options());
    expect(statusOf(report, "STRIPE_SECRET_KEY")).toBe("present");
  });
});

/* ---------------------------------------------------------------- elsewhere */

describe("elsewhere", () => {
  it("reports a required key that exists only in another target as elsewhere", () => {
    const env = [makeEnvVar({ key: "SUPABASE_URL", targets: ["production"] })];
    const report = compare(scanOf(["SUPABASE_URL"]), makeDeclared(), env, options());
    expect(statusOf(report, "SUPABASE_URL")).toBe("elsewhere");
  });

  it("describes a key found in production only as \"in Production only\"", () => {
    const env = [makeEnvVar({ key: "SUPABASE_URL", targets: ["production"] })];
    const report = compare(scanOf(["SUPABASE_URL"]), makeDeclared(), env, options());
    expect(findingFor(report, "SUPABASE_URL").detail).toBe("in Production only");
  });

  it("describes a branch-scoped preview var as \"in Preview for branch `staging` only\"", () => {
    const env = [makeEnvVar({ key: "SUPABASE_URL", targets: ["preview"], gitBranch: "staging" })];
    const report = compare(
      scanOf(["SUPABASE_URL"]),
      makeDeclared(),
      env,
      options({ target: "preview", branch: "feature/x" }),
    );
    expect(findingFor(report, "SUPABASE_URL").detail).toBe(
      "in Preview for branch `staging` only",
    );
  });

  it("joins two targets with \"and\" and drops \"only\"", () => {
    const env = [
      makeEnvVar({ key: "SUPABASE_URL", targets: ["production"] }),
      makeEnvVar({ key: "SUPABASE_URL", targets: ["development"] }),
    ];
    const report = compare(scanOf(["SUPABASE_URL"]), makeDeclared(), env, options());
    expect(findingFor(report, "SUPABASE_URL").detail).toBe("in Production and Development");
  });

  it("joins three targets as \"in Production, Preview and Development\"", () => {
    const env = [
      makeEnvVar({ key: "SUPABASE_URL", targets: ["production", "development"] }),
      makeEnvVar({ key: "SUPABASE_URL", targets: ["preview"], gitBranch: "other" }),
    ];
    const report = compare(
      scanOf(["SUPABASE_URL"]),
      makeDeclared(),
      env,
      options({ target: "preview", branch: "mine" }),
    );
    expect(findingFor(report, "SUPABASE_URL").detail).toBe(
      "in Production, Preview and Development",
    );
  });

  it("lists the other targets in foundIn in production/preview/development order", () => {
    const env = [
      makeEnvVar({ key: "SUPABASE_URL", targets: ["development"] }),
      makeEnvVar({ key: "SUPABASE_URL", targets: ["production"] }),
    ];
    const report = compare(scanOf(["SUPABASE_URL"]), makeDeclared(), env, options());
    expect(findingFor(report, "SUPABASE_URL").foundIn).toEqual(["production", "development"]);
  });

  it("fails the report by default when a key is only elsewhere", () => {
    const env = [makeEnvVar({ key: "SUPABASE_URL", targets: ["production"] })];
    const report = compare(scanOf(["SUPABASE_URL"]), makeDeclared(), env, options());
    expect(report.status).toBe("fail");
  });

  it("treats a preview var on the matching branch as present, not elsewhere", () => {
    const env = [makeEnvVar({ key: "SUPABASE_URL", targets: ["preview"], gitBranch: "feature/x" })];
    const report = compare(
      scanOf(["SUPABASE_URL"]),
      makeDeclared(),
      env,
      options({ target: "preview", branch: "feature/x" }),
    );
    expect(statusOf(report, "SUPABASE_URL")).toBe("present");
  });

  describe("describeElsewhere", () => {
    it("renders a single target with a trailing \"only\"", () => {
      expect(describeElsewhere("A", [makeEnvVar({ key: "A", targets: ["development"] })])).toBe(
        "in Development only",
      );
    });

    it("renders a branch-scoped preview var with the branch in backticks", () => {
      expect(
        describeElsewhere("A", [
          makeEnvVar({ key: "A", targets: ["preview"], gitBranch: "staging" }),
        ]),
      ).toBe("in Preview for branch `staging` only");
    });
  });
});

/* --------------------------------------------------------- missing_optional */

describe("missing_optional", () => {
  it("reports an absent optional key as missing_optional", () => {
    const scan = makeScanResult({
      references: [makeReference({ key: "DEBUG_PANEL", optional: true })],
    });
    const report = compare(scan, makeDeclared(), [], options());
    expect(statusOf(report, "DEBUG_PANEL")).toBe("missing_optional");
  });

  it("does not fail the report for a missing optional key", () => {
    const scan = makeScanResult({
      references: [makeReference({ key: "DEBUG_PANEL", optional: true })],
    });
    const report = compare(scan, makeDeclared(), [], options());
    expect(report.status).toBe("pass");
  });

  it("treats a key with one optional and one required site as required", () => {
    const scan = makeScanResult({
      references: [
        makeReference({ key: "API_URL", file: "src/a.ts", line: 1, optional: true }),
        makeReference({ key: "API_URL", file: "src/b.ts", line: 2, optional: false }),
      ],
    });
    const report = compare(scan, makeDeclared(), [], options());
    expect(statusOf(report, "API_URL")).toBe("missing");
  });

  it("reports an optional key that exists in another target as missing_optional, not elsewhere", () => {
    const scan = makeScanResult({
      references: [makeReference({ key: "DEBUG_PANEL", optional: true })],
    });
    const env = [makeEnvVar({ key: "DEBUG_PANEL", targets: ["production"] })];
    const report = compare(scan, makeDeclared(), env, options());
    expect(statusOf(report, "DEBUG_PANEL")).toBe("missing_optional");
  });

  it("reports an optional key that is present as present", () => {
    const scan = makeScanResult({
      references: [makeReference({ key: "DEBUG_PANEL", optional: true })],
    });
    const env = [makeEnvVar({ key: "DEBUG_PANEL", targets: ["preview"] })];
    const report = compare(scan, makeDeclared(), env, options());
    expect(statusOf(report, "DEBUG_PANEL")).toBe("present");
  });
});

/* ------------------------------------------------------------------- unused */

describe("unused", () => {
  it("reports a key declared in .env.example but never referenced in code as unused", () => {
    const report = compare(
      makeScanResult(),
      makeDeclared({ LEGACY_TOKEN: {} }),
      [],
      options(),
    );
    expect(statusOf(report, "LEGACY_TOKEN")).toBe("unused");
  });

  it("does not fail the report for an unused key", () => {
    const report = compare(makeScanResult(), makeDeclared({ LEGACY_TOKEN: {} }), [], options());
    expect(report.status).toBe("pass");
  });

  it("still reports a declared key as unused when it exists in the environment", () => {
    const env = [makeEnvVar({ key: "LEGACY_TOKEN", targets: ["preview"] })];
    const report = compare(makeScanResult(), makeDeclared({ LEGACY_TOKEN: {} }), env, options());
    expect(statusOf(report, "LEGACY_TOKEN")).toBe("unused");
  });

  it("gives an unused key no sites, because it exists only in .env.example", () => {
    const report = compare(makeScanResult(), makeDeclared({ LEGACY_TOKEN: {} }), [], options());
    expect(findingFor(report, "LEGACY_TOKEN").sites).toEqual([]);
  });

  it("does not report a declared key that IS referenced in code as unused", () => {
    const report = compare(
      scanOf(["LEGACY_TOKEN"]),
      makeDeclared({ LEGACY_TOKEN: {} }),
      [],
      options(),
    );
    expect(statusOf(report, "LEGACY_TOKEN")).toBe("missing");
  });
});

/* ------------------------------------------------------------------ present */

describe("present", () => {
  it("reports a key available in the requested target as present", () => {
    const env = [makeEnvVar({ key: "API_URL", targets: ["preview"] })];
    const report = compare(scanOf(["API_URL"]), makeDeclared(), env, options());
    expect(statusOf(report, "API_URL")).toBe("present");
  });

  it("lists the requested target in foundIn for a present key", () => {
    const env = [makeEnvVar({ key: "API_URL", targets: ["preview", "production"] })];
    const report = compare(scanOf(["API_URL"]), makeDeclared(), env, options());
    expect(findingFor(report, "API_URL").foundIn).toEqual(["production", "preview"]);
  });

  it("passes the report when every required key is present", () => {
    const env = [makeEnvVar({ key: "API_URL", targets: ["preview"] })];
    const report = compare(scanOf(["API_URL"]), makeDeclared(), env, options());
    expect(report.status).toBe("pass");
  });
});

/* ------------------------------------------------------------------ ignored */

describe("ignored", () => {
  it("reports a key listed in the user ignore input as ignored", () => {
    const report = compare(
      scanOf(["ANALYTICS_ID"]),
      makeDeclared(),
      [],
      options({ ignore: ["ANALYTICS_ID"] }),
    );
    expect(statusOf(report, "ANALYTICS_ID")).toBe("ignored");
  });

  it("matches an ignore entry written as a PREFIX_* glob", () => {
    const report = compare(
      scanOf(["INTERNAL_TOKEN"]),
      makeDeclared(),
      [],
      options({ ignore: ["INTERNAL_*"] }),
    );
    expect(statusOf(report, "INTERNAL_TOKEN")).toBe("ignored");
  });

  it("does not match a PREFIX_* glob against a key with a different prefix", () => {
    const report = compare(
      scanOf(["EXTERNAL_TOKEN"]),
      makeDeclared(),
      [],
      options({ ignore: ["INTERNAL_*"] }),
    );
    expect(statusOf(report, "EXTERNAL_TOKEN")).toBe("missing");
  });

  it("keeps an ignored key out of every counter", () => {
    const report = compare(
      scanOf(["ANALYTICS_ID"]),
      makeDeclared(),
      [],
      options({ ignore: ["ANALYTICS_ID"] }),
    );
    expect(report.counts).toEqual({
      missing: 0,
      missing_optional: 0,
      present: 0,
      elsewhere: 0,
      unused: 0,
      dynamic: 0,
    });
  });

  it("passes the report when the only finding is ignored", () => {
    const report = compare(
      scanOf(["ANALYTICS_ID"]),
      makeDeclared(),
      [],
      options({ ignore: ["ANALYTICS_ID"] }),
    );
    expect(report.status).toBe("pass");
  });

  it("ignores a key declared only in .env.example too", () => {
    const report = compare(
      makeScanResult(),
      makeDeclared({ ANALYTICS_ID: {} }),
      [],
      options({ ignore: ["ANALYTICS_ID"] }),
    );
    expect(statusOf(report, "ANALYTICS_ID")).toBe("ignored");
  });
});

/* ----------------------------------------------------------- user overrides */

describe("user overrides", () => {
  it("checks a key named in `required` even though code never references it", () => {
    const report = compare(
      makeScanResult(),
      makeDeclared(),
      [],
      options({ required: ["FORCED_KEY"] }),
    );
    expect(statusOf(report, "FORCED_KEY")).toBe("missing");
  });

  it("gives a forced-required key no sites", () => {
    const report = compare(
      makeScanResult(),
      makeDeclared(),
      [],
      options({ required: ["FORCED_KEY"] }),
    );
    expect(findingFor(report, "FORCED_KEY").sites).toEqual([]);
  });

  it("reports a forced-required key that is present as present", () => {
    const env = [makeEnvVar({ key: "FORCED_KEY", targets: ["preview"] })];
    const report = compare(
      makeScanResult(),
      makeDeclared(),
      env,
      options({ required: ["FORCED_KEY"] }),
    );
    expect(statusOf(report, "FORCED_KEY")).toBe("present");
  });

  it("promotes a declared-but-unused key to required when it is named in `required`", () => {
    const report = compare(
      makeScanResult(),
      makeDeclared({ LEGACY_TOKEN: {} }),
      [],
      options({ required: ["LEGACY_TOKEN"] }),
    );
    expect(statusOf(report, "LEGACY_TOKEN")).toBe("missing");
  });

  it("downgrades a code-required key named in `optional` to missing_optional", () => {
    const report = compare(
      scanOf(["STRIPE_SECRET_KEY"]),
      makeDeclared(),
      [],
      options({ optional: ["STRIPE_SECRET_KEY"] }),
    );
    expect(statusOf(report, "STRIPE_SECRET_KEY")).toBe("missing_optional");
  });

  it("matches an `optional` entry written as a PREFIX_* glob", () => {
    const report = compare(
      scanOf(["DEV_FLAG_ONE"]),
      makeDeclared(),
      [],
      options({ optional: ["DEV_*"] }),
    );
    expect(statusOf(report, "DEV_FLAG_ONE")).toBe("missing_optional");
  });

  it("matches a `required` entry written as a PREFIX_* glob", () => {
    const scan = makeScanResult({
      references: [makeReference({ key: "MUST_HAVE_ONE", optional: true })],
    });
    const report = compare(scan, makeDeclared(), [], options({ required: ["MUST_*"] }));
    expect(statusOf(report, "MUST_HAVE_ONE")).toBe("missing");
  });

  it("lets `ignore` win over `required` for the same key", () => {
    const report = compare(
      scanOf(["SHARED_KEY"]),
      makeDeclared(),
      [],
      options({ ignore: ["SHARED_KEY"], required: ["SHARED_KEY"] }),
    );
    expect(statusOf(report, "SHARED_KEY")).toBe("ignored");
  });

  it("lets `ignore` win over `optional` for the same key", () => {
    const report = compare(
      scanOf(["SHARED_KEY"]),
      makeDeclared(),
      [],
      options({ ignore: ["SHARED_KEY"], optional: ["SHARED_KEY"] }),
    );
    expect(statusOf(report, "SHARED_KEY")).toBe("ignored");
  });

  it("lets `required` win over `optional` for the same key", () => {
    const report = compare(
      scanOf(["SHARED_KEY"]),
      makeDeclared(),
      [],
      options({ optional: ["SHARED_KEY"], required: ["SHARED_KEY"] }),
    );
    expect(statusOf(report, "SHARED_KEY")).toBe("missing");
  });

  it("treats a key declared optional in .env.example but dereferenced in code as required", () => {
    const report = compare(
      scanOf(["STRIPE_SECRET_KEY"]),
      makeDeclared({ STRIPE_SECRET_KEY: { optional: true } }),
      [],
      options(),
    );
    expect(statusOf(report, "STRIPE_SECRET_KEY")).toBe("missing");
  });

  it("treats a key declared optional in .env.example and only optionally referenced as optional", () => {
    const scan = makeScanResult({
      references: [makeReference({ key: "STRIPE_SECRET_KEY", optional: true })],
    });
    const report = compare(
      scan,
      makeDeclared({ STRIPE_SECRET_KEY: { optional: true } }),
      [],
      options(),
    );
    expect(statusOf(report, "STRIPE_SECRET_KEY")).toBe("missing_optional");
  });
});

/* -------------------------------------------------------------------- sites */

describe("sites", () => {
  it("carries every reference site for a key", () => {
    const scan = makeScanResult({
      references: [
        makeReference({ key: "API_URL", file: "src/a.ts", line: 4 }),
        makeReference({ key: "API_URL", file: "src/a.ts", line: 9 }),
      ],
    });
    const report = compare(scan, makeDeclared(), [], options());
    expect(findingFor(report, "API_URL").sites).toEqual([
      { file: "src/a.ts", line: 4 },
      { file: "src/a.ts", line: 9 },
    ]);
  });

  it("sorts sites by file and then line", () => {
    const scan = makeScanResult({
      references: [
        makeReference({ key: "API_URL", file: "src/z.ts", line: 2 }),
        makeReference({ key: "API_URL", file: "src/a.ts", line: 8 }),
        makeReference({ key: "API_URL", file: "src/a.ts", line: 3 }),
      ],
    });
    const report = compare(scan, makeDeclared(), [], options());
    expect(findingFor(report, "API_URL").sites).toEqual([
      { file: "src/a.ts", line: 3 },
      { file: "src/a.ts", line: 8 },
      { file: "src/z.ts", line: 2 },
    ]);
  });

  it("exposes only file and line on a site, never the column or the key", () => {
    const report = compare(scanOf(["API_URL"]), makeDeclared(), [], options());
    const site = findingFor(report, "API_URL").sites[0];
    expect(Object.keys(site ?? {}).sort()).toEqual(["file", "line"]);
  });
});

/* ------------------------------------------------------------------- counts */

describe("counts", () => {
  const scan = makeScanResult({
    references: [
      makeReference({ key: "MISSING_ONE", file: "src/a.ts", line: 1 }),
      makeReference({ key: "ELSEWHERE_ONE", file: "src/b.ts", line: 2 }),
      makeReference({ key: "PRESENT_ONE", file: "src/c.ts", line: 3 }),
      makeReference({ key: "OPTIONAL_ONE", file: "src/d.ts", line: 4, optional: true }),
    ],
    dynamicAccess: [
      { file: "src/dyn.ts", line: 7, kind: "process.env" },
      { file: "src/dyn.ts", line: 9, kind: "process.env" },
    ],
  });
  const declared = makeDeclared({ UNUSED_ONE: {} });
  const env = [
    makeEnvVar({ key: "ELSEWHERE_ONE", targets: ["production"] }),
    makeEnvVar({ key: "PRESENT_ONE", targets: ["preview"] }),
  ];

  it("counts one of each status", () => {
    const report = compare(scan, declared, env, options());
    expect(report.counts).toEqual({
      missing: 1,
      missing_optional: 1,
      present: 1,
      elsewhere: 1,
      unused: 1,
      dynamic: 2,
    });
  });

  it("counts dynamic accesses in counts.dynamic", () => {
    const report = compare(scan, declared, env, options());
    expect(report.counts.dynamic).toBe(2);
  });

  it("mirrors the dynamic access count on the report's dynamicAccess field", () => {
    const report = compare(scan, declared, env, options());
    expect(report.dynamicAccess).toBe(2);
  });

  it("keeps every counter at zero for an empty scan", () => {
    const report = compare(makeScanResult(), makeDeclared(), [], options());
    expect(report.counts).toEqual({
      missing: 0,
      missing_optional: 0,
      present: 0,
      elsewhere: 0,
      unused: 0,
      dynamic: 0,
    });
  });

  it("produces no findings for an empty scan and no declarations", () => {
    const report = compare(makeScanResult(), makeDeclared(), [], options());
    expect(report.findings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ sorting */

describe("sorting", () => {
  const scrambledScan = makeScanResult({
    references: [
      makeReference({ key: "Z_PRESENT", file: "src/z.ts", line: 1 }),
      makeReference({ key: "B_MISSING", file: "src/b.ts", line: 1 }),
      makeReference({ key: "Y_ELSEWHERE", file: "src/y.ts", line: 1 }),
      makeReference({ key: "A_MISSING", file: "src/a.ts", line: 1 }),
      makeReference({ key: "C_OPTIONAL", file: "src/c.ts", line: 1, optional: true }),
      makeReference({ key: "D_IGNORED", file: "src/d.ts", line: 1 }),
      makeReference({ key: "A_PRESENT", file: "src/ap.ts", line: 1 }),
    ],
  });
  const scrambledDeclared = makeDeclared({ M_UNUSED: {}, A_UNUSED: {} });
  const scrambledEnv = [
    makeEnvVar({ key: "Z_PRESENT", targets: ["preview"] }),
    makeEnvVar({ key: "A_PRESENT", targets: ["preview"] }),
    makeEnvVar({ key: "Y_ELSEWHERE", targets: ["production"] }),
  ];

  it("groups findings missing → missing_optional → elsewhere → unused → present → ignored", () => {
    const report = compare(
      scrambledScan,
      scrambledDeclared,
      scrambledEnv,
      options({ ignore: ["D_IGNORED"] }),
    );
    expect(report.findings.map((f) => f.status)).toEqual([
      "missing",
      "missing",
      "missing_optional",
      "elsewhere",
      "unused",
      "unused",
      "present",
      "present",
      "ignored",
    ]);
  });

  it("sorts keys ascending inside each status group", () => {
    const report = compare(
      scrambledScan,
      scrambledDeclared,
      scrambledEnv,
      options({ ignore: ["D_IGNORED"] }),
    );
    expect(keysInOrder(report)).toEqual([
      "A_MISSING",
      "B_MISSING",
      "C_OPTIONAL",
      "Y_ELSEWHERE",
      "A_UNUSED",
      "M_UNUSED",
      "A_PRESENT",
      "Z_PRESENT",
      "D_IGNORED",
    ]);
  });

  it("orders findings the same way regardless of the order the env vars arrive in", () => {
    const forwards = compare(scrambledScan, scrambledDeclared, scrambledEnv, options());
    const backwards = compare(
      scrambledScan,
      scrambledDeclared,
      [...scrambledEnv].reverse(),
      options(),
    );
    expect(keysInOrder(forwards)).toEqual(keysInOrder(backwards));
  });

  it("exposes the documented group order as FINDING_ORDER", () => {
    expect(FINDING_ORDER).toEqual([
      "missing",
      "missing_optional",
      "elsewhere",
      "unused",
      "present",
      "ignored",
    ]);
  });
});

/* -------------------------------------------------------- status derivation */

describe("status derivation", () => {
  const missingScan = scanOf(["MISSING_KEY"]);
  const elsewhereEnv = [makeEnvVar({ key: "ELSEWHERE_KEY", targets: ["production"] })];
  const elsewhereScan = scanOf(["ELSEWHERE_KEY"]);

  it("fails on a missing key under the default fail_on", () => {
    expect(compare(missingScan, makeDeclared(), [], options()).status).toBe("fail");
  });

  it("fails on an elsewhere key under the default fail_on", () => {
    expect(compare(elsewhereScan, makeDeclared(), elsewhereEnv, options()).status).toBe("fail");
  });

  it("fails on a missing key under fail_on: missing", () => {
    expect(
      compare(missingScan, makeDeclared(), [], options({ failOn: "missing" })).status,
    ).toBe("fail");
  });

  it("passes on an elsewhere key under fail_on: missing", () => {
    expect(
      compare(elsewhereScan, makeDeclared(), elsewhereEnv, options({ failOn: "missing" })).status,
    ).toBe("pass");
  });

  it("passes on a missing key under fail_on: never", () => {
    expect(compare(missingScan, makeDeclared(), [], options({ failOn: "never" })).status).toBe(
      "pass",
    );
  });

  it("passes on an elsewhere key under fail_on: never", () => {
    expect(
      compare(elsewhereScan, makeDeclared(), elsewhereEnv, options({ failOn: "never" })).status,
    ).toBe("pass");
  });

  it("passes when the only findings are missing_optional and unused", () => {
    const scan = makeScanResult({
      references: [makeReference({ key: "OPT_KEY", optional: true })],
    });
    expect(compare(scan, makeDeclared({ UNUSED_KEY: {} }), [], options()).status).toBe("pass");
  });

  it("never returns \"error\" — only the runner sets that", () => {
    const report = compare(missingScan, makeDeclared(), [], options());
    expect(report.status).not.toBe("error");
  });

  describe("failingStatuses", () => {
    it("fails missing and elsewhere by default", () => {
      expect(failingStatuses("elsewhere").sort()).toEqual(["elsewhere", "missing"]);
    });

    it("fails only missing under fail_on: missing", () => {
      expect(failingStatuses("missing")).toEqual(["missing"]);
    });

    it("fails nothing under fail_on: never", () => {
      expect(failingStatuses("never")).toEqual([]);
    });
  });
});

/* ------------------------------------------------------------- report shape */

describe("report shape", () => {
  it("echoes the requested target", () => {
    const report = compare(makeScanResult(), makeDeclared(), [], options({ target: "production" }));
    expect(report.target).toBe("production");
  });

  it("echoes the branch when one was given", () => {
    const report = compare(makeScanResult(), makeDeclared(), [], options({ branch: "feature/x" }));
    expect(report.branch).toBe("feature/x");
  });

  it("reports a null branch when none was given", () => {
    const report = compare(makeScanResult(), makeDeclared(), [], options());
    expect(report.branch).toBeNull();
  });

  it("stamps the tool version on the report", () => {
    const report = compare(makeScanResult(), makeDeclared(), [], options());
    expect(report.version).toBe(VERSION);
  });

  it("carries no timestamp anywhere in the serialized report (I3)", () => {
    const report = compare(scanOf(["API_URL"]), makeDeclared(), [], options());
    expect(Object.keys(report).sort()).toEqual([
      "branch",
      "counts",
      "dynamicAccess",
      "findings",
      "status",
      "target",
      "version",
    ]);
  });
});

/* ----------------------------------------------------- I3 — deterministic */

describe("I3 — deterministic", () => {
  const KEYS = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO"] as const;

  const envPool: EnvVar[] = [
    makeEnvVar({ key: "ALPHA", targets: ["preview"] }),
    makeEnvVar({ key: "BRAVO", targets: ["production"] }),
    makeEnvVar({ key: "CHARLIE", targets: ["preview", "development"] }),
    makeEnvVar({ key: "DELTA", targets: ["preview"], gitBranch: "feature/x" }),
    makeEnvVar({ key: "ECHO", targets: [] }),
  ];

  const referencePool = KEYS.map((key, index) =>
    makeReference({ key, file: `src/${key.toLowerCase()}.ts`, line: index + 1 }),
  );

  it("produces a byte-identical report when run twice on the same input", () => {
    const scan = makeScanResult({ references: [...referencePool] });
    const first = JSON.stringify(
      compare(scan, makeDeclared({ FOXTROT: {} }), envPool, options({ branch: "feature/x" })),
    );
    const second = JSON.stringify(
      compare(scan, makeDeclared({ FOXTROT: {} }), envPool, options({ branch: "feature/x" })),
    );
    expect(first).toBe(second);
  });

  it("produces the same report whatever order the env vars arrive in", () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(envPool, { minLength: envPool.length, maxLength: envPool.length }),
        (shuffled) => {
          const scan = makeScanResult({ references: [...referencePool] });
          const baseline = JSON.stringify(
            compare(scan, makeDeclared(), envPool, options({ branch: "feature/x" })),
          );
          const shuffledReport = JSON.stringify(
            compare(scan, makeDeclared(), shuffled, options({ branch: "feature/x" })),
          );
          return baseline === shuffledReport;
        },
      ),
      { numRuns: 25 },
    );
  });

  it("produces the same report whatever order the references arrive in", () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(referencePool, {
          minLength: referencePool.length,
          maxLength: referencePool.length,
        }),
        (shuffled) => {
          const baseline = JSON.stringify(
            compare(
              makeScanResult({ references: [...referencePool] }),
              makeDeclared(),
              envPool,
              options(),
            ),
          );
          const shuffledReport = JSON.stringify(
            compare(
              makeScanResult({ references: [...shuffled] }),
              makeDeclared(),
              envPool,
              options(),
            ),
          );
          return baseline === shuffledReport;
        },
      ),
      { numRuns: 25 },
    );
  });

  it("produces the same report whatever order the ignore patterns arrive in", () => {
    const scan = makeScanResult({ references: [...referencePool] });
    const forwards = JSON.stringify(
      compare(scan, makeDeclared(), envPool, options({ ignore: ["ALPHA", "BRAVO"] })),
    );
    const backwards = JSON.stringify(
      compare(scan, makeDeclared(), envPool, options({ ignore: ["BRAVO", "ALPHA"] })),
    );
    expect(forwards).toBe(backwards);
  });

  it("does not mutate the scan, declarations or env vars it is given", () => {
    const scan = makeScanResult({ references: [...referencePool] });
    const declared = makeDeclared({ FOXTROT: {} });
    const env = [...envPool];
    const snapshot = JSON.stringify({
      references: scan.references,
      declared: [...declared.entries()],
      env,
    });
    compare(scan, declared, env, options());
    expect(
      JSON.stringify({ references: scan.references, declared: [...declared.entries()], env }),
    ).toBe(snapshot);
  });
});

/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `renderAnnotations`
 * ("one per missing/elsewhere/missing_optional key at its FIRST site;
 * message ≤ 200 chars"). Also invariants I1 and I3.
 *
 * Choices this file bakes into the contract, where the SPEC was silent:
 *  - Level mapping: `missing` → "error", `elsewhere` → "warning",
 *    `missing_optional` → "warning". "notice" is reserved and unused in v1.
 *  - Levels are STATIC: they never vary with `report.status` or `fail_on`, so
 *    the same finding always annotates the same way.
 *  - A finding with no sites (a user-`required` key absent from code) is
 *    SKIPPED — a GitHub annotation needs an honest file and line.
 *  - Over-long messages are truncated to 200 chars ending in `…`.
 *  - `title` is `EnvContract: <KEY>`.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { MAX_ANNOTATION_MESSAGE, renderAnnotations } from "../../src/report/annotations.js";
import type { Finding } from "../../src/compare.js";
import { makeFinding, makeReport } from "../helpers/fixtures.js";

const missing = makeFinding({
  key: "STRIPE_SECRET_KEY",
  status: "missing",
  sites: [{ file: "src/lib/stripe.ts", line: 3 }],
  foundIn: [],
});

const elsewhere = makeFinding({
  key: "SUPABASE_URL",
  status: "elsewhere",
  detail: "in Production only",
  sites: [{ file: "src/db.ts", line: 1 }],
  foundIn: ["production"],
});

const missingOptional = makeFinding({
  key: "ANALYTICS_ID",
  status: "missing_optional",
  sites: [{ file: "src/analytics.ts", line: 9 }],
  foundIn: [],
});

describe("Which findings are annotated", () => {
  it("annotates a missing key", () => {
    const annotations = renderAnnotations(makeReport({ findings: [missing], status: "fail" }));
    expect(annotations).toHaveLength(1);
  });

  it("annotates an elsewhere key", () => {
    const annotations = renderAnnotations(makeReport({ findings: [elsewhere], status: "fail" }));
    expect(annotations).toHaveLength(1);
  });

  it("annotates an optional missing key", () => {
    const annotations = renderAnnotations(
      makeReport({ findings: [missingOptional], status: "pass" }),
    );
    expect(annotations).toHaveLength(1);
  });

  it("never annotates a present key", () => {
    const present = makeFinding({ key: "DATABASE_URL", status: "present", foundIn: ["preview"] });
    expect(renderAnnotations(makeReport({ findings: [present], status: "pass" }))).toEqual([]);
  });

  it("never annotates an unused declaration", () => {
    const unused = makeFinding({
      key: "LEGACY_TOKEN",
      status: "unused",
      sites: [{ file: ".env.example", line: 4 }],
    });
    expect(renderAnnotations(makeReport({ findings: [unused], status: "pass" }))).toEqual([]);
  });

  it("never annotates an ignored key", () => {
    const ignored = makeFinding({ key: "IGNORED_KEY", status: "ignored", sites: [] });
    expect(renderAnnotations(makeReport({ findings: [ignored], status: "pass" }))).toEqual([]);
  });

  it("skips a required key that has no site in code", () => {
    const forced = makeFinding({ key: "FORCED_KEY", status: "missing", sites: [] });
    expect(renderAnnotations(makeReport({ findings: [forced], status: "fail" }))).toEqual([]);
  });

  it("emits exactly one annotation per annotatable finding", () => {
    const report = makeReport({
      findings: [missing, missingOptional, elsewhere],
      status: "fail",
    });
    expect(renderAnnotations(report)).toHaveLength(3);
  });

  it("returns an empty array for a report with no findings", () => {
    expect(renderAnnotations(makeReport({ findings: [] }))).toEqual([]);
  });
});

describe("Annotation location — the FIRST site", () => {
  it("points at the first site's file", () => {
    const annotations = renderAnnotations(makeReport({ findings: [missing], status: "fail" }));
    expect(annotations[0]?.file).toBe("src/lib/stripe.ts");
  });

  it("points at the first site's line", () => {
    const annotations = renderAnnotations(makeReport({ findings: [missing], status: "fail" }));
    expect(annotations[0]?.line).toBe(3);
  });

  it("ignores every site after the first", () => {
    const multi = makeFinding({
      key: "MULTI_KEY",
      status: "missing",
      sites: [
        { file: "src/first.ts", line: 10 },
        { file: "src/second.ts", line: 20 },
        { file: "src/third.ts", line: 30 },
      ],
    });
    const annotations = renderAnnotations(makeReport({ findings: [multi], status: "fail" }));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.file).toBe("src/first.ts");
    expect(annotations[0]?.line).toBe(10);
  });

  it("never emits line 0 — GitHub annotations are 1-based", () => {
    const report = makeReport({ findings: [missing, elsewhere, missingOptional], status: "fail" });
    for (const annotation of renderAnnotations(report)) {
      expect(annotation.line).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("Annotation levels", () => {
  it("raises an error for a missing key", () => {
    const annotations = renderAnnotations(makeReport({ findings: [missing], status: "fail" }));
    expect(annotations[0]?.level).toBe("error");
  });

  it("raises a warning for a key that exists elsewhere", () => {
    const annotations = renderAnnotations(makeReport({ findings: [elsewhere], status: "fail" }));
    expect(annotations[0]?.level).toBe("warning");
  });

  it("raises a warning for an optional missing key", () => {
    const annotations = renderAnnotations(
      makeReport({ findings: [missingOptional], status: "pass" }),
    );
    expect(annotations[0]?.level).toBe("warning");
  });

  it("keeps the level static when the overall report passes", () => {
    const failing = renderAnnotations(makeReport({ findings: [missing], status: "fail" }));
    const passing = renderAnnotations(makeReport({ findings: [missing], status: "pass" }));
    expect(passing[0]?.level).toBe(failing[0]?.level);
  });

  it("emits only levels GitHub understands", () => {
    const report = makeReport({ findings: [missing, elsewhere, missingOptional], status: "fail" });
    for (const annotation of renderAnnotations(report)) {
      expect(["error", "warning", "notice"]).toContain(annotation.level);
    }
  });
});

describe("Annotation title and message", () => {
  it("names the key in the title", () => {
    const annotations = renderAnnotations(makeReport({ findings: [missing], status: "fail" }));
    expect(annotations[0]?.title).toContain("STRIPE_SECRET_KEY");
  });

  it("brands the title so the annotation is traceable to this action", () => {
    const annotations = renderAnnotations(makeReport({ findings: [missing], status: "fail" }));
    expect(annotations[0]?.title).toContain("EnvContract");
  });

  it("names the key in the message", () => {
    const annotations = renderAnnotations(makeReport({ findings: [missing], status: "fail" }));
    expect(annotations[0]?.message).toContain("STRIPE_SECRET_KEY");
  });

  it("names the target environment in the message", () => {
    const annotations = renderAnnotations(
      makeReport({ findings: [missing], target: "preview", status: "fail" }),
    );
    expect(annotations[0]?.message).toContain("Preview");
  });

  it("repeats the elsewhere detail in the message", () => {
    const annotations = renderAnnotations(makeReport({ findings: [elsewhere], status: "fail" }));
    expect(annotations[0]?.message).toContain("in Production only");
  });

  it("keeps every message within the 200-character cap", () => {
    const report = makeReport({ findings: [missing, elsewhere, missingOptional], status: "fail" });
    for (const annotation of renderAnnotations(report)) {
      expect(annotation.message.length).toBeLessThanOrEqual(MAX_ANNOTATION_MESSAGE);
    }
  });

  it("truncates an over-long detail with an ellipsis", () => {
    const verbose = makeFinding({
      key: "VERBOSE_KEY",
      status: "elsewhere",
      detail: `in Preview for branch \`${"x".repeat(500)}\` only`,
      sites: [{ file: "src/a.ts", line: 1 }],
    });
    const annotations = renderAnnotations(makeReport({ findings: [verbose], status: "fail" }));
    expect(annotations[0]?.message.length).toBeLessThanOrEqual(MAX_ANNOTATION_MESSAGE);
    expect(annotations[0]?.message.endsWith("…")).toBe(true);
  });

  it("survives a pathologically long key without exceeding the cap", () => {
    const longKey = makeFinding({
      key: `LONG_${"K".repeat(400)}`,
      status: "missing",
      sites: [{ file: "src/a.ts", line: 1 }],
    });
    const annotations = renderAnnotations(makeReport({ findings: [longKey], status: "fail" }));
    expect(annotations[0]?.message.length).toBeLessThanOrEqual(MAX_ANNOTATION_MESSAGE);
  });

  it("writes single-line messages so the workflow command cannot break", () => {
    const report = makeReport({ findings: [missing, elsewhere, missingOptional], status: "fail" });
    for (const annotation of renderAnnotations(report)) {
      expect(annotation.message).not.toContain("\n");
    }
  });
});

describe("I3 — deterministic ordering", () => {
  it("annotates in the order the report lists its findings", () => {
    const report = makeReport({
      findings: [missingOptional, missing, elsewhere],
      status: "fail",
    });
    expect(renderAnnotations(report).map((a) => a.title)).toEqual([
      "EnvContract: ANALYTICS_ID",
      "EnvContract: STRIPE_SECRET_KEY",
      "EnvContract: SUPABASE_URL",
    ]);
  });

  it("produces deep-equal output across two calls", () => {
    const report = makeReport({ findings: [missing, elsewhere], status: "fail" });
    expect(renderAnnotations(report)).toEqual(renderAnnotations(report));
  });
});

describe("I1 — never emits a value", () => {
  it("drops a bogus `value` field planted on a finding", () => {
    const bogus = {
      ...makeFinding({ key: "LEAKY_KEY", status: "missing", sites: [{ file: "a.ts", line: 1 }] }),
      value: "SEKRIT-sk_live_abcdef",
    } as unknown as Finding;
    const annotations = renderAnnotations(makeReport({ findings: [bogus], status: "fail" }));
    expect(JSON.stringify(annotations)).not.toContain("SEKRIT-");
  });

  it("renders from an allow-list, for any planted value (property)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 8 }), (planted) => {
        const bogus = {
          ...makeFinding({
            key: "PROP_KEY",
            status: "missing",
            sites: [{ file: "a.ts", line: 1 }],
          }),
          value: `SEKRIT-${planted}`,
        } as unknown as Finding;
        const annotations = renderAnnotations(makeReport({ findings: [bogus], status: "fail" }));
        expect(JSON.stringify(annotations)).not.toContain("SEKRIT-");
      }),
      { numRuns: 25 },
    );
  });

  it("carries only the five annotation fields", () => {
    const annotations = renderAnnotations(makeReport({ findings: [missing], status: "fail" }));
    expect(Object.keys(annotations[0] ?? {}).sort()).toEqual([
      "file",
      "level",
      "line",
      "message",
      "title",
    ]);
  });
});

/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `renderText`
 * ("the exact CLI block from the pitch"). Also invariants I1 and I3.
 *
 * Choices this file bakes into the contract, where the SPEC was silent:
 *  - `renderText` returns the block WITHOUT a trailing newline; the CLI adds it.
 *  - The `✅ N other required variables covered` line is OMITTED when nothing is
 *    present, and uses the singular "variable" when exactly one is.
 *  - Line shapes: two spaces before the parenthesized location, and the
 *    location suffix is dropped entirely for a finding with no site.
 *      missing           `🔴 KEY referenced but missing from <Target>  (f:l)`
 *      missing_optional  `🟡 KEY optional, missing from <Target>  (f:l)`
 *      elsewhere         `🟡 KEY exists <detail>  (f:l)`
 *      unused            `ℹ️ KEY declared but never referenced  (f:l)`
 *  - `present` and `ignored` findings are never named; the last line is always
 *    `Environment readiness: PASS|FAIL|ERROR`.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { renderText } from "../../src/report/text.js";
import type { Finding } from "../../src/compare.js";
import { makeCounts, makeFinding, makeReport } from "../helpers/fixtures.js";

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

/** The fixture that must reproduce the SPEC block byte for byte. */
const pitchReport = makeReport({
  target: "preview",
  status: "fail",
  findings: [missing, elsewhere],
  counts: makeCounts({ missing: 1, elsewhere: 1, present: 17 }),
});

describe("The CLI block from the pitch", () => {
  it("reproduces the SPEC block byte for byte", () => {
    const expected =
      "🔴 STRIPE_SECRET_KEY referenced but missing from Preview  (src/lib/stripe.ts:3)\n" +
      "🟡 SUPABASE_URL exists in Production only  (src/db.ts:1)\n" +
      "✅ 17 other required variables covered\n" +
      "Environment readiness: FAIL";
    expect(renderText(pitchReport)).toBe(expected);
  });

  it("returns no trailing newline — the caller adds it", () => {
    expect(renderText(pitchReport).endsWith("\n")).toBe(false);
  });

  it("puts two spaces before the parenthesized location", () => {
    expect(renderText(pitchReport)).toContain("from Preview  (src/lib/stripe.ts:3)");
  });

  it("renders exactly four lines for the pitch fixture", () => {
    expect(renderText(pitchReport).split("\n")).toHaveLength(4);
  });
});

describe("Per-status lines", () => {
  it("marks a missing key with 🔴 and names the target", () => {
    const report = makeReport({ target: "production", status: "fail", findings: [missing] });
    expect(renderText(report)).toContain(
      "🔴 STRIPE_SECRET_KEY referenced but missing from Production  (src/lib/stripe.ts:3)",
    );
  });

  it("marks a key that exists elsewhere with 🟡 and repeats the detail", () => {
    const report = makeReport({ target: "preview", status: "fail", findings: [elsewhere] });
    expect(renderText(report)).toContain(
      "🟡 SUPABASE_URL exists in Production only  (src/db.ts:1)",
    );
  });

  it("marks an optional missing key with 🟡", () => {
    const optional = makeFinding({
      key: "ANALYTICS_ID",
      status: "missing_optional",
      sites: [{ file: "src/analytics.ts", line: 9 }],
    });
    const report = makeReport({ target: "preview", status: "pass", findings: [optional] });
    expect(renderText(report)).toContain(
      "🟡 ANALYTICS_ID optional, missing from Preview  (src/analytics.ts:9)",
    );
  });

  it("marks an unused declaration with ℹ️", () => {
    const unused = makeFinding({
      key: "LEGACY_TOKEN",
      status: "unused",
      sites: [{ file: ".env.example", line: 4 }],
    });
    const report = makeReport({ target: "preview", status: "pass", findings: [unused] });
    expect(renderText(report)).toContain(
      "ℹ️ LEGACY_TOKEN declared but never referenced  (.env.example:4)",
    );
  });

  it("drops the location suffix when a finding has no site", () => {
    const forced = makeFinding({ key: "FORCED_KEY", status: "missing", sites: [] });
    const report = makeReport({ target: "preview", status: "fail", findings: [forced] });
    expect(renderText(report)).toContain("🔴 FORCED_KEY referenced but missing from Preview\n");
  });

  it("cites only the first site when a key is referenced in several files", () => {
    const multi = makeFinding({
      key: "MULTI_KEY",
      status: "missing",
      sites: [
        { file: "src/first.ts", line: 10 },
        { file: "src/second.ts", line: 20 },
      ],
    });
    const report = makeReport({ target: "preview", status: "fail", findings: [multi] });
    const text = renderText(report);
    expect(text).toContain("(src/first.ts:10)");
    expect(text).not.toContain("src/second.ts");
  });

  it("never names a present key", () => {
    const present = makeFinding({ key: "DATABASE_URL", status: "present", foundIn: ["preview"] });
    const report = makeReport({
      status: "pass",
      findings: [present],
      counts: makeCounts({ present: 1 }),
    });
    expect(renderText(report)).not.toContain("DATABASE_URL");
  });

  it("never names an ignored key", () => {
    const ignored = makeFinding({ key: "IGNORED_KEY", status: "ignored", sites: [] });
    const report = makeReport({ status: "pass", findings: [ignored] });
    expect(renderText(report)).not.toContain("IGNORED_KEY");
  });

  it("keeps findings in the order the report gives them", () => {
    const report = makeReport({
      status: "fail",
      findings: [elsewhere, missing],
      counts: makeCounts({ missing: 1, elsewhere: 1 }),
    });
    const text = renderText(report);
    expect(text.indexOf("SUPABASE_URL")).toBeLessThan(text.indexOf("STRIPE_SECRET_KEY"));
  });
});

describe("The covered-count line", () => {
  it("counts the present keys in the plural form", () => {
    const report = makeReport({ status: "pass", counts: makeCounts({ present: 17 }) });
    expect(renderText(report)).toContain("✅ 17 other required variables covered");
  });

  it("uses the singular form for exactly one present key", () => {
    const report = makeReport({ status: "pass", counts: makeCounts({ present: 1 }) });
    expect(renderText(report)).toContain("✅ 1 other required variable covered");
  });

  it("omits the line entirely when nothing is present", () => {
    const report = makeReport({
      status: "fail",
      findings: [missing],
      counts: makeCounts({ missing: 1, present: 0 }),
    });
    expect(renderText(report)).not.toContain("✅");
  });
});

describe("The readiness line", () => {
  it("says FAIL on a failing report", () => {
    expect(renderText(pitchReport).split("\n").at(-1)).toBe("Environment readiness: FAIL");
  });

  it("says PASS on a passing report", () => {
    const report = makeReport({ status: "pass", counts: makeCounts({ present: 3 }) });
    expect(renderText(report).split("\n").at(-1)).toBe("Environment readiness: PASS");
  });

  it("says ERROR when the runner could not reach Vercel", () => {
    const report = makeReport({ status: "error" });
    expect(renderText(report).split("\n").at(-1)).toBe("Environment readiness: ERROR");
  });

  it("always ends with the readiness line, even with no findings", () => {
    const report = makeReport({ findings: [], counts: makeCounts() });
    expect(renderText(report).split("\n").at(-1)).toBe("Environment readiness: PASS");
  });
});

describe("I3 — deterministic, plain output", () => {
  it("renders byte-identical output across two calls", () => {
    expect(renderText(pitchReport)).toBe(renderText(pitchReport));
  });

  it("emits no ANSI escape codes", () => {
    expect(renderText(pitchReport)).not.toMatch(/\u001b\[/);
  });

  it("uses LF line endings only", () => {
    expect(renderText(pitchReport)).not.toContain("\r");
  });

  it("contains no timestamp-shaped digits", () => {
    expect(renderText(pitchReport)).not.toMatch(/\b1[0-9]{9,12}\b/);
  });
});

describe("I1 — never emits a value", () => {
  it("drops a bogus `value` field planted on a finding", () => {
    const bogus = {
      ...makeFinding({ key: "LEAKY_KEY", status: "missing", sites: [{ file: "a.ts", line: 1 }] }),
      value: "SEKRIT-sk_live_abcdef",
    } as unknown as Finding;
    const report = makeReport({ status: "fail", findings: [bogus] });
    expect(renderText(report)).not.toContain("SEKRIT-");
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
        expect(renderText(makeReport({ status: "fail", findings: [bogus] }))).not.toContain(
          "SEKRIT-",
        );
      }),
      { numRuns: 25 },
    );
  });
});

/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `toJSON`
 * ("stable, sorted; `JSON.stringify(toJSON(r)) === JSON.stringify(toJSON(r))`
 * across runs"), invariant I3 (no timestamps in the body) and I1.
 *
 * Choices this file bakes into the contract, where the SPEC was silent:
 *  - Every object in the output has its keys sorted ascending, recursively.
 *  - `detail` is OMITTED when absent rather than emitted as `null`.
 *  - `findings` keep the report's order; `toJSON` never re-sorts them.
 *  - The projection is a strict allow-list at every level: unknown fields on a
 *    Finding or on the Report are dropped, not passed through.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { stringifyReport, toJSON } from "../../src/report/json.js";
import type { Finding, Report } from "../../src/compare.js";
import { makeCounts, makeFinding, makeReport } from "../helpers/fixtures.js";
import { VERSION } from "../../src/version.js";

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

const fullReport = makeReport({
  target: "preview",
  branch: "feature/checkout",
  status: "fail",
  findings: [missing, elsewhere],
  counts: makeCounts({ missing: 1, elsewhere: 1, present: 17, dynamic: 2 }),
  dynamicAccess: 2,
});

function isSorted(keys: readonly string[]): boolean {
  return keys.every((key, i) => i === 0 || (keys[i - 1] ?? "") <= key);
}

function walkValues(
  value: unknown,
  visit: (v: unknown, path: string) => void,
  path = "$",
): void {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((entry, i) => walkValues(entry, visit, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      walkValues(entry, visit, `${path}.${key}`);
    }
  }
}

describe("I3 — stable serialization", () => {
  it("stringifies byte-identically across two calls", () => {
    expect(JSON.stringify(toJSON(fullReport))).toBe(JSON.stringify(toJSON(fullReport)));
  });

  it("stringifies byte-identically for two structurally equal reports", () => {
    const twin = makeReport({
      target: "preview",
      branch: "feature/checkout",
      status: "fail",
      findings: [missing, elsewhere],
      counts: makeCounts({ missing: 1, elsewhere: 1, present: 17, dynamic: 2 }),
      dynamicAccess: 2,
    });
    expect(JSON.stringify(toJSON(twin))).toBe(JSON.stringify(toJSON(fullReport)));
  });

  it("sorts the top-level keys ascending", () => {
    expect(Object.keys(toJSON(fullReport))).toEqual([
      "branch",
      "counts",
      "dynamicAccess",
      "findings",
      "status",
      "target",
      "version",
    ]);
  });

  it("sorts the counts keys ascending", () => {
    expect(Object.keys(toJSON(fullReport).counts)).toEqual([
      "dynamic",
      "elsewhere",
      "missing",
      "missing_optional",
      "present",
      "unused",
    ]);
  });

  it("sorts every finding's keys ascending", () => {
    for (const finding of toJSON(fullReport).findings) {
      expect(isSorted(Object.keys(finding))).toBe(true);
    }
  });

  it("sorts every site's keys ascending", () => {
    for (const finding of toJSON(fullReport).findings) {
      for (const site of finding.sites) {
        expect(Object.keys(site)).toEqual(["file", "line"]);
      }
    }
  });

  it("keeps findings in report order rather than re-sorting them", () => {
    const report = makeReport({
      status: "fail",
      findings: [
        makeFinding({ key: "ZZZ_KEY", status: "missing" }),
        makeFinding({ key: "AAA_KEY", status: "missing" }),
      ],
    });
    expect(toJSON(report).findings.map((f) => f.key)).toEqual(["ZZZ_KEY", "AAA_KEY"]);
  });

  it("makes stringifyReport agree with JSON.stringify(toJSON(r))", () => {
    expect(stringifyReport(fullReport)).toBe(JSON.stringify(toJSON(fullReport)));
  });

  it("survives a JSON round trip unchanged", () => {
    const json = toJSON(fullReport);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe("I3 — no timestamps anywhere in the body", () => {
  it("contains no Date instance", () => {
    walkValues(toJSON(fullReport), (value) => {
      expect(value).not.toBeInstanceOf(Date);
    });
  });

  it("contains no epoch-shaped number", () => {
    walkValues(toJSON(fullReport), (value) => {
      if (typeof value === "number") {
        expect(value).toBeLessThan(1_000_000_000);
      }
    });
  });

  it("contains no timestamp-shaped key", () => {
    walkValues(toJSON(fullReport), (_value, path) => {
      expect(path).not.toMatch(/(created|updated|generated|timestamp|\.at$|_at$)/i);
    });
  });

  it("contains no ISO date string", () => {
    expect(stringifyReport(fullReport)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe("Field projection", () => {
  it("carries the report status through", () => {
    expect(toJSON(fullReport).status).toBe("fail");
  });

  it("carries the target through", () => {
    expect(toJSON(fullReport).target).toBe("preview");
  });

  it("carries the branch through", () => {
    expect(toJSON(fullReport).branch).toBe("feature/checkout");
  });

  it("emits a null branch rather than omitting it", () => {
    const json = toJSON(makeReport({ branch: null }));
    expect("branch" in json).toBe(true);
    expect(json.branch).toBeNull();
  });

  it("carries the tool version through", () => {
    expect(toJSON(fullReport).version).toBe(VERSION);
  });

  it("carries the dynamic access count through", () => {
    expect(toJSON(fullReport).dynamicAccess).toBe(2);
  });

  it("keeps the detail on a finding that has one", () => {
    const json = toJSON(makeReport({ findings: [elsewhere], status: "fail" }));
    expect(json.findings[0]?.detail).toBe("in Production only");
  });

  it("omits the detail key entirely on a finding without one", () => {
    const json = toJSON(makeReport({ findings: [missing], status: "fail" }));
    expect("detail" in (json.findings[0] ?? {})).toBe(false);
  });

  it("emits foundIn as an array of target strings", () => {
    const json = toJSON(makeReport({ findings: [elsewhere], status: "fail" }));
    expect(json.findings[0]?.foundIn).toEqual(["production"]);
  });

  it("emits an empty sites array rather than omitting it", () => {
    const forced = makeFinding({ key: "FORCED_KEY", status: "missing", sites: [] });
    const json = toJSON(makeReport({ findings: [forced], status: "fail" }));
    expect(json.findings[0]?.sites).toEqual([]);
  });

  it("keeps every finding, including present and ignored ones", () => {
    const report = makeReport({
      findings: [
        missing,
        makeFinding({ key: "PRESENT_KEY", status: "present", foundIn: ["preview"] }),
        makeFinding({ key: "IGNORED_KEY", status: "ignored", sites: [] }),
      ],
      status: "fail",
    });
    expect(toJSON(report).findings.map((f) => f.key)).toEqual([
      "STRIPE_SECRET_KEY",
      "PRESENT_KEY",
      "IGNORED_KEY",
    ]);
  });

  it("drops an unknown field planted on a finding", () => {
    const bogus = {
      ...missing,
      surprise: "should not survive",
    } as unknown as Finding;
    const json = toJSON(makeReport({ findings: [bogus], status: "fail" }));
    expect("surprise" in (json.findings[0] ?? {})).toBe(false);
  });

  it("drops an unknown field planted on the report", () => {
    const bogus = { ...fullReport, surprise: "should not survive" } as unknown as Report;
    expect("surprise" in toJSON(bogus)).toBe(false);
  });

  it("drops an unknown field planted on a site", () => {
    const bogus = {
      ...makeFinding({
        key: "SITE_KEY",
        status: "missing",
        sites: [{ file: "a.ts", line: 1, col: 9 } as unknown as { file: string; line: number }],
      }),
    };
    const json = toJSON(makeReport({ findings: [bogus], status: "fail" }));
    expect(Object.keys(json.findings[0]?.sites[0] ?? {})).toEqual(["file", "line"]);
  });
});

describe("I1 — never emits a value", () => {
  it("drops a bogus `value` field planted on a finding", () => {
    const bogus = { ...missing, value: "SEKRIT-sk_live_abcdef" } as unknown as Finding;
    const json = toJSON(makeReport({ findings: [bogus], status: "fail" }));
    expect(JSON.stringify(json)).not.toContain("SEKRIT-");
  });

  it("drops a bogus `value` field planted on the report", () => {
    const bogus = { ...fullReport, value: "SEKRIT-top-level" } as unknown as Report;
    expect(stringifyReport(bogus)).not.toContain("SEKRIT-");
  });

  it("projects from an allow-list, for any planted value (property)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 8 }), (planted) => {
        const bogus = {
          ...makeFinding({ key: "PROP_KEY", status: "missing" }),
          value: `SEKRIT-${planted}`,
          decrypted: `SEKRIT-${planted}`,
          contentHint: `SEKRIT-${planted}`,
        } as unknown as Finding;
        const json = toJSON(makeReport({ findings: [bogus], status: "fail" }));
        expect(JSON.stringify(json)).not.toContain("SEKRIT-");
      }),
      { numRuns: 25 },
    );
  });

  it("never emits a key literally named `value` at any depth", () => {
    walkValues(toJSON(fullReport), (_value, path) => {
      expect(path.endsWith(".value")).toBe(false);
    });
  });
});

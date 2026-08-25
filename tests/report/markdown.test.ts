/**
 * SPEC: docs/SPEC.md — Module D `report` renderers, `renderMarkdown`
 * ("Header line `## EnvContract — <Target> readiness: …`", the
 * `| | Key | Status | Referenced at |` table, the `<details>` collapse for
 * present keys, the free footer, and the `<!-- envcontract:report -->` marker).
 * Also invariant I1 (never contains a value) and I3 (deterministic).
 *
 * Choices this file bakes into the contract, where the SPEC was silent:
 *  - Column 1 of the table (the SPEC's unnamed column) holds the status emoji.
 *  - The table — header row, separator row, data rows — is rendered only when
 *    there is at least one finding that is neither `present` nor `ignored`.
 *  - `ignored` findings never appear in the rendered body (JSON keeps them).
 *  - "Referenced at" shows the FIRST site as `file:line`, plus ` +N more` when
 *    there are further sites, and `—` when a finding has no sites at all.
 *  - Table cells escape `|` as `\|` so a path can never break the table.
 *  - `status: "error"` renders `⚠️ ERROR` in the header.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  FOOTER_TEXT,
  PRESENT_DETAILS_THRESHOLD,
  REPORT_MARKER,
  renderMarkdown,
} from "../../src/report/markdown.js";
import type { Finding } from "../../src/compare.js";
import { makeFinding, makeReport } from "../helpers/fixtures.js";

/** Splits a markdown table row on unescaped pipes. `| a | b |` → ["", " a ", " b ", ""]. */
function pipeCells(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (ch === "\\" && row[i + 1] === "|") {
      current += "\\|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

function lines(markdown: string): string[] {
  return markdown.split("\n");
}

function tableRows(markdown: string): string[] {
  return lines(markdown).filter((line) => line.trimStart().startsWith("|"));
}

function presentFindings(count: number): Finding[] {
  return Array.from({ length: count }, (_, i) =>
    makeFinding({
      key: `PRESENT_${String(i).padStart(2, "0")}`,
      status: "present",
      foundIn: ["preview"],
      sites: [{ file: `src/p${i}.ts`, line: i + 1 }],
    }),
  );
}

const missingFinding = makeFinding({
  key: "STRIPE_SECRET_KEY",
  status: "missing",
  sites: [{ file: "src/lib/stripe.ts", line: 3 }],
  foundIn: [],
});

const elsewhereFinding = makeFinding({
  key: "SUPABASE_URL",
  status: "elsewhere",
  detail: "in Production only",
  sites: [{ file: "src/db.ts", line: 1 }],
  foundIn: ["production"],
});

describe("Marker — sticky comment lookup", () => {
  it("puts the marker on the very first line", () => {
    const markdown = renderMarkdown(makeReport({ findings: [missingFinding], status: "fail" }));
    expect(lines(markdown)[0]).toBe(REPORT_MARKER);
  });

  it("emits the marker exactly once so a second run updates rather than nests", () => {
    const markdown = renderMarkdown(makeReport({ findings: [missingFinding], status: "fail" }));
    expect(markdown.split(REPORT_MARKER)).toHaveLength(2);
  });

  it("still emits the marker when there are no findings at all", () => {
    const markdown = renderMarkdown(makeReport({ findings: [] }));
    expect(lines(markdown)[0]).toBe(REPORT_MARKER);
  });

  it("uses the exact marker string the sticky-comment lookup searches for", () => {
    expect(REPORT_MARKER).toBe("<!-- envcontract:report -->");
  });
});

describe("Header line", () => {
  it("says ✅ PASS for a passing preview report", () => {
    const markdown = renderMarkdown(makeReport({ target: "preview", status: "pass" }));
    expect(markdown).toContain("## EnvContract — Preview readiness: ✅ PASS");
  });

  it("says 🔴 FAIL for a failing preview report", () => {
    const markdown = renderMarkdown(
      makeReport({ target: "preview", status: "fail", findings: [missingFinding] }),
    );
    expect(markdown).toContain("## EnvContract — Preview readiness: 🔴 FAIL");
  });

  it("capitalizes the production target in the header", () => {
    const markdown = renderMarkdown(makeReport({ target: "production", status: "pass" }));
    expect(markdown).toContain("## EnvContract — Production readiness: ✅ PASS");
  });

  it("capitalizes the development target in the header", () => {
    const markdown = renderMarkdown(makeReport({ target: "development", status: "pass" }));
    expect(markdown).toContain("## EnvContract — Development readiness: ✅ PASS");
  });

  it("renders ⚠️ ERROR when the runner could not reach Vercel", () => {
    const markdown = renderMarkdown(makeReport({ target: "preview", status: "error" }));
    expect(markdown).toContain("## EnvContract — Preview readiness: ⚠️ ERROR");
  });

  it("places the header on the line directly after the marker", () => {
    const markdown = renderMarkdown(makeReport({ target: "preview", status: "pass" }));
    expect(lines(markdown)[1]).toBe("## EnvContract — Preview readiness: ✅ PASS");
  });

  it("never mentions the branch name in the header when no branch is set", () => {
    const markdown = renderMarkdown(makeReport({ branch: null, status: "pass" }));
    expect(lines(markdown)[1]).not.toContain("null");
  });

  it("names the branch somewhere in the body when a preview branch was compared", () => {
    const markdown = renderMarkdown(
      makeReport({ target: "preview", branch: "feature/checkout", status: "pass" }),
    );
    expect(markdown).toContain("feature/checkout");
  });
});

describe("Findings table", () => {
  it("emits the SPEC header row verbatim", () => {
    const markdown = renderMarkdown(makeReport({ findings: [missingFinding], status: "fail" }));
    expect(markdown).toContain("| | Key | Status | Referenced at |");
  });

  it("emits a separator row so GitHub renders it as a table", () => {
    const markdown = renderMarkdown(makeReport({ findings: [missingFinding], status: "fail" }));
    const rows = tableRows(markdown);
    expect(rows[1]).toMatch(/^\|\s*[-:| ]+\|$/);
  });

  it("emits one data row per missing finding", () => {
    const findings = [
      makeFinding({ key: "A_KEY", status: "missing", sites: [{ file: "a.ts", line: 1 }] }),
      makeFinding({ key: "B_KEY", status: "missing", sites: [{ file: "b.ts", line: 2 }] }),
      makeFinding({ key: "C_KEY", status: "missing", sites: [{ file: "c.ts", line: 3 }] }),
    ];
    const markdown = renderMarkdown(makeReport({ findings, status: "fail" }));
    expect(tableRows(markdown)).toHaveLength(2 + 3);
  });

  it("wraps the key in backticks", () => {
    const markdown = renderMarkdown(makeReport({ findings: [missingFinding], status: "fail" }));
    expect(markdown).toContain("`STRIPE_SECRET_KEY`");
  });

  it("puts the status emoji in the unnamed first column", () => {
    const markdown = renderMarkdown(makeReport({ findings: [missingFinding], status: "fail" }));
    const dataRow = tableRows(markdown)[2] ?? "";
    expect(pipeCells(dataRow)[1]?.trim()).toBe("🔴");
  });

  it("labels a missing finding `Missing`", () => {
    const markdown = renderMarkdown(makeReport({ findings: [missingFinding], status: "fail" }));
    const dataRow = tableRows(markdown)[2] ?? "";
    expect(pipeCells(dataRow)[3]?.trim()).toBe("Missing");
  });

  it("labels an elsewhere finding with its detail sentence appended", () => {
    const markdown = renderMarkdown(makeReport({ findings: [elsewhereFinding], status: "fail" }));
    const dataRow = tableRows(markdown)[2] ?? "";
    expect(pipeCells(dataRow)[3]?.trim()).toBe("Elsewhere — in Production only");
  });

  it("uses 🟡 for an elsewhere finding", () => {
    const markdown = renderMarkdown(makeReport({ findings: [elsewhereFinding], status: "fail" }));
    const dataRow = tableRows(markdown)[2] ?? "";
    expect(pipeCells(dataRow)[1]?.trim()).toBe("🟡");
  });

  it("labels an optional missing finding `Missing (optional)` with a 🟡", () => {
    const finding = makeFinding({
      key: "ANALYTICS_ID",
      status: "missing_optional",
      sites: [{ file: "src/analytics.ts", line: 9 }],
    });
    const markdown = renderMarkdown(makeReport({ findings: [finding], status: "pass" }));
    const dataRow = tableRows(markdown)[2] ?? "";
    expect(pipeCells(dataRow)[1]?.trim()).toBe("🟡");
    expect(pipeCells(dataRow)[3]?.trim()).toBe("Missing (optional)");
  });

  it("labels an unused declaration `Unused` with an ℹ️", () => {
    const finding = makeFinding({
      key: "LEGACY_TOKEN",
      status: "unused",
      sites: [{ file: ".env.example", line: 4 }],
    });
    const markdown = renderMarkdown(makeReport({ findings: [finding], status: "pass" }));
    const dataRow = tableRows(markdown)[2] ?? "";
    expect(pipeCells(dataRow)[1]?.trim()).toBe("ℹ️");
    expect(pipeCells(dataRow)[3]?.trim()).toBe("Unused");
  });

  it("renders the first site as file:line in the Referenced at column", () => {
    const markdown = renderMarkdown(makeReport({ findings: [missingFinding], status: "fail" }));
    const dataRow = tableRows(markdown)[2] ?? "";
    expect(pipeCells(dataRow)[4]?.trim()).toBe("src/lib/stripe.ts:3");
  });

  it("summarizes further sites as `+N more` rather than listing them all", () => {
    const finding = makeFinding({
      key: "MULTI_KEY",
      status: "missing",
      sites: [
        { file: "src/a.ts", line: 1 },
        { file: "src/b.ts", line: 2 },
        { file: "src/c.ts", line: 3 },
      ],
    });
    const markdown = renderMarkdown(makeReport({ findings: [finding], status: "fail" }));
    const dataRow = tableRows(markdown)[2] ?? "";
    expect(pipeCells(dataRow)[4]?.trim()).toBe("src/a.ts:1 +2 more");
  });

  it("renders an em dash when a required key has no site in code", () => {
    const finding = makeFinding({ key: "FORCED_KEY", status: "missing", sites: [] });
    const markdown = renderMarkdown(makeReport({ findings: [finding], status: "fail" }));
    const dataRow = tableRows(markdown)[2] ?? "";
    expect(pipeCells(dataRow)[4]?.trim()).toBe("—");
  });

  it("keeps present keys out of the findings table", () => {
    const findings = [missingFinding, ...presentFindings(3)];
    const markdown = renderMarkdown(makeReport({ findings, status: "fail" }));
    expect(tableRows(markdown)).toHaveLength(2 + 1);
  });

  it("keeps ignored keys out of the rendered body entirely", () => {
    const findings = [
      missingFinding,
      makeFinding({ key: "IGNORED_BY_USER", status: "ignored", sites: [] }),
    ];
    const markdown = renderMarkdown(makeReport({ findings, status: "fail" }));
    expect(markdown).not.toContain("IGNORED_BY_USER");
  });

  it("omits the table completely when every finding is present", () => {
    const markdown = renderMarkdown(makeReport({ findings: presentFindings(3), status: "pass" }));
    expect(markdown).not.toContain("| | Key | Status | Referenced at |");
  });

  it("omits the table completely when there are no findings", () => {
    const markdown = renderMarkdown(makeReport({ findings: [] }));
    expect(tableRows(markdown)).toHaveLength(0);
  });

  it("escapes a pipe in a file path so the row keeps its four cells", () => {
    const finding = makeFinding({
      key: "PIPE_KEY",
      status: "missing",
      sites: [{ file: "src/we|rd.ts", line: 2 }],
    });
    const markdown = renderMarkdown(makeReport({ findings: [finding], status: "fail" }));
    const dataRow = tableRows(markdown)[2] ?? "";
    expect(pipeCells(dataRow)).toHaveLength(6);
    expect(dataRow).toContain("\\|");
  });

  it("escapes a backtick in a file path so the key formatting cannot leak", () => {
    const finding = makeFinding({
      key: "TICK_KEY",
      status: "missing",
      sites: [{ file: "src/we`rd.ts", line: 2 }],
    });
    const markdown = renderMarkdown(makeReport({ findings: [finding], status: "fail" }));
    const dataRow = tableRows(markdown)[2] ?? "";
    expect(dataRow).toContain("\\`");
  });

  it("keeps findings in the order the report gives them", () => {
    const findings = [
      makeFinding({ key: "ZZZ_FIRST", status: "missing", sites: [{ file: "z.ts", line: 1 }] }),
      makeFinding({ key: "AAA_SECOND", status: "elsewhere", detail: "in Production only" }),
    ];
    const markdown = renderMarkdown(makeReport({ findings, status: "fail" }));
    expect(markdown.indexOf("ZZZ_FIRST")).toBeLessThan(markdown.indexOf("AAA_SECOND"));
  });
});

describe("Present keys — collapsed <details> when > 10", () => {
  it("lists present keys inline at exactly the threshold", () => {
    const markdown = renderMarkdown(
      makeReport({ findings: presentFindings(PRESENT_DETAILS_THRESHOLD), status: "pass" }),
    );
    expect(markdown).not.toContain("<details>");
  });

  it("collapses present keys into <details> one past the threshold", () => {
    const markdown = renderMarkdown(
      makeReport({ findings: presentFindings(PRESENT_DETAILS_THRESHOLD + 1), status: "pass" }),
    );
    expect(markdown).toContain("<details>");
    expect(markdown).toContain("</details>");
  });

  it("names the present count in the <summary>", () => {
    const markdown = renderMarkdown(
      makeReport({ findings: presentFindings(PRESENT_DETAILS_THRESHOLD + 1), status: "pass" }),
    );
    const summary = lines(markdown).find((line) => line.includes("<summary>")) ?? "";
    expect(summary).toContain(String(PRESENT_DETAILS_THRESHOLD + 1));
  });

  it("still lists every present key inside the collapsed block", () => {
    const findings = presentFindings(PRESENT_DETAILS_THRESHOLD + 1);
    const markdown = renderMarkdown(makeReport({ findings, status: "pass" }));
    for (const finding of findings) {
      expect(markdown).toContain(finding.key);
    }
  });

  it("lists every present key when rendered inline", () => {
    const findings = presentFindings(PRESENT_DETAILS_THRESHOLD);
    const markdown = renderMarkdown(makeReport({ findings, status: "pass" }));
    for (const finding of findings) {
      expect(markdown).toContain(finding.key);
    }
  });

  it("omits the present section entirely when nothing is present", () => {
    const markdown = renderMarkdown(makeReport({ findings: [missingFinding], status: "fail" }));
    expect(markdown).not.toContain("<details>");
  });
});

describe("Footer — free vs licensed", () => {
  it("advertises continuous monitoring on a free run", () => {
    const markdown = renderMarkdown(makeReport({ findings: [missingFinding], status: "fail" }));
    expect(markdown).toContain(FOOTER_TEXT);
  });

  it("omits the advert when a license key is configured", () => {
    const markdown = renderMarkdown(makeReport({ findings: [missingFinding], status: "fail" }), {
      licensed: true,
    });
    expect(markdown).not.toContain(FOOTER_TEXT);
  });

  it("puts the footer last on a free run", () => {
    const markdown = renderMarkdown(makeReport({ status: "pass" }));
    const nonEmpty = lines(markdown).filter((line) => line.trim() !== "");
    expect(nonEmpty.at(-1)).toContain(FOOTER_TEXT);
  });

  it("still renders the marker and header when licensed", () => {
    const markdown = renderMarkdown(makeReport({ status: "pass" }), { licensed: true });
    expect(lines(markdown)[0]).toBe(REPORT_MARKER);
    expect(markdown).toContain("readiness: ✅ PASS");
  });
});

describe("I3 — deterministic body", () => {
  it("renders byte-identical output for the same report twice", () => {
    const report = makeReport({ findings: [missingFinding, elsewhereFinding], status: "fail" });
    expect(renderMarkdown(report)).toBe(renderMarkdown(report));
  });

  it("uses LF line endings only", () => {
    const markdown = renderMarkdown(makeReport({ findings: [missingFinding], status: "fail" }));
    expect(markdown).not.toContain("\r");
  });

  it("contains no timestamp-shaped digits", () => {
    const markdown = renderMarkdown(makeReport({ findings: [missingFinding], status: "fail" }));
    expect(markdown).not.toMatch(/\b1[0-9]{9,12}\b/);
  });
});

describe("I1 — never emits a value", () => {
  it("drops a bogus `value` field planted on a finding", () => {
    const bogus = {
      ...makeFinding({ key: "LEAKY_KEY", status: "missing" }),
      value: "SEKRIT-sk_live_abcdef",
    } as unknown as Finding;
    const markdown = renderMarkdown(makeReport({ findings: [bogus], status: "fail" }));
    expect(markdown).not.toContain("SEKRIT-");
  });

  it("drops a bogus top-level field planted on the report", () => {
    const report = {
      ...makeReport({ findings: [missingFinding], status: "fail" }),
      value: "SEKRIT-top-level",
    } as unknown as ReturnType<typeof makeReport>;
    expect(renderMarkdown(report)).not.toContain("SEKRIT-");
  });

  it("renders from an allow-list, for any planted value (property)", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 8 }), (planted) => {
        const bogus = {
          ...makeFinding({ key: "PROP_KEY", status: "missing" }),
          value: `SEKRIT-${planted}`,
          decrypted: `SEKRIT-${planted}`,
        } as unknown as Finding;
        const markdown = renderMarkdown(makeReport({ findings: [bogus], status: "fail" }));
        expect(markdown).not.toContain("SEKRIT-");
      }),
      { numRuns: 25 },
    );
  });
});

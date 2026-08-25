/**
 * SPEC: docs/SPEC.md — Module A `scanner`, "`.env.example` parsing":
 *
 *   `KEY=`, `KEY=value`, `export KEY=`, `KEY="quoted"`, comments `#`, blank
 *   lines, `# KEY=` (commented → optional-declared), CRLF, BOM, `KEY` bare
 *   (no `=`) → key. Result: `declared: Map<key,{optional,file,line}>`.
 *
 * And invariant I1 ("Never see, log, store, or emit a value") — the concrete
 * consequence tested here is that a real `.env` is never even opened.
 *
 * Ambiguities resolved in these tests (the choice is the spec for the engineer):
 *  - A commented declaration must contain `=` to count. `# this sets things up`
 *    is prose, not a declaration of a key named `this`.
 *  - `isEnvExampleFile` matches on the BASENAME and requires a leading `.env`,
 *    so `env.example` (no dot) is false and `.env.local.example` is true.
 *  - Values are parsed only far enough to find the next key; no value is ever
 *    stored in `DeclaredEntry`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isEnvExampleFile,
  parseEnvExample,
  parseEnvExamples,
} from "../../src/scanner/envfile.js";
import { collectFiles } from "../../src/scanner/files.js";

const FILE = ".env.example";

describe(".env.example parsing — basic forms", () => {
  it("declares a key from a bare assignment with no value", () => {
    const result = parseEnvExample("STRIPE_SECRET_KEY=\n", FILE);
    expect([...result.declared.keys()]).toEqual(["STRIPE_SECRET_KEY"]);
  });

  it("declares a key from an assignment that has a value", () => {
    const result = parseEnvExample("DATABASE_URL=postgres://localhost/db\n", FILE);
    expect([...result.declared.keys()]).toEqual(["DATABASE_URL"]);
  });

  it("marks a plain assignment as required rather than optional", () => {
    const result = parseEnvExample("DATABASE_URL=postgres://localhost/db\n", FILE);
    expect(result.declared.get("DATABASE_URL")?.optional).toBe(false);
  });

  it("never stores the value of a declaration", () => {
    const result = parseEnvExample("DATABASE_URL=postgres://user:pw@host/db\n", FILE);
    expect(JSON.stringify([...result.declared])).not.toContain("postgres");
  });

  it("strips a leading `export ` from a valueless declaration", () => {
    const result = parseEnvExample("export STRIPE_SECRET_KEY=\n", FILE);
    expect([...result.declared.keys()]).toEqual(["STRIPE_SECRET_KEY"]);
  });

  it("strips a leading `export ` from a declaration with a value", () => {
    const result = parseEnvExample("export NODE_LOG_LEVEL=info\n", FILE);
    expect([...result.declared.keys()]).toEqual(["NODE_LOG_LEVEL"]);
  });

  it("accepts spaces around the equals sign the way dotenv does", () => {
    const result = parseEnvExample("KEY = value\n", FILE);
    expect([...result.declared.keys()]).toEqual(["KEY"]);
  });

  it("accepts leading indentation before a declaration", () => {
    const result = parseEnvExample("    INDENTED_KEY=1\n", FILE);
    expect([...result.declared.keys()]).toEqual(["INDENTED_KEY"]);
  });

  it("treats a bare key with no equals sign as a declaration", () => {
    const result = parseEnvExample("STRIPE_SECRET_KEY\n", FILE);
    expect([...result.declared.keys()]).toEqual(["STRIPE_SECRET_KEY"]);
  });

  it("does not warn about a bare key with no equals sign", () => {
    const result = parseEnvExample("STRIPE_SECRET_KEY\n", FILE);
    expect(result.warnings).toEqual([]);
  });

  it("ignores blank lines entirely", () => {
    const result = parseEnvExample("\n\n   \n\t\nA=1\n\n", FILE);
    expect([...result.declared.keys()]).toEqual(["A"]);
  });

  it("collects several declarations from one file", () => {
    const result = parseEnvExample("A=1\nB=\nexport C=3\nD\n", FILE);
    expect([...result.declared.keys()].sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("keeps a lowercase key as declared, since Vercel allows lowercase keys", () => {
    const result = parseEnvExample("port=3000\n", FILE);
    expect([...result.declared.keys()]).toEqual(["port"]);
  });

  it("keeps a key containing digits and underscores", () => {
    const result = parseEnvExample("S3_BUCKET_2=my-bucket\n", FILE);
    expect([...result.declared.keys()]).toEqual(["S3_BUCKET_2"]);
  });

  it("keeps a key that begins with an underscore", () => {
    const result = parseEnvExample("_INTERNAL=1\n", FILE);
    expect([...result.declared.keys()]).toEqual(["_INTERNAL"]);
  });

  it("parses a file with no trailing newline", () => {
    const result = parseEnvExample("LAST_KEY=1", FILE);
    expect([...result.declared.keys()]).toEqual(["LAST_KEY"]);
  });

  it("returns an empty map for an empty file", () => {
    const result = parseEnvExample("", FILE);
    expect(result.declared.size).toBe(0);
  });

  it("returns no warnings for an empty file", () => {
    const result = parseEnvExample("", FILE);
    expect(result.warnings).toEqual([]);
  });
});

describe(".env.example parsing — quoting", () => {
  it("declares a key whose value is double quoted", () => {
    const result = parseEnvExample('KEY="quoted value"\n', FILE);
    expect([...result.declared.keys()]).toEqual(["KEY"]);
  });

  it("declares a key whose value is single quoted", () => {
    const result = parseEnvExample("KEY='quoted value'\n", FILE);
    expect([...result.declared.keys()]).toEqual(["KEY"]);
  });

  it("declares a key whose value is backtick quoted", () => {
    const result = parseEnvExample("KEY=`quoted value`\n", FILE);
    expect([...result.declared.keys()]).toEqual(["KEY"]);
  });

  it("declares a key whose quoted value is empty", () => {
    const result = parseEnvExample('KEY=""\n', FILE);
    expect([...result.declared.keys()]).toEqual(["KEY"]);
  });

  it("does not treat a `#` inside a double quoted value as a comment", () => {
    const result = parseEnvExample('KEY="value # not a comment"\nNEXT=1\n', FILE);
    expect([...result.declared.keys()].sort()).toEqual(["KEY", "NEXT"]);
  });

  it("does not treat an `=` inside a quoted value as a second assignment", () => {
    const result = parseEnvExample('KEY="a=b=c"\n', FILE);
    expect([...result.declared.keys()]).toEqual(["KEY"]);
  });

  it("does not leak a quoted value into the declaration entry", () => {
    const result = parseEnvExample('KEY="sk_live_leaky"\n', FILE);
    expect(JSON.stringify([...result.declared])).not.toContain("sk_live_leaky");
  });
});

describe(".env.example parsing — comments and commented-out declarations", () => {
  it("declares a commented-out key written as `#KEY=` as optional", () => {
    const result = parseEnvExample("#SENTRY_DSN=\n", FILE);
    expect(result.declared.get("SENTRY_DSN")?.optional).toBe(true);
  });

  it("declares a commented-out key written as `# KEY=` as optional", () => {
    const result = parseEnvExample("# SENTRY_DSN=\n", FILE);
    expect(result.declared.get("SENTRY_DSN")?.optional).toBe(true);
  });

  it("declares a commented-out key written as `#  KEY = ` as optional", () => {
    const result = parseEnvExample("#  SENTRY_DSN = \n", FILE);
    expect(result.declared.get("SENTRY_DSN")?.optional).toBe(true);
  });

  it("declares a commented-out key that carries an example value as optional", () => {
    const result = parseEnvExample("# SENTRY_DSN=https://example.ingest.sentry.io\n", FILE);
    expect(result.declared.get("SENTRY_DSN")?.optional).toBe(true);
  });

  it("declares a commented-out `export` declaration as optional", () => {
    const result = parseEnvExample("# export SENTRY_DSN=\n", FILE);
    expect(result.declared.get("SENTRY_DSN")?.optional).toBe(true);
  });

  it("treats prose after a `#` as a comment rather than a declaration", () => {
    const result = parseEnvExample("# this sets things up\n", FILE);
    expect(result.declared.size).toBe(0);
  });

  it("does not warn about a prose comment", () => {
    const result = parseEnvExample("# this sets things up\n", FILE);
    expect(result.warnings).toEqual([]);
  });

  it("treats a commented bare word with no equals sign as prose, not a key", () => {
    const result = parseEnvExample("# TODO\n", FILE);
    expect(result.declared.size).toBe(0);
  });

  it("treats a `##` banner line as prose", () => {
    const result = parseEnvExample("## Section: Stripe ##\n", FILE);
    expect(result.declared.size).toBe(0);
  });

  it("keeps a real declaration required when a prose comment precedes it", () => {
    const result = parseEnvExample("# Stripe keys\nSTRIPE_SECRET_KEY=\n", FILE);
    expect(result.declared.get("STRIPE_SECRET_KEY")?.optional).toBe(false);
  });

  it("lets an uncommented declaration later in the file win over a commented one", () => {
    const result = parseEnvExample("# SENTRY_DSN=\nSENTRY_DSN=\n", FILE);
    expect(result.declared.get("SENTRY_DSN")?.optional).toBe(false);
  });

  it("ignores a trailing inline comment after a value", () => {
    const result = parseEnvExample("KEY=value # explanation\nNEXT=1\n", FILE);
    expect([...result.declared.keys()].sort()).toEqual(["KEY", "NEXT"]);
  });

  it("does not create a key from the words of a trailing inline comment", () => {
    const result = parseEnvExample("KEY=value # SOME_OTHER_KEY=1\n", FILE);
    expect([...result.declared.keys()]).toEqual(["KEY"]);
  });
});

describe(".env.example parsing — invalid lines", () => {
  it("does not declare anything for a line that starts with an equals sign", () => {
    const result = parseEnvExample("=value\n", FILE);
    expect(result.declared.size).toBe(0);
  });

  it("records an invalid_env_line warning for a line that starts with an equals sign", () => {
    const result = parseEnvExample("=value\n", FILE);
    expect(result.warnings[0]?.code).toBe("invalid_env_line");
  });

  it("does not throw on a key containing spaces", () => {
    expect(() => parseEnvExample("KEY WITH SPACE=1\n", FILE)).not.toThrow();
  });

  it("does not declare a key containing spaces", () => {
    const result = parseEnvExample("KEY WITH SPACE=1\n", FILE);
    expect(result.declared.size).toBe(0);
  });

  it("warns about a key containing spaces", () => {
    const result = parseEnvExample("KEY WITH SPACE=1\n", FILE);
    expect(result.warnings[0]?.code).toBe("invalid_env_line");
  });

  it("does not declare a key that begins with a digit", () => {
    const result = parseEnvExample("123=x\n", FILE);
    expect(result.declared.size).toBe(0);
  });

  it("warns about a key that begins with a digit", () => {
    const result = parseEnvExample("123=x\n", FILE);
    expect(result.warnings[0]?.code).toBe("invalid_env_line");
  });

  it("does not declare a key containing a hyphen", () => {
    const result = parseEnvExample("MY-KEY=1\n", FILE);
    expect(result.declared.size).toBe(0);
  });

  it("does not declare a key containing a non-ASCII letter", () => {
    const result = parseEnvExample("ÜBER=1\n", FILE);
    expect(result.declared.size).toBe(0);
  });

  it("reports the 1-based line number of an invalid line", () => {
    const result = parseEnvExample("A=1\nB=2\n=oops\n", FILE);
    expect(result.warnings[0]?.line).toBe(3);
  });

  it("attributes an invalid line warning to the file it came from", () => {
    const result = parseEnvExample("=oops\n", "packages/api/.env.example");
    expect(result.warnings[0]?.file).toBe("packages/api/.env.example");
  });

  it("keeps parsing valid declarations after an invalid line", () => {
    const result = parseEnvExample("=oops\nGOOD_KEY=1\n", FILE);
    expect([...result.declared.keys()]).toEqual(["GOOD_KEY"]);
  });

  it("never puts the value of an invalid line into the warning message", () => {
    const result = parseEnvExample("=sk_live_leaky\n", FILE);
    expect(result.warnings[0]?.message ?? "").not.toContain("sk_live_leaky");
  });
});

describe(".env.example parsing — duplicate keys", () => {
  it("keeps a single entry when a key is declared twice", () => {
    const result = parseEnvExample("KEY=1\nKEY=2\n", FILE);
    expect(result.declared.size).toBe(1);
  });

  it("lets the last declaration of a duplicated key win on line number", () => {
    const result = parseEnvExample("KEY=1\nKEY=2\n", FILE);
    expect(result.declared.get("KEY")?.line).toBe(2);
  });

  it("lets the last declaration of a duplicated key win on optionality", () => {
    const result = parseEnvExample("KEY=1\n# KEY=\n", FILE);
    expect(result.declared.get("KEY")?.optional).toBe(true);
  });

  it("records a duplicate_declaration warning for a repeated key", () => {
    const result = parseEnvExample("KEY=1\nKEY=2\n", FILE);
    expect(result.warnings.map((w) => w.code)).toContain("duplicate_declaration");
  });

  it("names the duplicated key in the warning message", () => {
    const result = parseEnvExample("KEY=1\nKEY=2\n", FILE);
    expect(result.warnings[0]?.message ?? "").toContain("KEY");
  });

  it("points the duplicate warning at the later line", () => {
    const result = parseEnvExample("KEY=1\nOTHER=2\nKEY=3\n", FILE);
    const duplicate = result.warnings.find((w) => w.code === "duplicate_declaration");
    expect(duplicate?.line).toBe(3);
  });
});

describe(".env.example parsing — CRLF and BOM", () => {
  it("parses CRLF line endings without keeping the carriage return in the key", () => {
    const result = parseEnvExample("A=1\r\nB=2\r\n", FILE);
    expect([...result.declared.keys()].sort()).toEqual(["A", "B"]);
  });

  it("numbers lines correctly in a CRLF file", () => {
    const result = parseEnvExample("A=1\r\nB=2\r\nC=3\r\n", FILE);
    expect(result.declared.get("C")?.line).toBe(3);
  });

  it("parses a commented declaration with CRLF endings", () => {
    const result = parseEnvExample("# A=\r\n", FILE);
    expect(result.declared.get("A")?.optional).toBe(true);
  });

  it("strips a UTF-8 BOM from the first key", () => {
    const result = parseEnvExample("﻿FIRST_KEY=1\n", FILE);
    expect([...result.declared.keys()]).toEqual(["FIRST_KEY"]);
  });

  it("keeps the first line at line 1 when a BOM is present", () => {
    const result = parseEnvExample("﻿FIRST_KEY=1\n", FILE);
    expect(result.declared.get("FIRST_KEY")?.line).toBe(1);
  });

  it("handles a BOM followed by a comment line", () => {
    const result = parseEnvExample("﻿# A=\nB=2\n", FILE);
    expect([...result.declared.keys()].sort()).toEqual(["A", "B"]);
  });

  it("parses a lone-CR file without merging every line into one", () => {
    const result = parseEnvExample("A=1\rB=2\r", FILE);
    expect(result.declared.size).toBeGreaterThanOrEqual(1);
  });
});

describe(".env.example parsing — multiline values", () => {
  it("treats a literal backslash-n inside a quoted value as a single line", () => {
    const result = parseEnvExample('KEY="a\\nb"\nNEXT=1\n', FILE);
    expect([...result.declared.keys()].sort()).toEqual(["KEY", "NEXT"]);
  });

  it("gives the key after a literal backslash-n value the correct line number", () => {
    const result = parseEnvExample('KEY="a\\nb"\nNEXT=1\n', FILE);
    expect(result.declared.get("NEXT")?.line).toBe(2);
  });

  it("consumes an actual newline inside a quoted value as part of that value", () => {
    const result = parseEnvExample('PRIVATE_KEY="line one\nline two"\nNEXT=1\n', FILE);
    expect([...result.declared.keys()].sort()).toEqual(["NEXT", "PRIVATE_KEY"]);
  });

  it("gives the key after a multiline quoted value the correct line number", () => {
    const result = parseEnvExample('PRIVATE_KEY="line one\nline two"\nNEXT=1\n', FILE);
    expect(result.declared.get("NEXT")?.line).toBe(3);
  });

  it("does not declare a key that appears inside a multiline quoted value", () => {
    const result = parseEnvExample('PRIVATE_KEY="line one\nNOT_A_KEY=nope"\n', FILE);
    expect([...result.declared.keys()]).toEqual(["PRIVATE_KEY"]);
  });

  it("does not crash on a quoted value that is never closed", () => {
    expect(() => parseEnvExample('KEY="unterminated\n', FILE)).not.toThrow();
  });

  it("still declares the key of an unterminated quoted value", () => {
    const result = parseEnvExample('KEY="unterminated\n', FILE);
    expect([...result.declared.keys()]).toEqual(["KEY"]);
  });
});

describe(".env.example parsing — positions", () => {
  it("records the 1-based line of the first declaration", () => {
    const result = parseEnvExample("A=1\n", FILE);
    expect(result.declared.get("A")?.line).toBe(1);
  });

  it("records the 1-based line of a declaration after blank lines and comments", () => {
    const result = parseEnvExample("\n# a comment\n\nA=1\n", FILE);
    expect(result.declared.get("A")?.line).toBe(4);
  });

  it("records the file each declaration came from", () => {
    const result = parseEnvExample("A=1\n", "apps/web/.env.example");
    expect(result.declared.get("A")?.file).toBe("apps/web/.env.example");
  });

  it("records the line of a commented-out declaration", () => {
    const result = parseEnvExample("A=1\n# B=\n", FILE);
    expect(result.declared.get("B")?.line).toBe(2);
  });
});

describe(".env.example parsing — several files", () => {
  it("merges declarations from two example files", () => {
    const result = parseEnvExamples([
      { path: ".env.example", content: "A=1\n" },
      { path: ".env.production.example", content: "B=2\n" },
    ]);
    expect([...result.declared.keys()].sort()).toEqual(["A", "B"]);
  });

  it("parses a `.env.<environment>.example` file", () => {
    const result = parseEnvExamples([
      { path: ".env.production.example", content: "ANALYTICS_ID=\n" },
    ]);
    expect([...result.declared.keys()]).toEqual(["ANALYTICS_ID"]);
  });

  it("lets a later file win when the same key is declared twice", () => {
    const result = parseEnvExamples([
      { path: ".env.example", content: "SHARED=1\n" },
      { path: ".env.production.example", content: "# SHARED=\n" },
    ]);
    expect(result.declared.get("SHARED")?.optional).toBe(true);
  });

  it("attributes a key won by a later file to that later file", () => {
    const result = parseEnvExamples([
      { path: ".env.example", content: "SHARED=1\n" },
      { path: ".env.production.example", content: "SHARED=2\n" },
    ]);
    expect(result.declared.get("SHARED")?.file).toBe(".env.production.example");
  });

  it("warns when the same key is declared in two files", () => {
    const result = parseEnvExamples([
      { path: ".env.example", content: "SHARED=1\n" },
      { path: ".env.production.example", content: "SHARED=2\n" },
    ]);
    expect(result.warnings.map((w) => w.code)).toContain("duplicate_declaration");
  });

  it("keeps per-file warnings from every file it parsed", () => {
    const result = parseEnvExamples([
      { path: ".env.example", content: "=oops\n" },
      { path: ".env.production.example", content: "=also oops\n" },
    ]);
    expect(result.warnings.filter((w) => w.code === "invalid_env_line")).toHaveLength(2);
  });

  it("returns an empty result when given no files", () => {
    const result = parseEnvExamples([]);
    expect(result.declared.size).toBe(0);
  });

  it("orders the merged declaration map by key ascending", () => {
    const result = parseEnvExamples([
      { path: ".env.example", content: "ZED=1\nALPHA=2\n" },
      { path: ".env.production.example", content: "MIDDLE=3\n" },
    ]);
    expect([...result.declared.keys()]).toEqual(["ALPHA", "MIDDLE", "ZED"]);
  });
});

describe("isEnvExampleFile", () => {
  const examples: [string, boolean][] = [
    [".env.example", true],
    [".env.sample", true],
    [".env.template", true],
    [".env.production.example", true],
    [".env.local.example", true],
    [".env.staging.example", true],
    ["apps/web/.env.example", true],
    ["/abs/path/to/.env.sample", true],
    [".env", false],
    [".env.local", false],
    [".env.production", false],
    [".env.development", false],
    [".envrc", false],
    ["env.example", false],
    ["src/env.example.ts", false],
    [".env.example.bak", false],
    ["README.md", false],
  ];

  for (const [candidate, expected] of examples) {
    it(`${expected ? "accepts" : "rejects"} ${JSON.stringify(candidate)}`, () => {
      expect(isEnvExampleFile(candidate)).toBe(expected);
    });
  }
});

describe("I1 — a real .env is never read", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "envcontract-dotenv-"));
    await fs.writeFile(
      path.join(root, ".env"),
      "SECRET_ONLY_IN_DOTENV=hunter2\nSTRIPE_SECRET_KEY=sk_live_real\n",
      "utf8",
    );
    await fs.writeFile(path.join(root, ".env.example"), "STRIPE_SECRET_KEY=\n", "utf8");
  });

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("does not collect a real .env file", async () => {
    const collected = await collectFiles(root);
    expect(collected.files.map((f) => f.relativePath)).not.toContain(".env");
  });

  it("collects the .env.example sitting next to it", async () => {
    const collected = await collectFiles(root);
    expect(collected.files.map((f) => f.relativePath)).toContain(".env.example");
  });

  it("does not declare a key that only exists in the real .env", async () => {
    const collected = await collectFiles(root);
    const sources = await Promise.all(
      collected.files
        .filter((f) => f.kind === "env-example")
        .map(async (f) => ({ path: f.relativePath, content: await fs.readFile(f.path, "utf8") })),
    );
    const result = parseEnvExamples(sources);
    expect(result.declared.has("SECRET_ONLY_IN_DOTENV")).toBe(false);
  });

  it("never lets a value from the real .env reach the parsed result", async () => {
    const collected = await collectFiles(root);
    const sources = await Promise.all(
      collected.files
        .filter((f) => f.kind === "env-example")
        .map(async (f) => ({ path: f.relativePath, content: await fs.readFile(f.path, "utf8") })),
    );
    const result = parseEnvExamples(sources);
    const serialized = JSON.stringify({
      declared: [...result.declared],
      warnings: result.warnings,
      files: collected.files,
    });
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("sk_live_real");
  });
});

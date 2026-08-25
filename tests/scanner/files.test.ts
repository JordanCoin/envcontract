/**
 * SPEC: docs/SPEC.md — Module A `scanner`, "File selection (`scanDirectory`)":
 *
 *   include: `**\/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,vue,svelte,astro}` +
 *   `.env.example`/`.env.sample`/`.env.template`/`.env.*.example`;
 *   always ignore: node_modules, .git, .next, … , `*.d.ts`, `*.min.js`, `*.map`,
 *   test files (opt in via `include_tests`); respects `.gitignore` at root
 *   (simple patterns; negation not required); user include/exclude applied
 *   after; symlink loops don't hang; binary files skipped; files > 10MB skipped
 *   with a warning.
 *
 * These tests run against the REAL filesystem in a fresh `fs.mkdtemp` directory,
 * because the walking rules are exactly where a mocked filesystem would lie.
 *
 * Ambiguities resolved here:
 *  - `relativePath` is POSIX-separated and relative to `root`, and is the field
 *    the result is sorted by, so ordering is independent of readdir order.
 *  - An unsupported `.gitignore` pattern (negation, `**` globs) is skipped
 *    rather than approximated, and records a `gitignore_unsupported_pattern`
 *    warning so the behaviour is visible instead of silent.
 *  - The oversize and binary checks are observable through `scanDirectory`'s
 *    warnings; this suite does not pin which layer performs them.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ALWAYS_IGNORED_DIRECTORIES,
  DEFAULT_INCLUDE_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  collectFiles,
  looksBinary,
  matchesGlob,
  parseGitignore,
  readSourceFiles,
  scanDirectory,
} from "../../src/scanner/files.js";

let root = "";

async function write(relative: string, content: string | Buffer): Promise<string> {
  const full = path.join(root, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return full;
}

async function collectPaths(opts?: Parameters<typeof collectFiles>[1]): Promise<string[]> {
  const result = await collectFiles(root, opts);
  return result.files.map((f) => f.relativePath);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "envcontract-files-"));
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = "";
});

describe("File selection — included extensions", () => {
  for (const extension of DEFAULT_INCLUDE_EXTENSIONS) {
    it(`collects a source file with the ${extension} extension`, async () => {
      await write(`src/app${extension}`, "const a = 1;\n");
      expect(await collectPaths()).toContain(`src/app${extension}`);
    });
  }

  it("does not collect a plain text file", async () => {
    await write("notes.txt", "process.env.SECRET\n");
    expect(await collectPaths()).toEqual([]);
  });

  it("does not collect a markdown file", async () => {
    await write("README.md", "process.env.SECRET\n");
    expect(await collectPaths()).toEqual([]);
  });

  it("does not collect a JSON file", async () => {
    await write("package.json", '{"name":"x"}\n');
    expect(await collectPaths()).toEqual([]);
  });

  it("does not collect a workflow YAML file under .github", async () => {
    await write(".github/workflows/ci.yml", "on: push\n");
    expect(await collectPaths()).toEqual([]);
  });

  it("collects a source file nested several directories deep", async () => {
    await write("apps/web/src/lib/deep/stripe.ts", "const a = 1;\n");
    expect(await collectPaths()).toContain("apps/web/src/lib/deep/stripe.ts");
  });

  it("reports an absolute path alongside the relative one", async () => {
    await write("src/app.ts", "const a = 1;\n");
    const result = await collectFiles(root);
    expect(result.files[0]?.path).toBe(path.join(root, "src", "app.ts"));
  });

  it("labels a source file with the code kind", async () => {
    await write("src/app.ts", "const a = 1;\n");
    const result = await collectFiles(root);
    expect(result.files[0]?.kind).toBe("code");
  });
});

describe("File selection — env example files", () => {
  it("collects a root .env.example", async () => {
    await write(".env.example", "A=\n");
    expect(await collectPaths()).toContain(".env.example");
  });

  it("collects a nested package .env.example", async () => {
    await write("packages/api/.env.example", "A=\n");
    expect(await collectPaths()).toContain("packages/api/.env.example");
  });

  it("labels an example file with the env-example kind", async () => {
    await write("packages/api/.env.example", "A=\n");
    const result = await collectFiles(root);
    expect(result.files.find((f) => f.relativePath.endsWith(".env.example"))?.kind).toBe(
      "env-example",
    );
  });

  it("collects a .env.sample file", async () => {
    await write(".env.sample", "A=\n");
    expect(await collectPaths()).toContain(".env.sample");
  });

  it("collects a .env.template file", async () => {
    await write(".env.template", "A=\n");
    expect(await collectPaths()).toContain(".env.template");
  });

  it("collects a .env.production.example file", async () => {
    await write(".env.production.example", "A=\n");
    expect(await collectPaths()).toContain(".env.production.example");
  });

  it("does not collect a real .env file", async () => {
    await write(".env", "A=secret\n");
    expect(await collectPaths()).toEqual([]);
  });

  it("does not collect a .env.local file", async () => {
    await write(".env.local", "A=secret\n");
    expect(await collectPaths()).toEqual([]);
  });
});

describe("File selection — always ignored directories", () => {
  for (const directory of ALWAYS_IGNORED_DIRECTORIES) {
    it(`skips every file inside ${directory}`, async () => {
      await write(`${directory}/pkg/index.js`, "const a = 1;\n");
      await write("src/app.ts", "const a = 1;\n");
      expect(await collectPaths()).toEqual(["src/app.ts"]);
    });
  }

  it("skips a nested node_modules inside a workspace package", async () => {
    await write("packages/api/node_modules/dep/index.js", "const a = 1;\n");
    await write("packages/api/src/index.ts", "const a = 1;\n");
    expect(await collectPaths()).toEqual(["packages/api/src/index.ts"]);
  });

  it("still collects a directory whose name merely starts with an ignored name", async () => {
    await write("distribution/index.ts", "const a = 1;\n");
    expect(await collectPaths()).toContain("distribution/index.ts");
  });
});

describe("File selection — always ignored suffixes", () => {
  it("skips a TypeScript declaration file", async () => {
    await write("src/types.d.ts", "declare const a: number;\n");
    expect(await collectPaths()).toEqual([]);
  });

  it("skips a minified JavaScript bundle", async () => {
    await write("public/vendor.min.js", "var a=1;\n");
    expect(await collectPaths()).toEqual([]);
  });

  it("skips a source map file", async () => {
    await write("public/vendor.js.map", "{}\n");
    expect(await collectPaths()).toEqual([]);
  });

  it("still collects a file whose name contains but does not end with .min.js", async () => {
    await write("src/minifier.ts", "const a = 1;\n");
    expect(await collectPaths()).toContain("src/minifier.ts");
  });
});

describe("File selection — test files", () => {
  const testPaths = [
    "src/app.test.ts",
    "src/app.spec.ts",
    "src/__tests__/app.ts",
    "src/__mocks__/stripe.ts",
    "src/Button.stories.tsx",
  ];

  for (const candidate of testPaths) {
    it(`skips ${candidate} by default`, async () => {
      await write(candidate, "const a = 1;\n");
      expect(await collectPaths()).toEqual([]);
    });
  }

  for (const candidate of testPaths) {
    it(`collects ${candidate} when includeTests is set`, async () => {
      await write(candidate, "const a = 1;\n");
      expect(await collectPaths({ includeTests: true })).toContain(candidate);
    });
  }

  it("still collects a file whose name merely contains the word test", async () => {
    await write("src/testing-utils.ts", "const a = 1;\n");
    expect(await collectPaths()).toContain("src/testing-utils.ts");
  });
});

describe("File selection — user include and exclude globs", () => {
  it("collects a file matched by a user include glob that the defaults skip", async () => {
    await write("src/app.test.ts", "const a = 1;\n");
    expect(await collectPaths({ include: ["src/**/*.test.ts"] })).toContain("src/app.test.ts");
  });

  it("drops a default-included file matched by a user exclude glob", async () => {
    await write("src/app.ts", "const a = 1;\n");
    await write("src/keep.ts", "const a = 1;\n");
    expect(await collectPaths({ exclude: ["src/app.ts"] })).toEqual(["src/keep.ts"]);
  });

  it("lets exclude win over include for the same file", async () => {
    await write("src/app.ts", "const a = 1;\n");
    const paths = await collectPaths({ include: ["src/**"], exclude: ["src/app.ts"] });
    expect(paths).not.toContain("src/app.ts");
  });

  it("applies an exclude glob with a directory wildcard", async () => {
    await write("apps/legacy/index.ts", "const a = 1;\n");
    await write("apps/web/index.ts", "const a = 1;\n");
    expect(await collectPaths({ exclude: ["apps/legacy/**"] })).toEqual(["apps/web/index.ts"]);
  });

  it("applies an exclude glob with a brace alternation", async () => {
    await write("src/a.ts", "const a = 1;\n");
    await write("src/b.ts", "const a = 1;\n");
    await write("src/c.ts", "const a = 1;\n");
    expect(await collectPaths({ exclude: ["src/{a,b}.ts"] })).toEqual(["src/c.ts"]);
  });

  it("cannot un-ignore node_modules through a user include glob", async () => {
    await write("node_modules/dep/index.js", "const a = 1;\n");
    expect(await collectPaths({ include: ["node_modules/**"] })).toEqual([]);
  });
});

describe("File selection — .gitignore", () => {
  it("skips a file matched by a `*.ext` gitignore pattern", async () => {
    await write(".gitignore", "*.generated.ts\n");
    await write("src/schema.generated.ts", "const a = 1;\n");
    await write("src/app.ts", "const a = 1;\n");
    expect(await collectPaths()).toEqual(["src/app.ts"]);
  });

  it("skips a directory matched by a `dir/` gitignore pattern", async () => {
    await write(".gitignore", "generated/\n");
    await write("generated/schema.ts", "const a = 1;\n");
    await write("src/app.ts", "const a = 1;\n");
    expect(await collectPaths()).toEqual(["src/app.ts"]);
  });

  it("skips a single file matched by an exact `path/to/file` pattern", async () => {
    await write(".gitignore", "src/secret.ts\n");
    await write("src/secret.ts", "const a = 1;\n");
    await write("src/app.ts", "const a = 1;\n");
    expect(await collectPaths()).toEqual(["src/app.ts"]);
  });

  it("ignores blank lines and comments in .gitignore", async () => {
    await write(".gitignore", "\n# a comment\n\n*.log\n");
    await write("src/app.ts", "const a = 1;\n");
    expect(await collectPaths()).toEqual(["src/app.ts"]);
  });

  it("does not throw when .gitignore contains an unsupported negation pattern", async () => {
    await write(".gitignore", "generated/\n!generated/keep.ts\n");
    await write("generated/keep.ts", "const a = 1;\n");
    await expect(collectFiles(root)).resolves.toBeDefined();
  });

  it("skips an unsupported negation pattern rather than applying it", async () => {
    await write(".gitignore", "generated/\n!generated/keep.ts\n");
    await write("generated/keep.ts", "const a = 1;\n");
    expect(await collectPaths()).toEqual([]);
  });

  it("warns that a negation pattern in .gitignore is unsupported", async () => {
    await write(".gitignore", "generated/\n!generated/keep.ts\n");
    const result = await collectFiles(root);
    expect(result.warnings.map((w) => w.code)).toContain("gitignore_unsupported_pattern");
  });

  it("names the unsupported pattern in the warning message", async () => {
    await write(".gitignore", "!generated/keep.ts\n");
    const result = await collectFiles(root);
    const warning = result.warnings.find((w) => w.code === "gitignore_unsupported_pattern");
    expect(warning?.message ?? "").toContain("!generated/keep.ts");
  });

  it("collects a gitignored file when respectGitignore is false", async () => {
    await write(".gitignore", "generated/\n");
    await write("generated/schema.ts", "const a = 1;\n");
    expect(await collectPaths({ respectGitignore: false })).toEqual(["generated/schema.ts"]);
  });

  it("does not read a .gitignore nested below the root", async () => {
    await write("packages/api/.gitignore", "src/\n");
    await write("packages/api/src/index.ts", "const a = 1;\n");
    expect(await collectPaths()).toContain("packages/api/src/index.ts");
  });

  it("parses supported patterns out of a .gitignore body", () => {
    expect(parseGitignore("*.log\ndist/\nsrc/secret.ts\n").patterns).toEqual([
      "*.log",
      "dist/",
      "src/secret.ts",
    ]);
  });

  it("separates unsupported patterns out of a .gitignore body", () => {
    expect(parseGitignore("*.log\n!keep.log\n").unsupported).toEqual(["!keep.log"]);
  });

  it("drops comments and blank lines when parsing a .gitignore body", () => {
    expect(parseGitignore("# comment\n\n*.log\n").patterns).toEqual(["*.log"]);
  });
});

describe("File selection — unreadable and oversized files", () => {
  it("skips a binary file rather than scanning its bytes", async () => {
    await write("src/blob.js", Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x7f]));
    const result = await scanDirectory(root);
    expect(result.references).toEqual([]);
  });

  it("warns that a binary file was skipped", async () => {
    await write("src/blob.js", Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x7f]));
    const result = await scanDirectory(root);
    expect(result.warnings.map((w) => w.code)).toContain("binary_file");
  });

  it("still scans a real source file sitting next to a binary one", async () => {
    await write("src/blob.js", Buffer.from([0x00, 0x01, 0x02, 0xff]));
    await write("src/app.ts", "const k = process.env.API_KEY;\n");
    const result = await scanDirectory(root);
    expect(result.references.map((r) => r.key)).toEqual(["API_KEY"]);
  });

  it("skips a file larger than the 10MB limit", async () => {
    await write("src/huge.js", Buffer.alloc(MAX_FILE_SIZE_BYTES + 1, 0x61));
    const result = await scanDirectory(root);
    expect(result.filesScanned).toBe(0);
  });

  it("warns that an oversized file was skipped", async () => {
    await write("src/huge.js", Buffer.alloc(MAX_FILE_SIZE_BYTES + 1, 0x61));
    const result = await scanDirectory(root);
    expect(result.warnings.map((w) => w.code)).toContain("file_too_large");
  });

  it("honours a lowered maxFileSizeBytes option", async () => {
    await write("src/app.ts", "const a = 1;\n".repeat(100));
    const result = await scanDirectory(root, { maxFileSizeBytes: 8 });
    expect(result.warnings.map((w) => w.code)).toContain("file_too_large");
  });

  it("reads the collected source files that are neither binary nor oversized", async () => {
    await write("src/app.ts", "const k = process.env.API_KEY;\n");
    const collected = await collectFiles(root);
    const read = await readSourceFiles(collected.files);
    expect(read.sources.map((s) => s.path)).toEqual(["src/app.ts"]);
  });

  it("treats bytes containing a NUL as binary", () => {
    expect(looksBinary(Uint8Array.from([0x68, 0x69, 0x00, 0x21]))).toBe(true);
  });

  it("treats plain UTF-8 text as not binary", () => {
    expect(looksBinary(new TextEncoder().encode("const a = 1;\n"))).toBe(false);
  });

  it("treats an empty file as not binary", () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });
});

describe("File selection — symlinks", () => {
  it(
    "terminates when a symlink points back at an ancestor directory",
    async () => {
      await write("src/app.ts", "const a = 1;\n");
      await fs.symlink(root, path.join(root, "src", "loop"), "dir");
      await expect(collectFiles(root)).resolves.toBeDefined();
    },
    5000,
  );

  it(
    "does not report the same file twice through a symlink loop",
    async () => {
      await write("src/app.ts", "const a = 1;\n");
      await fs.symlink(root, path.join(root, "src", "loop"), "dir");
      const paths = await collectPaths();
      expect(new Set(paths).size).toBe(paths.length);
    },
    5000,
  );

  it(
    "terminates when two directories symlink to each other",
    async () => {
      await write("a/index.ts", "const a = 1;\n");
      await write("b/index.ts", "const a = 1;\n");
      await fs.symlink(path.join(root, "b"), path.join(root, "a", "to-b"), "dir");
      await fs.symlink(path.join(root, "a"), path.join(root, "b", "to-a"), "dir");
      await expect(collectFiles(root)).resolves.toBeDefined();
    },
    5000,
  );

  it("does not follow a symlink that points at a file outside the root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "envcontract-outside-"));
    try {
      await fs.writeFile(path.join(outside, "outside.ts"), "const a = 1;\n");
      await fs.symlink(path.join(outside, "outside.ts"), path.join(root, "linked.ts"), "file");
      expect(await collectPaths()).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("File selection — deterministic ordering", () => {
  it("returns files sorted by relative path regardless of creation order", async () => {
    for (const name of ["z.ts", "m.ts", "a.ts"]) {
      await write(`src/${name}`, "const a = 1;\n");
    }
    expect(await collectPaths()).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
  });

  it("sorts files across directories by their full relative path", async () => {
    await write("zebra/index.ts", "const a = 1;\n");
    await write("alpha/index.ts", "const a = 1;\n");
    await write("middle/index.ts", "const a = 1;\n");
    expect(await collectPaths()).toEqual([
      "alpha/index.ts",
      "middle/index.ts",
      "zebra/index.ts",
    ]);
  });

  it("returns the same order on two consecutive walks of the same tree", async () => {
    await write("b.ts", "const a = 1;\n");
    await write("a.ts", "const a = 1;\n");
    await write("src/c.ts", "const a = 1;\n");
    expect(await collectPaths()).toEqual(await collectPaths());
  });

  it("uses POSIX separators in relative paths even on a nested tree", async () => {
    await write("apps/web/src/app.ts", "const a = 1;\n");
    expect(await collectPaths()).toEqual(["apps/web/src/app.ts"]);
  });

  it("returns an empty list for an empty directory", async () => {
    expect(await collectPaths()).toEqual([]);
  });
});

describe("File selection — glob matching", () => {
  const cases: [string, string, boolean][] = [
    ["src/app.ts", "src/*.ts", true],
    ["src/lib/app.ts", "src/*.ts", false],
    ["src/lib/app.ts", "src/**/*.ts", true],
    ["src/app.ts", "**/*.ts", true],
    ["src/app.tsx", "**/*.ts", false],
    ["src/a.ts", "src/{a,b}.ts", true],
    ["src/c.ts", "src/{a,b}.ts", false],
    ["src/a.ts", "src/?.ts", true],
    ["src/ab.ts", "src/?.ts", false],
    ["apps/legacy/deep/x.ts", "apps/legacy/**", true],
  ];

  for (const [candidate, pattern, expected] of cases) {
    it(`${expected ? "matches" : "does not match"} ${candidate} against ${pattern}`, () => {
      expect(matchesGlob(candidate, pattern)).toBe(expected);
    });
  }
});

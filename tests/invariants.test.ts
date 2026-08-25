/**
 * SPEC: docs/SPEC.md — "Hard invariants (tests enforce every one)" I1/I3/I4, and
 * Module E (action.yml inputs and outputs).
 *
 * These assertions are about the repository itself, not about behaviour, so they
 * are green from day one and must STAY green: they are the guard rails the
 * implementation is not allowed to step over.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import { INPUT_NAMES, OUTPUT_NAMES } from "../src/run.js";
import { VERSION, USER_AGENT } from "../src/version.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const srcRoot = path.join(repoRoot, "src");

type ActionYml = {
  name?: string;
  description?: string;
  author?: string;
  branding?: { icon?: string; color?: string };
  inputs?: Record<string, { description?: string; required?: boolean; default?: string }>;
  outputs?: Record<string, { description?: string }>;
  runs?: { using?: string; main?: string };
};

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listSourceFiles(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

async function readActionYml(): Promise<ActionYml> {
  const raw = await fs.readFile(path.join(repoRoot, "action.yml"), "utf8");
  return yaml.load(raw) as ActionYml;
}

describe("action.yml is the published contract", () => {
  it("declares the node24 runtime, because node20 runners are removed 2026-09-16", async () => {
    const action = await readActionYml();
    expect(action.runs?.using).toBe("node24");
  });

  it("points at the committed ncc bundle", async () => {
    const action = await readActionYml();
    expect(action.runs?.main).toBe("dist/index.js");
  });

  it("carries the Marketplace metadata the listing requires", async () => {
    const action = await readActionYml();
    expect(action.name).toBe("EnvContract for Vercel");
    expect(action.author).toBe("JordanCoin");
    expect(typeof action.description).toBe("string");
    expect((action.description ?? "").length).toBeGreaterThan(20);
    expect(action.branding).toEqual({ icon: "shield", color: "purple" });
  });

  it("declares exactly the inputs the runner consumes", async () => {
    const action = await readActionYml();
    const declared = Object.keys(action.inputs ?? {}).sort();
    expect(declared).toEqual([...INPUT_NAMES].sort());
  });

  it("declares exactly the outputs the runner sets", async () => {
    const action = await readActionYml();
    const declared = Object.keys(action.outputs ?? {}).sort();
    expect(declared).toEqual([...OUTPUT_NAMES].sort());
  });

  it("gives every input a description", async () => {
    const action = await readActionYml();
    for (const [name, input] of Object.entries(action.inputs ?? {})) {
      expect(input.description, `input ${name} has no description`).toBeTruthy();
    }
  });

  it("gives every output a description", async () => {
    const action = await readActionYml();
    for (const [name, output] of Object.entries(action.outputs ?? {})) {
      expect(output.description, `output ${name} has no description`).toBeTruthy();
    }
  });

  it("requires only the Vercel token", async () => {
    const action = await readActionYml();
    const required = Object.entries(action.inputs ?? {})
      .filter(([, input]) => input.required === true)
      .map(([name]) => name);
    expect(required).toEqual(["vercel_token"]);
  });

  it("uses the SPEC defaults", async () => {
    const action = await readActionYml();
    const inputs = action.inputs ?? {};
    expect(inputs["target"]?.default).toBe("preview");
    expect(inputs["path"]?.default).toBe(".");
    expect(inputs["fail_on"]?.default).toBe("elsewhere");
    expect(inputs["on_error"]?.default).toBe("fail");
    expect(inputs["comment"]?.default).toBe("true");
    expect(inputs["report_url"]?.default).toBe("https://envcontract.vercel.app/api/report");
    expect(inputs["github_token"]?.default).toBe("${{ github.token }}");
    expect(inputs["include_tests"]?.default).toBe("false");
  });
});

describe("I1 — never see, log, store, or emit a value", () => {
  it("never builds a URL that asks Vercel to decrypt anything", async () => {
    const files = await listSourceFiles(srcRoot);
    for (const file of files) {
      const content = await fs.readFile(file, "utf8");
      expect(content, `${path.relative(repoRoot, file)} builds a decrypt query`).not.toMatch(
        /decrypt\s*[=:]\s*(true|1|"|')/,
      );
      expect(content, `${path.relative(repoRoot, file)} sends a decrypt param`).not.toContain(
        "decrypt=",
      );
    }
  });

  it("keeps stdout writing inside the CLI entry point", async () => {
    const files = await listSourceFiles(srcRoot);
    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(repoRoot, file);
      if (relative === path.join("src", "cli.ts")) continue;
      const content = await fs.readFile(file, "utf8");
      if (/\bconsole\.log\s*\(/.test(content)) offenders.push(relative);
      if (/process\.stdout\.write\s*\(/.test(content)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});

describe("I3 — deterministic", () => {
  it("never reaches for the wall clock outside the injected `now`", async () => {
    const files = await listSourceFiles(srcRoot);
    const offenders: string[] = [];
    for (const file of files) {
      const relative = path.relative(repoRoot, file);
      // main.ts and cli.ts are the only places allowed to build a real clock.
      if (relative === path.join("src", "main.ts") || relative === path.join("src", "cli.ts")) {
        continue;
      }
      const content = await fs.readFile(file, "utf8");
      if (/\bnew Date\s*\(/.test(content)) offenders.push(`${relative}: new Date()`);
      if (/\bDate\.now\s*\(/.test(content)) offenders.push(`${relative}: Date.now()`);
      if (/\bMath\.random\s*\(/.test(content)) offenders.push(`${relative}: Math.random()`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("packaging", () => {
  it("ships as ESM on Node 24", async () => {
    const raw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      type?: string;
      engines?: { node?: string };
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      version?: string;
    };
    expect(pkg.type).toBe("module");
    expect(pkg.engines?.node).toBe(">=24");
    expect(pkg.scripts?.["test"]).toBe("vitest run");
    expect(pkg.scripts?.["typecheck"]).toBe("tsc --noEmit");
    expect(pkg.scripts?.["build"]).toContain("ncc build src/main.ts -o dist");
  });

  it("depends on nothing at runtime but the two @actions packages", async () => {
    const raw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "@actions/core",
      "@actions/github",
    ]);
  });

  it("pins the same Node major in .nvmrc as the action runtime", async () => {
    const nvmrc = (await fs.readFile(path.join(repoRoot, ".nvmrc"), "utf8")).trim();
    expect(nvmrc).toBe("24");
  });

  it("keeps dist out of .gitignore, because the bundle is committed", async () => {
    const gitignore = await fs.readFile(path.join(repoRoot, ".gitignore"), "utf8");
    const patterns = gitignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(patterns).toContain("node_modules/");
    expect(patterns).toContain("coverage/");
    expect(patterns.some((p) => p === "dist" || p === "dist/")).toBe(false);
  });

  it("reports the package version as the report version", async () => {
    const raw = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    expect(pkg.version).toBe(VERSION);
  });

  it("sends a User-Agent that names the tool and its version", () => {
    expect(USER_AGENT).toBe(`envcontract/${VERSION}`);
  });
});

describe("module layout", () => {
  it("keeps every source module importable with an explicit .js specifier", async () => {
    const files = await listSourceFiles(srcRoot);
    for (const file of files) {
      const content = await fs.readFile(file, "utf8");
      const specifiers = [...content.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1] ?? "");
      for (const specifier of specifiers) {
        expect(specifier, `${path.relative(repoRoot, file)} imports ${specifier}`).toMatch(
          /\.js$/,
        );
      }
    }
  });

  it("has one module per SPEC unit", async () => {
    const files = (await listSourceFiles(srcRoot)).map((f) =>
      path.relative(srcRoot, f).split(path.sep).join("/"),
    );
    for (const expected of [
      "cli.ts",
      "compare.ts",
      "main.ts",
      "run.ts",
      "version.ts",
      "report/annotations.ts",
      "report/json.ts",
      "report/markdown.ts",
      "report/text.ts",
      "scanner/envfile.ts",
      "scanner/files.ts",
      "scanner/ignore.ts",
      "scanner/scanner.ts",
      "scanner/tokenizer.ts",
      "vercel/client.ts",
    ]) {
      expect(files).toContain(expected);
    }
  });
});

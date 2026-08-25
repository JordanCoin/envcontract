/**
 * SPEC: docs/SPEC.md — Module A `scanner`.
 *
 * Covers, in order:
 *   - "Recognized syntaxes (all → a Reference)"
 *   - "Optional detection (site is `optional: true` when)" and its "NOT optional" list
 *   - "Must NOT produce a Reference"
 *   - "Built-in ignore list (never reported)" + the user `ignore` input
 *   - "key validity", reference positions, ordering, and alias tracking
 *
 * Everything is driven through the pure entry point `scanFiles([{path, content}])`
 * so this file never touches the filesystem.
 */

import { describe, expect, it } from "vitest";

import {
  BUILTIN_IGNORE,
  BUILTIN_IGNORE_PREFIXES,
  VITE_BUILTIN_IGNORE,
} from "../../src/scanner/ignore.js";
import { scanFiles } from "../../src/scanner/scanner.js";
import type {
  Reference,
  ScanOptions,
  ScanResult,
  SourceFile,
} from "../../src/scanner/scanner.js";
import { makeFile } from "../helpers/fixtures.js";

/* ------------------------------------------------------------------ helpers */

/** UTF-8 byte order mark, built from its code point so it stays visible in review. */
const BOM = String.fromCharCode(0xfeff);

function scan(content: string, path = "src/index.ts", opts?: ScanOptions): ScanResult {
  return scanFiles([{ path, content }], opts);
}

function lines(...xs: string[]): string {
  return xs.join("\n");
}

function refKeys(result: ScanResult): string[] {
  return result.references.map((r) => r.key);
}

function keyNames(result: ScanResult): string[] {
  return [...result.keys.keys()];
}

/** Asserts the scan produced exactly one reference, matching `expected`. */
function expectOneRef(result: ScanResult, expected: Partial<Reference>): void {
  expect(result.references).toHaveLength(1);
  expect(result.references[0]).toMatchObject(expected);
}

/* ------------------------------------------------- Recognized syntaxes */

describe("Recognized syntaxes", () => {
  it("records a reference for dotted member access", () => {
    expectOneRef(scan("process.env.API_KEY;"), {
      key: "API_KEY",
      kind: "process.env",
      optional: false,
    });
  });

  it("records a reference for double-quoted bracket access", () => {
    expectOneRef(scan('process.env["API_KEY"];'), { key: "API_KEY", kind: "process.env" });
  });

  it("records a reference for single-quoted bracket access", () => {
    expectOneRef(scan("process.env['API_KEY'];"), { key: "API_KEY", kind: "process.env" });
  });

  it("records a reference for backtick bracket access without an interpolation", () => {
    expectOneRef(scan("process.env[`API_KEY`];"), { key: "API_KEY", kind: "process.env" });
  });

  it("records a reference through optional chaining on env", () => {
    expectOneRef(scan("process.env?.API_KEY;"), { key: "API_KEY", kind: "process.env" });
  });

  it("records a reference through globalThis.process.env", () => {
    expectOneRef(scan("globalThis.process.env.API_KEY;"), {
      key: "API_KEY",
      kind: "process.env",
    });
  });

  it("records a reference through window.process?.env", () => {
    expectOneRef(scan("window.process?.env.API_KEY;"), {
      key: "API_KEY",
      kind: "process.env",
    });
  });

  it("records one reference per destructured binding", () => {
    const result = scan("const { A_ONE, B_TWO } = process.env;");
    expect(refKeys(result)).toEqual(["A_ONE", "B_TWO"]);
  });

  it("records the source key, not the local alias, when destructuring renames", () => {
    const result = scan("const { A_ONE: local } = process.env;");
    expect(refKeys(result)).toEqual(["A_ONE"]);
  });

  it("marks a destructured binding with a default as optional", () => {
    const result = scan('const { B_TWO = "x" } = process.env;');
    expectOneRef(result, { key: "B_TWO", optional: true });
  });

  it("ignores a rest element while still recording the named bindings", () => {
    const result = scan("const { A_ONE, ...rest } = process.env;");
    expect(refKeys(result)).toEqual(["A_ONE"]);
  });

  it("records destructured bindings split across newlines", () => {
    const result = scan(lines("const {", "  A_ONE,", "  B_TWO,", "} = process.env;"));
    expect(refKeys(result)).toEqual(["A_ONE", "B_TWO"]);
  });

  it("records destructured bindings separated by comments inside the braces", () => {
    const result = scan(
      lines("const {", "  A_ONE, // first", "  /* second */ B_TWO,", "} = process.env;"),
    );
    expect(refKeys(result)).toEqual(["A_ONE", "B_TWO"]);
  });

  it("records destructured bindings with irregular whitespace inside the braces", () => {
    const result = scan("const {   A_ONE  ,   B_TWO   } = process.env;");
    expect(refKeys(result)).toEqual(["A_ONE", "B_TWO"]);
  });

  it("tags import.meta.env member access with the import.meta.env kind", () => {
    expectOneRef(scan("import.meta.env.VITE_API_URL;"), {
      key: "VITE_API_URL",
      kind: "import.meta.env",
    });
  });

  it("tags import.meta.env bracket access with the import.meta.env kind", () => {
    expectOneRef(scan('import.meta.env["VITE_API_URL"];'), {
      key: "VITE_API_URL",
      kind: "import.meta.env",
    });
  });

  it("tags import.meta.env destructuring with the import.meta.env kind", () => {
    const result = scan("const { VITE_API_URL, VITE_TOKEN } = import.meta.env;");
    expect(refKeys(result)).toEqual(["VITE_API_URL", "VITE_TOKEN"]);
    expect(result.references.every((r) => r.kind === "import.meta.env")).toBe(true);
  });

  it("resolves an alias bound by `const env = process.env`", () => {
    const result = scan(lines("const env = process.env;", "env.API_KEY;"));
    expectOneRef(result, { key: "API_KEY", kind: "process.env", line: 2 });
  });

  it("resolves an alias bound by destructuring `const { env } = process`", () => {
    const result = scan(lines("const { env } = process;", "env.API_KEY;"));
    expectOneRef(result, { key: "API_KEY", kind: "process.env", line: 2 });
  });

  it("resolves bracket access through an alias", () => {
    const result = scan(lines("const env = process.env;", 'env["API_KEY"];'));
    expectOneRef(result, { key: "API_KEY", kind: "process.env", line: 2 });
  });

  it("records a reference carrying a TypeScript non-null assertion", () => {
    expectOneRef(scan("const k = process.env.API_KEY!;"), { key: "API_KEY", optional: false });
  });

  it("records a reference carrying a TypeScript `as` cast", () => {
    expectOneRef(scan("const k = process.env.API_KEY as string;"), {
      key: "API_KEY",
      optional: false,
    });
  });

  it("records a reference inside a parenthesised nullish-coalescing chain", () => {
    expectOneRef(scan('const k = (process.env.API_KEY ?? "").trim();'), {
      key: "API_KEY",
      optional: true,
    });
  });

  it("records a reference used as a JSX attribute value", () => {
    const result = scan("const el = <Widget token={process.env.API_KEY} />;", "src/App.tsx");
    expectOneRef(result, { key: "API_KEY" });
  });

  it("records a reference interpolated into a template literal", () => {
    expectOneRef(scan("const url = `https://${process.env.API_HOST}/v1`;"), {
      key: "API_HOST",
    });
  });

  it("records a reference inside an arrow function body", () => {
    expectOneRef(scan("const get = () => process.env.API_KEY;"), { key: "API_KEY" });
  });

  it("records a reference inside a class field initialiser", () => {
    const result = scan(
      lines("class Client {", "  token = process.env.API_KEY;", "}"),
    );
    expectOneRef(result, { key: "API_KEY", line: 2 });
  });

  it("records a reference inside a nested template expression", () => {
    expectOneRef(scan("const s = `${`${process.env.API_KEY}`}`;"), { key: "API_KEY" });
  });

  it("records references from several syntaxes in one file", () => {
    const result = scan(
      lines(
        "const a = process.env.ONE;",
        'const b = process.env["TWO"];',
        "const { THREE } = process.env;",
        "const c = import.meta.env.FOUR;",
      ),
    );
    expect(refKeys(result)).toEqual(["ONE", "TWO", "THREE", "FOUR"]);
  });
});

/* -------------------------------------------------- Optional detection */

describe("Optional detection", () => {
  it("marks a site followed by `??` with a string fallback as optional", () => {
    expectOneRef(scan('const p = process.env.API_URL ?? "dev";'), {
      key: "API_URL",
      optional: true,
    });
  });

  it("marks a site followed by `||` with a numeric fallback as optional", () => {
    expectOneRef(scan("const p = process.env.API_PORT || 3000;"), {
      key: "API_PORT",
      optional: true,
    });
  });

  it("marks a destructured binding with a default as optional", () => {
    expectOneRef(scan('const { API_URL = "a" } = process.env;'), {
      key: "API_URL",
      optional: true,
    });
  });

  it("marks a site guarded by `typeof` as optional", () => {
    expectOneRef(scan('if (typeof process.env.API_URL === "string") {}'), {
      key: "API_URL",
      optional: true,
    });
  });

  it("marks a site probed with the `in` operator as optional", () => {
    expectOneRef(scan('if ("API_URL" in process.env) {}'), {
      key: "API_URL",
      optional: true,
    });
  });

  it("marks a site compared with `!== undefined` as optional", () => {
    expectOneRef(scan("if (process.env.API_URL !== undefined) {}"), {
      key: "API_URL",
      optional: true,
    });
  });

  it("marks a site compared with `=== undefined` as optional", () => {
    expectOneRef(scan("if (process.env.API_URL === undefined) {}"), {
      key: "API_URL",
      optional: true,
    });
  });

  it("marks a site used as the sole condition of an if as optional", () => {
    expectOneRef(scan("if (process.env.API_URL) { start(); }"), {
      key: "API_URL",
      optional: true,
    });
  });

  it("marks a site used as a ternary test as optional", () => {
    expectOneRef(scan("const v = process.env.API_URL ? a : b;"), {
      key: "API_URL",
      optional: true,
    });
  });

  it("marks a site used as the left operand of `&&` as optional", () => {
    expectOneRef(scan("const v = process.env.API_URL && connect();"), {
      key: "API_URL",
      optional: true,
    });
  });

  it("marks a site with a trailing `// envcontract-optional` comment as optional", () => {
    expectOneRef(scan("const v = process.env.API_URL; // envcontract-optional"), {
      key: "API_URL",
      optional: true,
    });
  });

  it("marks a site as optional when `// envcontract-optional` is on the preceding line", () => {
    const result = scan(lines("// envcontract-optional", "const v = process.env.API_URL;"));
    expectOneRef(result, { key: "API_URL", optional: true, line: 2 });
  });

  it("marks a site as optional when the nullish fallback is a call expression", () => {
    // SPEC resolution: `??` with a CALL right-hand side is optional.
    expectOneRef(scan("const v = process.env.API_URL ?? throwMissing();"), {
      key: "API_URL",
      optional: true,
    });
  });

  it("marks a site as optional when the fallback is an immediately-invoked thrower", () => {
    expectOneRef(
      scan('const v = process.env.API_URL ?? (() => { throw new Error("x"); })();'),
      { key: "API_URL", optional: true },
    );
  });

  it("keeps a site required when the nullish right-hand side is a throw expression", () => {
    // SPEC resolution: only a bare `throw` expression RHS keeps the site required.
    expectOneRef(scan('const v = process.env.API_URL ?? throw new Error("missing");'), {
      key: "API_URL",
      optional: false,
    });
  });

  it("keeps a site required when the nullish right-hand side is `undefined`", () => {
    expectOneRef(scan("const v = process.env.API_URL ?? undefined;"), {
      key: "API_URL",
      optional: false,
    });
  });

  it("keeps a site required when the logical-or right-hand side is `undefined`", () => {
    expectOneRef(scan("const v = process.env.API_URL || undefined;"), {
      key: "API_URL",
      optional: false,
    });
  });

  it("marks only the guarded site optional when a key is read twice", () => {
    const result = scan(
      lines('const a = process.env.API_URL ?? "dev";', "const b = process.env.API_URL;"),
    );
    expect(result.references.map((r) => r.optional)).toEqual([true, false]);
  });
});

/* ------------------------------------------------------- NOT optional */

describe("NOT optional", () => {
  it("keeps a site required when it carries a non-null assertion", () => {
    expectOneRef(scan("const v = process.env.API_URL!;"), { optional: false });
  });

  it("keeps a site required when it is cast with `as string`", () => {
    expectOneRef(scan("const v = process.env.API_URL as string;"), { optional: false });
  });

  it("keeps a site required when a method is called on it", () => {
    expectOneRef(scan("const v = process.env.API_URL.trim();"), { optional: false });
  });

  it("keeps a site required when it is wrapped in String()", () => {
    expectOneRef(scan("const v = String(process.env.API_URL);"), { optional: false });
  });

  it("keeps a site required when it is wrapped in Number()", () => {
    expectOneRef(scan("const v = Number(process.env.API_PORT);"), { optional: false });
  });

  it("keeps a site required when it is wrapped in parseInt()", () => {
    expectOneRef(scan("const v = parseInt(process.env.API_PORT, 10);"), { optional: false });
  });

  it("keeps a site required when it is passed to new URL()", () => {
    expectOneRef(scan("const v = new URL(process.env.API_URL);"), { optional: false });
  });

  it("keeps a site required when it is passed as a function argument", () => {
    expectOneRef(scan("configure(process.env.API_URL);"), { optional: false });
  });

  it("keeps a site required when it is interpolated into a template literal", () => {
    expectOneRef(scan("const v = `${process.env.API_URL}/health`;"), { optional: false });
  });

  it("keeps a site required when `??` appears later in the statement but not on it", () => {
    expectOneRef(scan('const v = fn(process.env.API_URL) ?? "dev";'), { optional: false });
  });

  it("keeps a site required when it is the right operand of `&&`", () => {
    expectOneRef(scan("const v = ready && process.env.API_URL;"), { optional: false });
  });

  it("keeps a site required when it is a branch of a ternary rather than its test", () => {
    expectOneRef(scan("const v = ready ? process.env.API_URL : fallback;"), {
      optional: false,
    });
  });

  it("keeps a site required when the if condition also tests something else", () => {
    expectOneRef(scan("if (ready && process.env.API_URL.length) {}"), { optional: false });
  });
});

/* --------------------------------------- Must NOT produce a Reference */

describe("Must NOT produce a Reference", () => {
  it("ignores a reference inside a line comment", () => {
    const result = scan("// process.env.API_KEY is read elsewhere");
    expect(result.references).toEqual([]);
  });

  it("ignores a reference inside a block comment", () => {
    const result = scan("/* process.env.API_KEY */");
    expect(result.references).toEqual([]);
  });

  it("ignores a reference inside a multi-line JSDoc block", () => {
    const result = scan(
      lines("/**", " * Reads process.env.API_KEY at boot.", " * @see process.env.OTHER", " */"),
    );
    expect(result.references).toEqual([]);
  });

  it("ignores a reference inside a single-quoted string literal", () => {
    const result = scan("const msg = 'set process.env.FOO first';");
    expect(result.references).toEqual([]);
  });

  it("ignores a reference inside a double-quoted string literal", () => {
    const result = scan('const msg = "process.env.FOO";');
    expect(result.references).toEqual([]);
  });

  it("ignores a reference inside template literal text", () => {
    const result = scan("const msg = `process.env.FOO is unset`;");
    expect(result.references).toEqual([]);
  });

  it("ignores a reference inside a regex literal", () => {
    const result = scan("const re = /process\\.env\\.X/;");
    expect(result.references).toEqual([]);
  });

  it("ignores a bare `process.env` with no key", () => {
    const result = scan("const all = process.env;");
    expect(result.references).toEqual([]);
  });

  it("ignores `process.environment.X`", () => {
    const result = scan("const v = process.environment.API_KEY;");
    expect(result.references).toEqual([]);
  });

  it("ignores `myprocess.env.X`", () => {
    const result = scan("const v = myprocess.env.API_KEY;");
    expect(result.references).toEqual([]);
  });

  it("ignores `process.envX`", () => {
    const result = scan("const v = process.envX;");
    expect(result.references).toEqual([]);
  });

  it("ignores `process.env.` followed by a non-identifier", () => {
    const result = scan("const v = process.env.();");
    expect(result.references).toEqual([]);
  });

  it("ignores a line carrying a trailing `// envcontract-ignore` comment", () => {
    const result = scan("const v = process.env.API_KEY; // envcontract-ignore");
    expect(result.references).toEqual([]);
  });

  it("ignores every reference in a file containing `/* envcontract-ignore-file */`", () => {
    const result = scan(
      lines("/* envcontract-ignore-file */", "const a = process.env.ONE;", "const b = process.env.TWO;"),
    );
    expect(result.references).toEqual([]);
  });

  it("ignores every reference when the ignore-file marker appears at the bottom", () => {
    const result = scan(
      lines("const a = process.env.ONE;", "/* envcontract-ignore-file */"),
    );
    expect(result.references).toEqual([]);
  });

  it("ignores a reference inside a JSX comment expression", () => {
    const result = scan("const el = <div>{/* process.env.API_KEY */}</div>;", "src/App.tsx");
    expect(result.references).toEqual([]);
  });

  it("still records the key inside bracket access even though it is quoted", () => {
    expectOneRef(scan('const v = process.env["API_KEY"];'), { key: "API_KEY" });
  });

  it("records the reference on the following line when a comment mentions it first", () => {
    const result = scan(lines("// process.env.DECOY", "const v = process.env.REAL_KEY;"));
    expectOneRef(result, { key: "REAL_KEY", line: 2 });
  });

  it("ignores only the ignored line, not its neighbours", () => {
    const result = scan(
      lines("const a = process.env.KEPT_ONE;", "const b = process.env.DROPPED; // envcontract-ignore", "const c = process.env.KEPT_TWO;"),
    );
    expect(refKeys(result)).toEqual(["KEPT_ONE", "KEPT_TWO"]);
  });
});

/* --------------------------------------------------------- dynamicAccess */

describe("dynamicAccess", () => {
  it("records a dynamic access for a variable subscript instead of a reference", () => {
    const result = scan("const v = process.env[k];");
    expect(result.references).toEqual([]);
    expect(result.dynamicAccess).toEqual([
      { file: "src/index.ts", line: 1, kind: "process.env" },
    ]);
  });

  it("records a dynamic access for an interpolated template subscript", () => {
    const result = scan("const v = process.env[`${prefix}_X`];");
    expect(result.references).toEqual([]);
    expect(result.dynamicAccess).toHaveLength(1);
  });

  it("records a dynamic access for a concatenated string subscript", () => {
    const result = scan('const v = process.env["A" + "B"];');
    expect(result.references).toEqual([]);
    expect(result.dynamicAccess).toHaveLength(1);
  });

  it("records a dynamic access for a member-expression subscript", () => {
    const result = scan("const v = process.env[cfg.key];");
    expect(result.references).toEqual([]);
    expect(result.dynamicAccess).toHaveLength(1);
  });

  it("records the 1-based line of a dynamic access", () => {
    const result = scan(lines("const a = 1;", "", "const v = process.env[k];"));
    expect(result.dynamicAccess[0]?.line).toBe(3);
  });

  it("tags a dynamic access through import.meta.env with that kind", () => {
    const result = scan("const v = import.meta.env[k];");
    expect(result.dynamicAccess[0]?.kind).toBe("import.meta.env");
  });

  it("records one dynamic access per site", () => {
    const result = scan(lines("process.env[a];", "process.env[b];"));
    expect(result.dynamicAccess).toHaveLength(2);
  });

  it("records both a static reference and a dynamic access in the same file", () => {
    const result = scan(lines("process.env.STATIC_KEY;", "process.env[dynamic];"));
    expect(refKeys(result)).toEqual(["STATIC_KEY"]);
    expect(result.dynamicAccess).toHaveLength(1);
  });
});

/* --------------------------------------------------- Built-in ignore list */

describe("Built-in ignore list", () => {
  it("lists VERCEL_HASH_SALT among the built-ins", () => {
    expect(BUILTIN_IGNORE).toContain("VERCEL_HASH_SALT");
  });

  it("lists VERCEL_AUTOMATION_BYPASS_SECRET among the built-ins", () => {
    expect(BUILTIN_IGNORE).toContain("VERCEL_AUTOMATION_BYPASS_SECRET");
  });

  it("holds no duplicate built-in keys", () => {
    expect(new Set(BUILTIN_IGNORE).size).toBe(BUILTIN_IGNORE.length);
  });

  it("is not empty", () => {
    expect(BUILTIN_IGNORE.length).toBeGreaterThan(0);
  });

  it("declares the npm and Vercel git prefix families", () => {
    expect(BUILTIN_IGNORE_PREFIXES).toContain("npm_");
    expect(BUILTIN_IGNORE_PREFIXES).toContain("VERCEL_GIT_");
    expect(BUILTIN_IGNORE_PREFIXES).toContain("NEXT_PUBLIC_VERCEL_");
  });

  it("declares exactly the five Vite built-ins", () => {
    expect([...VITE_BUILTIN_IGNORE].sort()).toEqual(
      ["BASE_URL", "DEV", "MODE", "PROD", "SSR"].sort(),
    );
  });

  it("drops NODE_ENV from references and keys", () => {
    const result = scan("const v = process.env.NODE_ENV;");
    expect(result.references).toEqual([]);
    expect(keyNames(result)).toEqual([]);
    expect(result.ignoredBuiltins).toEqual(["NODE_ENV"]);
  });

  it("drops VERCEL_URL from references and keys", () => {
    const result = scan("const v = process.env.VERCEL_URL;");
    expect(result.references).toEqual([]);
    expect(result.ignoredBuiltins).toEqual(["VERCEL_URL"]);
  });

  it("drops an npm_ prefixed key", () => {
    const result = scan("const v = process.env.npm_config_registry;");
    expect(result.references).toEqual([]);
    expect(result.ignoredBuiltins).toEqual(["npm_config_registry"]);
  });

  it("drops NEXT_PUBLIC_VERCEL_URL", () => {
    const result = scan("const v = process.env.NEXT_PUBLIC_VERCEL_URL;");
    expect(result.references).toEqual([]);
    expect(result.ignoredBuiltins).toEqual(["NEXT_PUBLIC_VERCEL_URL"]);
  });

  it("drops a VERCEL_GIT_ prefixed key", () => {
    const result = scan("const v = process.env.VERCEL_GIT_COMMIT_SHA;");
    expect(result.references).toEqual([]);
    expect(result.ignoredBuiltins).toEqual(["VERCEL_GIT_COMMIT_SHA"]);
  });

  it("drops an AWS_LAMBDA_ prefixed key", () => {
    const result = scan("const v = process.env.AWS_LAMBDA_FUNCTION_NAME;");
    expect(result.references).toEqual([]);
    expect(result.ignoredBuiltins).toEqual(["AWS_LAMBDA_FUNCTION_NAME"]);
  });

  it("drops VERCEL_HASH_SALT", () => {
    const result = scan("const v = process.env.VERCEL_HASH_SALT;");
    expect(result.references).toEqual([]);
    expect(result.ignoredBuiltins).toEqual(["VERCEL_HASH_SALT"]);
  });

  it("drops VERCEL_AUTOMATION_BYPASS_SECRET", () => {
    const result = scan("const v = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;");
    expect(result.references).toEqual([]);
    expect(result.ignoredBuiltins).toEqual(["VERCEL_AUTOMATION_BYPASS_SECRET"]);
  });

  it("drops a __NEXT_ prefixed key", () => {
    const result = scan("const v = process.env.__NEXT_ROUTER_BASEPATH;");
    expect(result.references).toEqual([]);
    expect(result.ignoredBuiltins).toEqual(["__NEXT_ROUTER_BASEPATH"]);
  });

  it("drops the Vite built-ins when read from import.meta.env", () => {
    const result = scan(
      lines(
        "const a = import.meta.env.MODE;",
        "const b = import.meta.env.DEV;",
        "const c = import.meta.env.PROD;",
        "const d = import.meta.env.SSR;",
        "const e = import.meta.env.BASE_URL;",
      ),
    );
    expect(result.references).toEqual([]);
    expect(result.ignoredBuiltins).toEqual(["BASE_URL", "DEV", "MODE", "PROD", "SSR"]);
  });

  it("keeps process.env.MODE even though import.meta.env.MODE is a built-in", () => {
    const result = scan(
      lines("const a = process.env.MODE;", "const b = import.meta.env.MODE;"),
    );
    expect(refKeys(result)).toEqual(["MODE"]);
    expect(result.references[0]?.kind).toBe("process.env");
    expect(result.ignoredBuiltins).toEqual(["MODE"]);
  });

  it("keeps a VITE_ prefixed key read from import.meta.env", () => {
    const result = scan("const v = import.meta.env.VITE_API_URL;");
    expect(refKeys(result)).toEqual(["VITE_API_URL"]);
    expect(result.ignoredBuiltins).toEqual([]);
  });

  it("returns ignoredBuiltins sorted ascending", () => {
    const result = scan(
      lines(
        "const a = process.env.VERCEL_URL;",
        "const b = process.env.NODE_ENV;",
        "const c = process.env.CI;",
      ),
    );
    expect(result.ignoredBuiltins).toEqual(["CI", "NODE_ENV", "VERCEL_URL"]);
  });

  it("de-duplicates ignoredBuiltins across repeated sites", () => {
    const result = scan(
      lines("const a = process.env.NODE_ENV;", "const b = process.env.NODE_ENV;"),
    );
    expect(result.ignoredBuiltins).toEqual(["NODE_ENV"]);
  });

  it("de-duplicates ignoredBuiltins across files", () => {
    const result = scanFiles([
      makeFile("src/a.ts", "process.env.NODE_ENV;"),
      makeFile("src/b.ts", "process.env.NODE_ENV;"),
    ]);
    expect(result.ignoredBuiltins).toEqual(["NODE_ENV"]);
  });

  it("keeps a user key that merely starts like a built-in", () => {
    const result = scan("const v = process.env.NODE_ENVIRONMENT_LABEL;");
    expect(refKeys(result)).toEqual(["NODE_ENVIRONMENT_LABEL"]);
  });

  it("keeps a user key that merely ends like a built-in", () => {
    const result = scan("const v = process.env.MY_VERCEL_URL;");
    expect(refKeys(result)).toEqual(["MY_VERCEL_URL"]);
  });

  it("drops a built-in reached through a destructuring pattern", () => {
    const result = scan("const { NODE_ENV, API_KEY } = process.env;");
    expect(refKeys(result)).toEqual(["API_KEY"]);
    expect(result.ignoredBuiltins).toEqual(["NODE_ENV"]);
  });
});

/* ------------------------------------------------------ user ignore input */

describe("user ignore input", () => {
  it("drops a key matching an exact user ignore entry", () => {
    const result = scan("const v = process.env.LEGACY_KEY;", "src/index.ts", {
      ignore: ["LEGACY_KEY"],
    });
    expect(result.references).toEqual([]);
    expect(keyNames(result)).toEqual([]);
  });

  it("drops keys matching a PREFIX_* user ignore glob", () => {
    const result = scan(
      lines("process.env.PREFIX_ONE;", "process.env.PREFIX_TWO;", "process.env.OTHER;"),
      "src/index.ts",
      { ignore: ["PREFIX_*"] },
    );
    expect(refKeys(result)).toEqual(["OTHER"]);
  });

  it("does not drop a key that only partially matches a user ignore entry", () => {
    const result = scan("const v = process.env.LEGACY_KEY_TWO;", "src/index.ts", {
      ignore: ["LEGACY_KEY"],
    });
    expect(refKeys(result)).toEqual(["LEGACY_KEY_TWO"]);
  });

  it("keeps user-ignored keys out of ignoredBuiltins", () => {
    const result = scan("const v = process.env.LEGACY_KEY;", "src/index.ts", {
      ignore: ["LEGACY_KEY"],
    });
    expect(result.ignoredBuiltins).toEqual([]);
  });

  it("applies several user ignore patterns at once", () => {
    const result = scan(
      lines("process.env.A_ONE;", "process.env.B_TWO;", "process.env.C_THREE;"),
      "src/index.ts",
      { ignore: ["A_ONE", "B_*"] },
    );
    expect(refKeys(result)).toEqual(["C_THREE"]);
  });
});

/* ------------------------------------------------------------ key validity */

describe("key validity", () => {
  it("skips a key containing a non-ASCII letter", () => {
    const result = scan("const v = process.env.ÜBER;");
    expect(result.references).toEqual([]);
  });

  it("warns with invalid_key for a non-ASCII key", () => {
    const result = scan("const v = process.env.ÜBER;");
    expect(result.warnings.map((w) => w.code)).toContain("invalid_key");
  });

  it("skips a key starting with a digit", () => {
    const result = scan('const v = process.env["123"];');
    expect(result.references).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain("invalid_key");
  });

  it("skips a key starting with a dollar sign", () => {
    const result = scan("const v = process.env.$X;");
    expect(result.references).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain("invalid_key");
  });

  it("skips a key containing a hyphen", () => {
    const result = scan('const v = process.env["MY-KEY"];');
    expect(result.references).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain("invalid_key");
  });

  it("keeps a lowercase key exactly as written", () => {
    expectOneRef(scan("const v = process.env.port;"), { key: "port" });
  });

  it("keeps a mixed-case key exactly as written", () => {
    expectOneRef(scan("const v = process.env.myApiKey;"), { key: "myApiKey" });
  });

  it("keeps a key that is a single underscore-led identifier", () => {
    expectOneRef(scan("const v = process.env._INTERNAL_FLAG;"), { key: "_INTERNAL_FLAG" });
  });

  it("keeps a key containing digits after the first character", () => {
    expectOneRef(scan("const v = process.env.S3_BUCKET;"), { key: "S3_BUCKET" });
  });

  it("reports the invalid key warning against the file it came from", () => {
    const result = scan("const v = process.env.$X;", "src/config.ts");
    expect(result.warnings[0]?.file).toBe("src/config.ts");
  });
});

/* --------------------------------------------------------------- positions */

describe("positions", () => {
  it("reports 1-based line and column for a dotted access at the start of a line", () => {
    expectOneRef(scan("process.env.FOO;"), { line: 1, col: 13 });
  });

  it("reports the column of the key inside bracket access", () => {
    expectOneRef(scan('process.env["FOO"];'), { line: 1, col: 14 });
  });

  it("reports the column of a destructured binding", () => {
    const result = scan("const { A, B } = process.env;");
    expect(result.references.map((r) => r.col)).toEqual([9, 12]);
  });

  it("reports the correct line for a reference on the third line", () => {
    expectOneRef(scan(lines("const a = 1;", "", "process.env.FOO;")), { line: 3, col: 13 });
  });

  it("reports positions correctly with CRLF line endings", () => {
    const result = scan(["const a = 1;", "", "process.env.FOO;"].join("\r\n"));
    expectOneRef(result, { line: 3, col: 13 });
  });

  it("reports the position of a reference following a multi-line block comment", () => {
    const result = scan(lines("/* a", "   b */process.env.FOO;"));
    expectOneRef(result, { line: 2, col: 20 });
  });

  it("reports the position of a reference inside a template expression", () => {
    expectOneRef(scan("const s = `x ${process.env.FOO} y`;"), { line: 1, col: 28 });
  });

  it("reports column 1-based on the first line when the file starts with a BOM", () => {
    expectOneRef(scan(BOM + "process.env.FOO;"), { line: 1, col: 13 });
  });

  it("reports the correct line for a reference after a BOM and a comment line", () => {
    expectOneRef(scan(BOM + lines("// header", "process.env.FOO;")), { line: 2, col: 13 });
  });

  it("records the file path each reference came from", () => {
    const result = scanFiles([makeFile("src/lib/stripe.ts", "process.env.FOO;")]);
    expectOneRef(result, { file: "src/lib/stripe.ts" });
  });
});

/* ---------------------------------------------------------------- ordering */

describe("ordering", () => {
  it("sorts references by file path ascending regardless of input order", () => {
    const files: SourceFile[] = [
      makeFile("src/z.ts", "process.env.Z_KEY;"),
      makeFile("src/a.ts", "process.env.A_KEY;"),
      makeFile("src/m.ts", "process.env.M_KEY;"),
    ];
    const result = scanFiles(files);
    expect(result.references.map((r) => r.file)).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
  });

  it("sorts references within a file by line", () => {
    const result = scan(lines("process.env.B_KEY;", "process.env.A_KEY;"));
    expect(result.references.map((r) => r.line)).toEqual([1, 2]);
  });

  it("sorts two references on the same line by column", () => {
    const result = scan("const p = [process.env.B_KEY, process.env.A_KEY];");
    expect(refKeys(result)).toEqual(["B_KEY", "A_KEY"]);
    const [first, second] = result.references;
    expect((first?.col ?? 0) < (second?.col ?? 0)).toBe(true);
  });

  it("orders the keys map ascending by key", () => {
    const result = scan(
      lines("process.env.ZEBRA;", "process.env.ALPHA;", "process.env.MIKE;"),
    );
    expect(keyNames(result)).toEqual(["ALPHA", "MIKE", "ZEBRA"]);
  });

  it("orders the keys map ascending across files", () => {
    const result = scanFiles([
      makeFile("src/z.ts", "process.env.ZEBRA;"),
      makeFile("src/a.ts", "process.env.ALPHA;"),
    ]);
    expect(keyNames(result)).toEqual(["ALPHA", "ZEBRA"]);
  });

  it("marks a key required when any of its sites is non-optional", () => {
    const result = scan(
      lines('const a = process.env.API_URL ?? "dev";', "const b = process.env.API_URL;"),
    );
    expect(result.keys.get("API_URL")?.required).toBe(true);
  });

  it("marks a key optional only when every site is optional", () => {
    const result = scan(
      lines('const a = process.env.API_URL ?? "dev";', "const b = process.env.API_URL || 1;"),
    );
    expect(result.keys.get("API_URL")?.required).toBe(false);
  });

  it("records both sites for a key referenced twice in one file", () => {
    const result = scan(lines("process.env.API_URL;", "process.env.API_URL;"));
    expect(result.keys.get("API_URL")?.sites).toHaveLength(2);
    expect(result.references).toHaveLength(2);
  });

  it("records sites for a key referenced in two files", () => {
    const result = scanFiles([
      makeFile("src/a.ts", "process.env.API_URL;"),
      makeFile("src/b.ts", "process.env.API_URL;"),
    ]);
    expect(result.keys.get("API_URL")?.sites.map((s) => s.file)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("keeps key sites in the same order as references", () => {
    const result = scan(lines("process.env.API_URL;", "", "process.env.API_URL;"));
    expect(result.keys.get("API_URL")?.sites.map((s) => s.line)).toEqual([1, 3]);
  });

  it("produces a byte-identical result for the same input twice", () => {
    const content = lines("process.env.B_KEY;", "process.env.A_KEY;");
    const first = scan(content);
    const second = scan(content);
    expect(JSON.stringify(first.references)).toBe(JSON.stringify(second.references));
  });
});

/* ---------------------------------------------------------- alias tracking */

describe("alias tracking", () => {
  it("does not resolve an alias bound in another file", () => {
    const result = scanFiles([
      makeFile("src/a.ts", "const env = process.env;"),
      makeFile("src/b.ts", "const v = env.API_KEY;"),
    ]);
    expect(result.references).toEqual([]);
  });

  it("resolves an alias only after its binding line", () => {
    const result = scan(lines("const before = env.EARLY;", "const env = process.env;", "const after = env.LATE;"));
    expect(refKeys(result)).toEqual(["LATE"]);
  });

  it("ignores a local `env` bound to an object literal", () => {
    const result = scan(lines("const env = {};", "const v = env.API_KEY;"));
    expect(result.references).toEqual([]);
  });

  it("ignores a local `env` bound to an imported module", () => {
    const result = scan(
      lines('import { env } from "./config.js";', "const v = env.API_KEY;"),
    );
    expect(result.references).toEqual([]);
  });

  it("resolves an alias under any local name", () => {
    const result = scan(lines("const cfg = process.env;", "const v = cfg.API_KEY;"));
    expectOneRef(result, { key: "API_KEY", line: 2 });
  });

  it("marks an aliased site optional when it has a fallback", () => {
    const result = scan(lines("const env = process.env;", 'const v = env.API_KEY ?? "dev";'));
    expectOneRef(result, { key: "API_KEY", optional: true });
  });

  it("records a dynamic access through an alias", () => {
    const result = scan(lines("const env = process.env;", "const v = env[k];"));
    expect(result.references).toEqual([]);
    expect(result.dynamicAccess).toHaveLength(1);
  });
});

/* ------------------------------------------------- single-file components */

describe("single-file components", () => {
  it("finds a reference inside a .vue script block", () => {
    const result = scanFiles([
      makeFile(
        "src/App.vue",
        lines("<template><p>hi</p></template>", "<script setup>", "const v = process.env.VUE_KEY;", "</script>"),
      ),
    ]);
    expect(refKeys(result)).toEqual(["VUE_KEY"]);
  });

  it("finds a reference inside a .svelte script block", () => {
    const result = scanFiles([
      makeFile(
        "src/App.svelte",
        lines("<script>", "const v = process.env.SVELTE_KEY;", "</script>", "<p>hi</p>"),
      ),
    ]);
    expect(refKeys(result)).toEqual(["SVELTE_KEY"]);
  });

  it("finds a reference inside an .astro frontmatter block", () => {
    const result = scanFiles([
      makeFile("src/index.astro", lines("---", "const v = process.env.ASTRO_KEY;", "---", "<p>hi</p>")),
    ]);
    expect(refKeys(result)).toEqual(["ASTRO_KEY"]);
  });

  it("reports the 1-based line of a reference inside a script block", () => {
    const result = scanFiles([
      makeFile("src/App.svelte", lines("<script>", "const v = process.env.SVELTE_KEY;", "</script>")),
    ]);
    expect(result.references[0]?.line).toBe(2);
  });
});

/* ------------------------------------------------ filesScanned and warnings */

describe("filesScanned and warnings", () => {
  it("counts every file handed in, including files with no references", () => {
    const result = scanFiles([
      makeFile("src/a.ts", "process.env.A_KEY;"),
      makeFile("src/b.ts", "const x = 1;"),
      makeFile("src/c.ts", ""),
    ]);
    expect(result.filesScanned).toBe(3);
  });

  it("counts an ignore-file marked file as scanned", () => {
    const result = scan("/* envcontract-ignore-file */\nprocess.env.A_KEY;");
    expect(result.filesScanned).toBe(1);
  });

  it("returns an empty result for an empty file list", () => {
    const result = scanFiles([]);
    expect(result.filesScanned).toBe(0);
    expect(result.references).toEqual([]);
    expect(keyNames(result)).toEqual([]);
  });

  it("records a warning for an unterminated string without throwing", () => {
    const result = scan('const s = "unterminated;');
    expect(result.warnings.map((w) => w.code)).toContain("unterminated_string");
  });

  it("records a warning for an unterminated block comment without throwing", () => {
    const result = scan("/* never closed");
    expect(result.warnings.map((w) => w.code)).toContain("unterminated_comment");
  });

  it("records a warning for an unterminated template without throwing", () => {
    const result = scan("const s = `never closed;");
    expect(result.warnings.map((w) => w.code)).toContain("unterminated_template");
  });

  it("attributes each warning to the file it came from", () => {
    const result = scanFiles([
      makeFile("src/ok.ts", "process.env.A_KEY;"),
      makeFile("src/bad.ts", 'const s = "unterminated;'),
    ]);
    expect(result.warnings.every((w) => w.file === "src/bad.ts")).toBe(true);
  });

  it("still reports references found before an unterminated construct", () => {
    const result = scan(lines("process.env.A_KEY;", 'const s = "unterminated;'));
    expect(refKeys(result)).toEqual(["A_KEY"]);
  });
});

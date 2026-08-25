/**
 * SPEC: docs/SPEC.md — Module A `scanner`, "Tokenizer robustness".
 * Also covers the tokenizer-level half of "Must NOT produce a Reference".
 *
 * Contract pinned by this file (read this before implementing):
 *
 *  - CODE vs NON-CODE follows the stub's own wording: a line comment and a block
 *    comment are non-code IN FULL, while for strings, templates and regexes only
 *    the BODY/TEXT is non-code — the delimiters (quotes, backticks, `${`, `}`,
 *    the regex slashes and flags) stay code. That is what lets the scanner see
 *    `process.env["FOO"]` as a bracket access while never reading string text.
 *  - `maskNonCode` replaces every non-code character with a space and preserves
 *    `\r` and `\n`, so the output has the same length and the same line/col map
 *    as the input.
 *  - Regex-vs-division uses the SPEC heuristic verbatim: if the previous
 *    significant token is an identifier, a number, `)` or `]`, a `/` is
 *    DIVISION. This deliberately mis-reads `if (a) /re/.test(b)` as division —
 *    a documented limitation, and the safe direction (we keep more code visible
 *    rather than swallowing a file into a regex).
 */

import { describe, expect, it } from "vitest";

import {
  isCodeOffset,
  maskNonCode,
  offsetToPosition,
  stripBom,
  tokenize,
  type CodeRegion,
} from "../../src/scanner/tokenizer.js";

/** Same-length blank, preserving line breaks — how non-code must be masked. */
const blank = (text: string): string => text.replace(/[^\r\n]/g, " ");

const codeSlices = (source: string): string[] =>
  tokenize(source).regions.map((region) => source.slice(region.start, region.end));

function expectCodeContains(source: string, needle: string): void {
  expect(maskNonCode(source)).toContain(needle);
}

function expectCodeOmits(source: string, needle: string): void {
  expect(maskNonCode(source)).not.toContain(needle);
}

describe("Tokenizer robustness — comments", () => {
  it("blanks a trailing line comment and keeps the code before it", () => {
    const source = "const a = 1; // process.env.X";
    expect(maskNonCode(source)).toBe("const a = 1; " + blank("// process.env.X"));
  });

  it("blanks a block comment that spans lines while preserving the line break", () => {
    const source = "const a = 1; /* x\n y */ const b = 2;";
    expect(maskNonCode(source)).toBe(
      "const a = 1; " + blank("/* x\n y */") + " const b = 2;",
    );
  });

  it("keeps code that follows a block comment on the same line", () => {
    const source = "/* a */ const b = 2;";
    expect(maskNonCode(source)).toBe(blank("/* a */") + " const b = 2;");
  });

  it("does not nest block comments: the first */ ends the comment", () => {
    const source = "/* a /* b */ c;";
    expect(maskNonCode(source)).toBe(blank("/* a /* b */") + " c;");
  });

  it("ends a line comment at end of file with no trailing newline", () => {
    const source = "const a = 1; // end";
    expect(maskNonCode(source)).toBe("const a = 1; " + blank("// end"));
  });

  it("records no warning for a line comment that ends at end of file", () => {
    expect(tokenize("const a = 1; // end").warnings).toEqual([]);
  });

  it("blanks a JSDoc block", () => {
    const source = "/**\n * @param x\n */\nconst a = 1;";
    expect(maskNonCode(source)).toBe(blank("/**\n * @param x\n */") + "\nconst a = 1;");
  });

  it("hides an env reference written inside a line comment", () => {
    expectCodeOmits("// process.env.SECRET_KEY\nconst a = 1;", "process.env.SECRET_KEY");
  });

  it("hides an env reference written inside a block comment", () => {
    expectCodeOmits("/* process.env.SECRET_KEY */\nconst a = 1;", "process.env.SECRET_KEY");
  });

  it("hides an env reference written inside a JSDoc comment", () => {
    expectCodeOmits("/** process.env.SECRET_KEY */\nconst a = 1;", "process.env.SECRET_KEY");
  });

  it("keeps code on the line after a line comment", () => {
    expectCodeContains("// comment\nconst KEY = process.env.API_KEY;", "process.env.API_KEY");
  });

  it("blanks two consecutive line comments independently", () => {
    const source = "// one\n// two\nconst a = 1;";
    expect(maskNonCode(source)).toBe(blank("// one") + "\n" + blank("// two") + "\nconst a = 1;");
  });

  it("treats a second // inside a line comment as ordinary comment text", () => {
    const source = "// a // b";
    expect(maskNonCode(source)).toBe(blank(source));
  });

  it("handles a file that is nothing but a comment", () => {
    expect(codeSlices("/* only a comment */")).toEqual([]);
  });

  it("handles an empty source without regions or warnings", () => {
    expect(tokenize("")).toEqual({ regions: [], warnings: [] });
  });

  it("keeps a division sign that follows a block comment", () => {
    expectCodeContains("const x = a /* c */ / b;", "/ b;");
  });
});

describe("Tokenizer robustness — string literals", () => {
  it("keeps the quotes as code and blanks the body of a double-quoted string", () => {
    expect(maskNonCode('const s = "hi";')).toBe('const s = "  ";');
  });

  it("keeps the quotes as code and blanks the body of a single-quoted string", () => {
    expect(maskNonCode("const s = 'hi';")).toBe("const s = '  ';");
  });

  it("does not start a comment for // written inside a string", () => {
    expectCodeContains("const s = '//'; const KEY = process.env.API_KEY;", "process.env.API_KEY");
  });

  it("does not start a comment inside a URL string", () => {
    expectCodeContains(
      'const u = "http://example.com"; const KEY = process.env.API_KEY;',
      "process.env.API_KEY",
    );
  });

  it("does not open a block comment for /* written inside a string", () => {
    expectCodeContains('const s = "/*"; const KEY = process.env.API_KEY;', "process.env.API_KEY");
  });

  it("does not close anything for */ written inside a string", () => {
    expectCodeContains('const s = "*/"; const KEY = process.env.API_KEY;', "process.env.API_KEY");
  });

  it("hides an env reference written inside a string literal", () => {
    expectCodeOmits("const msg = 'set process.env.FOO first';", "process.env.FOO");
  });

  it("hides an env reference written inside a double-quoted string", () => {
    expectCodeOmits('const msg = "process.env.FOO";', "process.env.FOO");
  });

  it("keeps scanning after an escaped double quote inside a double-quoted string", () => {
    const source = 'const s = "a\\"b"; const KEY = process.env.API_KEY;';
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("keeps scanning after an escaped single quote inside a single-quoted string", () => {
    const source = "const s = 'a\\'b'; const KEY = process.env.API_KEY;";
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("closes a string that ends with an escaped backslash", () => {
    const source = String.raw`const s = "a\\"; const KEY = process.env.API_KEY;`;
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("records no warning for a string that ends with an escaped backslash", () => {
    const source = String.raw`const s = "a\\";`;
    expect(tokenize(source).warnings).toEqual([]);
  });

  it("treats a 'use client' directive as a string", () => {
    const source = "'use client';\nconst KEY = process.env.API_KEY;";
    expect(maskNonCode(source)).toBe("'          ';\nconst KEY = process.env.API_KEY;");
  });

  it("blanks a backtick written inside a quoted string", () => {
    const source = 'const s = "`"; const KEY = process.env.API_KEY;';
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("blanks a ${} written inside a quoted string", () => {
    const source = 'const s = "${process.env.FOO}";';
    expectCodeOmits(source, "process.env.FOO");
  });

  it("keeps scanning after a string containing an escaped newline", () => {
    const source = String.raw`const s = "a\nb"; const KEY = process.env.API_KEY;`;
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("does not let a quote inside a line comment open a string", () => {
    const source = '// "\nconst KEY = process.env.API_KEY;';
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("does not let a quote inside a block comment open a string", () => {
    const source = '/* " */\nconst KEY = process.env.API_KEY;';
    expectCodeContains(source, "process.env.API_KEY");
  });
});

describe("Tokenizer robustness — template literals", () => {
  it("keeps the backticks and ${} delimiters as code and blanks the text", () => {
    expect(maskNonCode("`a${b}c`")).toBe("` ${b} `");
  });

  it("scans an expression inside an interpolation", () => {
    expectCodeContains("const u = `${process.env.API_KEY}/v1`;", "process.env.API_KEY");
  });

  it("hides an env reference written in template text", () => {
    expectCodeOmits("const s = `process.env.FOO`;", "process.env.FOO");
  });

  it("scans an expression inside a template nested three deep", () => {
    expectCodeContains("const s = `${`${`${process.env.API_KEY}`}`}`;", "process.env.API_KEY");
  });

  it("does not end a template at a backtick inside a string inside an interpolation", () => {
    const source = 'const s = `${"`"}`; const KEY = process.env.API_KEY;';
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("does not end an interpolation at the closing brace of an object literal", () => {
    const source = "const s = `${ {a: 1}.a }`; const KEY = process.env.API_KEY;";
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("scans an interpolation nested inside another interpolation", () => {
    expectCodeContains("const s = `${ f(`${process.env.API_KEY}`) }`;", "process.env.API_KEY");
  });

  it("keeps interpolations scannable in a template spanning lines", () => {
    const source = "const s = `line1\n${process.env.API_KEY}\nline3`;";
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("hides template text on the lines around an interpolation", () => {
    const source = "const s = `process.env.TEXT_ONE\n${process.env.REAL}\nprocess.env.TEXT_TWO`;";
    expectCodeOmits(source, "process.env.TEXT_ONE");
  });

  it("does not end a template at an escaped backtick", () => {
    const source = "const t = `a\\`b`; const KEY = process.env.API_KEY;";
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("scans an expression in a tagged template", () => {
    expectCodeContains("const q = sql`${process.env.API_KEY}`;", "process.env.API_KEY");
  });

  it("survives an empty interpolation without swallowing the rest of the file", () => {
    const source = "const s = `${}`; const KEY = process.env.API_KEY;";
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("blanks a comment written inside an interpolation", () => {
    const source = "const s = `${ /* process.env.FOO */ a }`;";
    expectCodeOmits(source, "process.env.FOO");
  });

  it("scans an interpolation that follows blanked template text", () => {
    expect(maskNonCode("`xx${a}`")).toBe("`  ${a}`");
  });
});

describe("Tokenizer robustness — regex vs division", () => {
  const DIVISION_CASES: Array<[string, string, string]> = [
    ["treats a / b / c as division", "const x = a / b / c;", "b"],
    [
      "treats the SPEC case foo / process.env.X / 2 as division",
      "const x = foo / process.env.API_KEY / 2;",
      "process.env.API_KEY",
    ],
    ["treats a slash after a closing paren as division", "const x = (a) / 2; const zz = ZZZ;", "ZZZ"],
    ["treats a slash after a closing bracket as division", "const x = arr[0] / 2; const zz = ZZZ;", "ZZZ"],
    ["treats a slash after an identifier as division", "const x = typeof y / 2; const zz = ZZZ;", "ZZZ"],
    ["treats a slash after a bigint literal as division", "const x = 10n / 2; const zz = ZZZ;", "ZZZ"],
    [
      "treats a slash after a number with separators as division",
      "const x = 1_000 / 2; const zz = ZZZ;",
      "ZZZ",
    ],
    ["treats a slash after a plain number as division", "const x = 4 / 2; const zz = ZZZ;", "ZZZ"],
    [
      "treats a slash after the closing paren of an if condition as division (documented limitation)",
      "if (flag) /ZZZ/.test(s);",
      "ZZZ",
    ],
  ];

  for (const [title, source, survives] of DIVISION_CASES) {
    it(title, () => {
      expectCodeContains(source, survives);
    });
  }

  const REGEX_CASES: Array<[string, string, string]> = [
    ["treats a slash after = as a regex literal", "x = /ZZZ/i;", "ZZZ"],
    ["treats a slash after return as a regex literal", "return /ZZZ/.test(s);", "ZZZ"],
    ["treats a slash after case as a regex literal", "switch (x) { case /ZZZ/.test(s): break; }", "ZZZ"],
    ["treats a slash after a comma as a regex literal", "f(a, /ZZZ/);", "ZZZ"],
    ["treats a slash after && as a regex literal", "const ok = a && /ZZZ/.test(s);", "ZZZ"],
    ["treats a slash after ? as a regex literal", "const r = cond ? /ZZZ/ : null;", "ZZZ"],
    ["treats a slash after : as a regex literal", "const r = cond ? null : /ZZZ/;", "ZZZ"],
    ["treats a slash at the start of a statement as a regex literal", "/ZZZ/.test(s);", "ZZZ"],
    ["treats a slash after an opening paren as a regex literal", "f((/ZZZ/).source);", "ZZZ"],
  ];

  for (const [title, source, hidden] of REGEX_CASES) {
    it(title, () => {
      expectCodeOmits(source, hidden);
    });
  }

  it("keeps the slashes and flags as code and blanks only the regex body", () => {
    expect(maskNonCode("const r = /ab+c/i;")).toBe("const r = /    /i;");
  });

  it("does not end a regex at a slash inside a character class", () => {
    const source = "const r = /[/]/; const KEY = process.env.API_KEY;";
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("does not end a regex at an escaped slash", () => {
    const source = String.raw`const r = /a\/ZZZ/; const KEY = process.env.API_KEY;`;
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("hides the body of a regex containing an escaped slash", () => {
    expectCodeOmits(String.raw`const r = /a\/ZZZ/;`, "ZZZ");
  });

  it("keeps every regex flag as code", () => {
    expect(maskNonCode("const r = /ab/gimsuy;")).toBe("const r = /  /gimsuy;");
  });

  it("hides an env reference written inside a regex literal", () => {
    expectCodeOmits(String.raw`const r = /process\.env\.FOO/;`, "env");
  });

  it("does not let a regex swallow the following line", () => {
    const source = "const r = /ab/;\nconst KEY = process.env.API_KEY;";
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("keeps a division expression fully visible across two slashes", () => {
    expect(maskNonCode("const x = a / b / c;")).toBe("const x = a / b / c;");
  });
});

describe("Must NOT produce a Reference (tokenizer level)", () => {
  const HIDDEN_CASES: Array<[string, string]> = [
    ["a line comment", "// process.env.HIDDEN"],
    ["a block comment", "/* process.env.HIDDEN */"],
    ["a JSDoc comment", "/**\n * process.env.HIDDEN\n */"],
    ["a single-quoted string", "const s = 'process.env.HIDDEN';"],
    ["a double-quoted string", 'const s = "process.env.HIDDEN";'],
    ["template literal text", "const s = `process.env.HIDDEN`;"],
    ["a regex literal", String.raw`const r = /process\.env\.HIDDEN/;`],
    ["a JSX comment", "const el = <div>{/* process.env.HIDDEN */}</div>;"],
    ["a multi-line block comment", "/*\nprocess.env.HIDDEN\n*/"],
    ["a string inside an interpolation", 'const s = `${"process.env.HIDDEN"}`;'],
  ];

  for (const [where, source] of HIDDEN_CASES) {
    it(`hides an env reference inside ${where}`, () => {
      expectCodeOmits(source, "process.env.HIDDEN");
    });
  }
});

describe("Tokenizer robustness — JSX and modern syntax", () => {
  it("does not start a regex at the slash of a JSX closing tag", () => {
    const source = "const el = <div>hi</div>;\nconst KEY = process.env.API_KEY;";
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("does not start a regex at the slash of a self-closing JSX tag", () => {
    const source = "const el = <br />;\nconst KEY = process.env.API_KEY;";
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("scans an env reference inside a JSX expression container", () => {
    expectCodeContains("const el = <p>{process.env.API_KEY}</p>;", "process.env.API_KEY");
  });

  it("scans an env reference in a JSX attribute value", () => {
    expectCodeContains('const el = <a href={process.env.API_KEY}>x</a>;', "process.env.API_KEY");
  });

  it("blanks an HTML comment opener written inside a JSX string attribute", () => {
    const source = 'const el = <p title="<!-- x -->">y</p>;\nconst KEY = process.env.API_KEY;';
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("keeps nested JSX scannable", () => {
    const source = "const el = <div><span>{process.env.API_KEY}</span></div>;";
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("blanks a hashbang on the first line", () => {
    const source = "#!/usr/bin/env node\nconst KEY = process.env.API_KEY;";
    expect(maskNonCode(source)).toBe(
      blank("#!/usr/bin/env node") + "\nconst KEY = process.env.API_KEY;",
    );
  });

  it("does not start a regex at the slashes of a hashbang path", () => {
    expectCodeContains("#!/usr/bin/env node\nconst KEY = process.env.API_KEY;", "process.env.API_KEY");
  });

  it("keeps a decorator as code", () => {
    expectCodeContains("@Injectable()\nclass S { k = process.env.API_KEY; }", "process.env.API_KEY");
  });

  it("keeps a private class field as code", () => {
    expectCodeContains("class S { #secret = process.env.API_KEY; }", "process.env.API_KEY");
  });

  it("keeps an optional chaining access as code", () => {
    expectCodeContains("const k = process.env?.API_KEY;", "process.env?.API_KEY");
  });

  it("keeps a TypeScript non-null assertion as code", () => {
    expectCodeContains("const k = process.env.API_KEY!;", "process.env.API_KEY!");
  });

  it("keeps a TypeScript as-cast as code", () => {
    expectCodeContains("const k = process.env.API_KEY as string;", "process.env.API_KEY as string");
  });

  it("keeps an import.meta.env access as code", () => {
    expectCodeContains("const k = import.meta.env.VITE_API_URL;", "import.meta.env.VITE_API_URL");
  });

  it("keeps a class field initialiser as code", () => {
    expectCodeContains("class S { key = process.env.API_KEY; }", "process.env.API_KEY");
  });
});

describe("Tokenizer robustness — encoding and line endings", () => {
  it("preserves a CRLF pair when masking a block comment", () => {
    const source = "const a = 1; /* x\r\n y */ const b = 2;";
    expect(maskNonCode(source)).toBe(
      "const a = 1; " + blank("/* x\r\n y */") + " const b = 2;",
    );
  });

  it("keeps CRLF-separated code scannable", () => {
    expectCodeContains("// c\r\nconst KEY = process.env.API_KEY;", "process.env.API_KEY");
  });

  it("produces a mask exactly as long as the source", () => {
    const source = "const s = 'abc'; // tail\nconst r = /xy/;";
    expect(maskNonCode(source)).toHaveLength(source.length);
  });

  it("keeps every offset stable so a key keeps its position", () => {
    const source = "/* pad */ const KEY = process.env.API_KEY;";
    expect(maskNonCode(source).indexOf("process.env.API_KEY")).toBe(
      source.indexOf("process.env.API_KEY"),
    );
  });

  it("keeps code separated by tabs scannable", () => {
    expectCodeContains("const\tKEY\t=\tprocess.env.API_KEY;", "process.env.API_KEY");
  });

  it("keeps code separated by a non-breaking space scannable", () => {
    expectCodeContains("const KEY = process.env.API_KEY;", "process.env.API_KEY");
  });

  it("keeps code separated by an ideographic space scannable", () => {
    expectCodeContains("const　KEY = process.env.API_KEY;", "process.env.API_KEY");
  });

  it("keeps a source that begins with a BOM scannable", () => {
    expectCodeContains("﻿const KEY = process.env.API_KEY;", "process.env.API_KEY");
  });

  it("reports one removed character for a source that begins with a BOM", () => {
    expect(stripBom("﻿const a = 1;")).toEqual({ text: "const a = 1;", removed: 1 });
  });

  it("reports nothing removed for a source without a BOM", () => {
    expect(stripBom("const a = 1;")).toEqual({ text: "const a = 1;", removed: 0 });
  });

  it("removes only the first BOM when two are present", () => {
    expect(stripBom("﻿﻿a")).toEqual({ text: "﻿a", removed: 1 });
  });
});

describe("Tokenizer robustness — warnings", () => {
  it("records an unterminated_string warning for a double-quoted string open at end of file", () => {
    const result = tokenize('const s = "abc');
    expect(result.warnings[0]?.code).toBe("unterminated_string");
  });

  it("records an unterminated_string warning for a single-quoted string open at end of file", () => {
    const result = tokenize("const s = 'abc");
    expect(result.warnings[0]?.code).toBe("unterminated_string");
  });

  it("records an unterminated_template warning for a template open at end of file", () => {
    const result = tokenize("const t = `abc");
    expect(result.warnings[0]?.code).toBe("unterminated_template");
  });

  it("records an unterminated_comment warning for a block comment open at end of file", () => {
    const result = tokenize("const a = 1; /* abc");
    expect(result.warnings[0]?.code).toBe("unterminated_comment");
  });

  it("records an unterminated_regex warning for a regex open at end of file", () => {
    const result = tokenize("const r = /abc");
    expect(result.warnings[0]?.code).toBe("unterminated_regex");
  });

  it("points the warning offset at the character that opened the construct", () => {
    const result = tokenize('const s = "abc');
    expect(result.warnings[0]?.offset).toBe(10);
  });

  it("reports the 1-based line and column of an unterminated string", () => {
    const result = tokenize('const s = "abc');
    expect({ line: result.warnings[0]?.line, col: result.warnings[0]?.col }).toEqual({
      line: 1,
      col: 11,
    });
  });

  it("reports the line of an unterminated block comment opened on the third line", () => {
    const result = tokenize("const a = 1;\nconst b = 2;\n/* abc");
    expect(result.warnings[0]?.line).toBe(3);
  });

  it("gives every warning a non-empty message", () => {
    const result = tokenize('const s = "abc');
    expect(result.warnings[0]?.message.length).toBeGreaterThan(0);
  });

  it("records exactly one warning for a single unterminated string", () => {
    expect(tokenize('const s = "abc').warnings).toHaveLength(1);
  });

  it("records no warnings for well-formed source", () => {
    expect(tokenize("const s = 'a'; /* b */ const r = /c/; // d").warnings).toEqual([]);
  });

  it("returns whatever code it found before an unterminated string", () => {
    expectCodeContains('const KEY = process.env.API_KEY; const s = "abc', "process.env.API_KEY");
  });

  it("ends an unterminated string at the line break and keeps the next line scannable", () => {
    const source = 'const s = "abc\nconst KEY = process.env.API_KEY;';
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("warns about a string that is not closed before the line break", () => {
    const result = tokenize('const s = "abc\nconst b = 2;');
    expect(result.warnings[0]?.code).toBe("unterminated_string");
  });

  it("ends an unterminated regex at the line break and keeps the next line scannable", () => {
    const source = "const r = /abc\nconst KEY = process.env.API_KEY;";
    expectCodeContains(source, "process.env.API_KEY");
  });

  it("warns about a regex that is not closed before the line break", () => {
    const result = tokenize("const r = /abc\nconst b = 2;");
    expect(result.warnings[0]?.code).toBe("unterminated_regex");
  });

  it("records an unterminated_template warning for a template whose interpolation never closes", () => {
    const result = tokenize("const t = `a${b");
    expect(result.warnings[0]?.code).toBe("unterminated_template");
  });
});

describe("Tokenizer robustness — regions", () => {
  it("returns one region covering a source that is all code", () => {
    const source = "const a = 1;";
    expect(tokenize(source).regions).toEqual([{ start: 0, end: source.length }]);
  });

  it("returns no regions for a source that is only a comment", () => {
    expect(tokenize("// nothing here").regions).toEqual([]);
  });

  it("splits code around a string body", () => {
    expect(codeSlices('const s = "hi";')).toEqual(['const s = "', '";']);
  });

  it("returns regions in ascending, non-overlapping order", () => {
    const regions = tokenize("a; // c\nb; /* d */ e;").regions;
    const ascending = regions.every(
      (region, index) => index === 0 || region.start >= (regions[index - 1]?.end ?? 0),
    );
    expect(ascending).toBe(true);
  });

  it("never returns an empty region", () => {
    const regions = tokenize("a; // c\nb; /* d */ e;").regions;
    expect(regions.every((region) => region.end > region.start)).toBe(true);
  });

  it("reports an offset inside a region as code", () => {
    const regions: CodeRegion[] = [{ start: 0, end: 5 }];
    expect(isCodeOffset(regions, 0)).toBe(true);
  });

  it("treats a region as half-open so its end offset is not code", () => {
    const regions: CodeRegion[] = [{ start: 0, end: 5 }];
    expect(isCodeOffset(regions, 5)).toBe(false);
  });

  it("reports an offset in the gap between two regions as not code", () => {
    const regions: CodeRegion[] = [
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ];
    expect(isCodeOffset(regions, 7)).toBe(false);
  });

  it("reports an offset inside the second of two regions as code", () => {
    const regions: CodeRegion[] = [
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ];
    expect(isCodeOffset(regions, 12)).toBe(true);
  });

  it("reports any offset as not code when there are no regions", () => {
    expect(isCodeOffset([], 0)).toBe(false);
  });

  it("reports a negative offset as not code", () => {
    expect(isCodeOffset([{ start: 0, end: 5 }], -1)).toBe(false);
  });
});

describe("Tokenizer robustness — positions", () => {
  it("reports the first character as line 1 column 1", () => {
    expect(offsetToPosition("const a = 1;", 0)).toEqual({ line: 1, col: 1 });
  });

  it("reports a column on the first line as 1-based", () => {
    expect(offsetToPosition("const a = 1;", 6)).toEqual({ line: 1, col: 7 });
  });

  it("reports the first character of the second line after a newline", () => {
    expect(offsetToPosition("a\nb", 2)).toEqual({ line: 2, col: 1 });
  });

  it("counts a CRLF pair as a single line break", () => {
    expect(offsetToPosition("a\r\nb", 3)).toEqual({ line: 2, col: 1 });
  });

  it("reports a position on the third line of a CRLF source", () => {
    expect(offsetToPosition("a\r\nb\r\nc", 6)).toEqual({ line: 3, col: 1 });
  });

  it("does not count a leading BOM as a column", () => {
    expect(offsetToPosition("﻿const a = 1;", 1)).toEqual({ line: 1, col: 1 });
  });

  it("keeps columns 1-based after a leading BOM", () => {
    expect(offsetToPosition("﻿const a = 1;", 2)).toEqual({ line: 1, col: 2 });
  });

  it("reports a position that follows a multi-line block comment", () => {
    const source = "/*\n *\n */\nconst KEY = process.env.API_KEY;";
    expect(offsetToPosition(source, source.indexOf("process.env")).line).toBe(4);
  });

  it("reports the column of a key that follows a multi-line block comment", () => {
    const source = "/*\n *\n */\nconst KEY = process.env.API_KEY;";
    expect(offsetToPosition(source, source.indexOf("process.env")).col).toBe(13);
  });

  it("reports a position inside a template interpolation on a later line", () => {
    const source = "const s = `a\nb${process.env.API_KEY}`;";
    expect(offsetToPosition(source, source.indexOf("process.env")).line).toBe(2);
  });
});

describe("Tokenizer robustness — performance", () => {
  it.skipIf(process.env.FAST === "1")(
    "tokenizes a 5MB single-line minified source in under a second",
    () => {
      const source = "var a=1;".repeat(655_360);
      const started = Date.now();
      const result = tokenize(source);
      const elapsed = Date.now() - started;
      expect(result.warnings).toEqual([]);
      expect(elapsed).toBeLessThan(1000);
    },
  );

  it.skipIf(process.env.FAST === "1")(
    "reports line 1 for the last character of a 5MB single-line source",
    () => {
      const source = "var a=1;".repeat(655_360);
      expect(offsetToPosition(source, source.length - 1).line).toBe(1);
    },
  );
});

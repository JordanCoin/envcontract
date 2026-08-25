/**
 * SPEC: docs/SPEC.md — Module A `scanner`, "`.env.example` parsing".
 *
 * I1: a real `.env` (no `.example`/`.sample`/`.template` suffix) is NEVER read.
 * `isEnvExampleFile` is the single gate that decides what may be opened.
 */

import type { ScanWarning, SourceFile } from "./scanner.js";

export type DeclaredEntry = {
  /** True when the declaration is commented out (`# KEY=`) — declared-optional. */
  optional: boolean;
  file: string;
  /** 1-based. */
  line: number;
};

export type DeclaredMap = Map<string, DeclaredEntry>;

export type ParseEnvExampleResult = {
  declared: DeclaredMap;
  warnings: ScanWarning[];
};

/** Vercel's key grammar; case is preserved (`port` is a legal key). */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `export KEY=…`, the shell-sourceable form of a declaration. */
const EXPORT_PREFIX = /^export\s+/;

/** `#`, `##`, `#   ` — the comment marker plus the whitespace after it. */
const COMMENT_PREFIX = /^#+[ \t]*/;

const QUOTE_CHARACTERS = new Set(['"', "'", "`"]);

/** CRLF, LF and lone CR all end a line. */
const LINE_BREAK = /\r\n|\n|\r/;

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * True when `text` contains the closing `quote`. A backslash escapes the next
 * character, so `"a\"b"` does not close early.
 */
function closesQuote(text: string, quote: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === quote) return true;
  }
  return false;
}

/** Parses one `.env.example`-shaped file. Never throws on malformed lines. */
export function parseEnvExample(content: string, file: string): ParseEnvExampleResult {
  const declared: DeclaredMap = new Map();
  const warnings: ScanWarning[] = [];

  const declare = (key: string, optional: boolean, line: number): void => {
    if (declared.has(key)) {
      warnings.push({
        file,
        line,
        code: "duplicate_declaration",
        message: `\`${key}\` is declared more than once; the last declaration wins.`,
      });
    }
    declared.set(key, { optional, file, line });
  };

  // I1: the message names the line, never its contents.
  const warnInvalid = (line: number): void => {
    warnings.push({
      file,
      line,
      code: "invalid_env_line",
      message: `Line ${line} is not a valid declaration and was ignored.`,
    });
  };

  const lines = stripBom(content).split(LINE_BREAK);

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    const lineNumber = index + 1;

    if (trimmed === "") continue;

    if (trimmed.startsWith("#")) {
      // `# KEY=` is a declared-optional key; anything else is prose.
      const body = trimmed.replace(COMMENT_PREFIX, "").replace(EXPORT_PREFIX, "");
      const equals = body.indexOf("=");
      if (equals <= 0) continue;
      const key = body.slice(0, equals).trim();
      if (!KEY_PATTERN.test(key)) continue;
      declare(key, true, lineNumber);
      continue;
    }

    const body = trimmed.replace(EXPORT_PREFIX, "");
    const equals = body.indexOf("=");

    if (equals < 0) {
      // `KEY` with no `=` is still a declaration.
      if (KEY_PATTERN.test(body)) declare(body, false, lineNumber);
      else warnInvalid(lineNumber);
      continue;
    }

    const key = body.slice(0, equals).trim();
    if (!KEY_PATTERN.test(key)) {
      warnInvalid(lineNumber);
      continue;
    }

    declare(key, false, lineNumber);

    // Only the shape of the value matters: a quoted value may span lines, and
    // the lines it swallows must not be parsed as declarations of their own.
    const value = body.slice(equals + 1).trimStart();
    const quote = value.charAt(0);
    if (!QUOTE_CHARACTERS.has(quote)) continue;
    if (closesQuote(value.slice(1), quote)) continue;

    index += 1;
    while (index < lines.length && !closesQuote(lines[index] ?? "", quote)) {
      index += 1;
    }
  }

  return { declared: sortByKey(declared), warnings };
}

/** Parses many; later files win on a duplicate key and record a warning. */
export function parseEnvExamples(files: readonly SourceFile[]): ParseEnvExampleResult {
  const declared: DeclaredMap = new Map();
  const warnings: ScanWarning[] = [];

  for (const file of files) {
    const result = parseEnvExample(file.content, file.path);
    warnings.push(...result.warnings);
    for (const [key, entry] of result.declared) {
      if (declared.has(key)) {
        warnings.push({
          file: entry.file,
          line: entry.line,
          code: "duplicate_declaration",
          message: `\`${key}\` is declared in more than one example file; ${entry.file} wins.`,
        });
      }
      declared.set(key, entry);
    }
  }

  return { declared: sortByKey(declared), warnings };
}

/** I3: the declared map is always ordered by key ascending. */
function sortByKey(map: DeclaredMap): DeclaredMap {
  const sorted: DeclaredMap = new Map();
  for (const key of [...map.keys()].sort()) {
    const entry = map.get(key);
    if (entry) sorted.set(key, entry);
  }
  return sorted;
}

/**
 * True only for `.env.example`, `.env.sample`, `.env.template` and
 * `.env.<anything>.example`. False for `.env`, `.env.local`, `.env.production`.
 */
export function isEnvExampleFile(path: string): boolean {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const basename = separator === -1 ? path : path.slice(separator + 1);
  return /^\.env(\..+)?\.(example|sample|template)$/.test(basename);
}

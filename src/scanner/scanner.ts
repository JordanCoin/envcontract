/**
 * SPEC: docs/SPEC.md — Module A `scanner` ("Recognized syntaxes", "Optional
 * detection", "Must NOT produce a Reference").
 */

import { isIdentChar, readIdent, readIdentBack, skipWs, skipWsBack } from "./_scan-chars.js";
import { isBuiltinIgnored, matchesAnyIgnorePattern } from "./ignore.js";
import { maskNonCode, tokenize } from "./tokenizer.js";

export type RefKind = "process.env" | "import.meta.env";

export type Reference = {
  key: string;
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based, column of the first character of the KEY. */
  col: number;
  kind: RefKind;
  optional: boolean;
};

/** `process.env[expr]` where `expr` is not a static string — unresolvable. */
export type DynamicAccess = {
  file: string;
  line: number;
  /** The reference kind the dynamic access was made through. */
  kind: string;
};

export type ScanWarningCode =
  | "unterminated_string"
  | "unterminated_template"
  | "unterminated_comment"
  | "unterminated_regex"
  | "invalid_key"
  | "file_too_large"
  | "binary_file"
  | "unreadable_file"
  | "gitignore_unsupported_pattern"
  | "duplicate_declaration"
  | "invalid_env_line";

export type ScanWarning = {
  file: string;
  /** 1-based; 1 when the warning is about the file as a whole. */
  line: number;
  code: ScanWarningCode;
  message: string;
};

export type KeyInfo = {
  /** True when ANY site for this key is non-optional. */
  required: boolean;
  sites: Reference[];
};

export type ScanResult = {
  /** Every site, sorted by file, then line, then col. */
  references: Reference[];
  /** Insertion order is key ascending. */
  keys: Map<string, KeyInfo>;
  dynamicAccess: DynamicAccess[];
  /** Built-in keys dropped from `references`/`keys`, sorted, de-duplicated. */
  ignoredBuiltins: string[];
  warnings: ScanWarning[];
  filesScanned: number;
};

export type SourceFile = { path: string; content: string };

export type ScanOptions = {
  /** User ignore patterns (exact keys or `PREFIX_*`). */
  ignore?: readonly string[];
};

const IGNORE_FILE_MARKER = "envcontract-ignore-file";
const IGNORE_LINE_MARKER = "envcontract-ignore";
const OPTIONAL_LINE_MARKER = "envcontract-optional";

const CH_BANG = 33;
const CH_DQUOTE = 34;
const CH_AMP = 38;
const CH_SQUOTE = 39;
const CH_LPAREN = 40;
const CH_RPAREN = 41;
const CH_COMMA = 44;
const CH_PLUS = 43;
const CH_MINUS = 45;
const CH_DOT = 46;
const CH_COLON = 58;
const CH_LT = 60;
const CH_EQ = 61;
const CH_GT = 62;
const CH_QUESTION = 63;
const CH_LBRACKET = 91;
const CH_BACKSLASH = 92;
const CH_RBRACKET = 93;
const CH_BACKTICK = 96;
const CH_LBRACE = 123;
const CH_PIPE = 124;
const CH_RBRACE = 125;
const CH_LF = 10;
const CH_CR = 13;

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `[A-Za-z_][A-Za-z0-9_]*` — Vercel's key grammar. Case is preserved. */
export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** An empty result, used as the identity when merging. */
export function emptyScanResult(): ScanResult {
  return {
    references: [],
    keys: new Map<string, KeyInfo>(),
    dynamicAccess: [],
    ignoredBuiltins: [],
    warnings: [],
    filesScanned: 0,
  };
}

/** Pure: no I/O. Scans already-read files. */
export function scanFiles(files: readonly SourceFile[], opts?: ScanOptions): ScanResult {
  return mergeScanResults(files.map((file) => scanSource(file, opts)));
}

/** Merges per-file results, preserving the documented sort orders. */
export function mergeScanResults(results: readonly ScanResult[]): ScanResult {
  const merged = emptyScanResult();
  const builtins = new Set<string>();

  for (const result of results) {
    // Element-wise, never `push(...array)`: a minified file can hold more
    // references than the argument limit of a spread call.
    for (const reference of result.references) merged.references.push(reference);
    for (const access of result.dynamicAccess) merged.dynamicAccess.push(access);
    for (const warning of result.warnings) merged.warnings.push(warning);
    merged.filesScanned += result.filesScanned;
    for (const key of result.ignoredBuiltins) builtins.add(key);
  }

  merged.references.sort(compareReferences);
  merged.dynamicAccess.sort(
    (a, b) => compareStrings(a.file, b.file) || a.line - b.line || compareStrings(a.kind, b.kind),
  );
  merged.warnings.sort((a, b) => compareStrings(a.file, b.file) || a.line - b.line);
  merged.ignoredBuiltins = [...builtins].sort(compareStrings);
  merged.keys = buildKeys(merged.references);
  return merged;
}

function compareReferences(a: Reference, b: Reference): number {
  return compareStrings(a.file, b.file) || a.line - b.line || a.col - b.col;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function buildKeys(references: readonly Reference[]): Map<string, KeyInfo> {
  const byKey = new Map<string, Reference[]>();
  for (const reference of references) {
    const sites = byKey.get(reference.key);
    if (sites) sites.push(reference);
    else byKey.set(reference.key, [reference]);
  }
  const keys = new Map<string, KeyInfo>();
  for (const key of [...byKey.keys()].sort(compareStrings)) {
    const sites = byKey.get(key) ?? [];
    keys.set(key, { required: sites.some((site) => !site.optional), sites });
  }
  return keys;
}

/* ------------------------------------------------------------ single file */

/** A `process.env` / `import.meta.env` / alias occurrence found in code. */
type Anchor = {
  kind: RefKind;
  /** Offset of the first character of the whole reference expression. */
  start: number;
  /** Offset just past the `env` (or alias) token. */
  end: number;
};

/** A reference before ignore filtering. */
type RawRef = { key: string; keyOffset: number; kind: RefKind; optional: boolean };

/** Scans one file. `scanFiles` merges the per-file results. */
export function scanSource(file: SourceFile, opts?: ScanOptions): ScanResult {
  const result = emptyScanResult();
  result.filesScanned = 1;

  const source = file.content;
  if (source.includes(IGNORE_FILE_MARKER)) return result;

  const { regions, warnings: tokenizerWarnings } = tokenize(source);
  const masked = maskNonCode(source, regions);
  const length = source.length;

  const lineStarts: number[] = [0];
  for (let i = 0; i < length; i += 1) {
    if (source.charCodeAt(i) === CH_LF) lineStarts.push(i + 1);
  }
  const hasBom = source.charCodeAt(0) === 0xfeff;

  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const colOf = (offset: number, line: number): number => {
    const col = offset - (lineStarts[line - 1] ?? 0) + 1 - (line === 1 && hasBom ? 1 : 0);
    return col < 1 ? 1 : col;
  };

  for (const warning of tokenizerWarnings) {
    result.warnings.push({
      file: file.path,
      line: warning.line,
      code: warning.code,
      message: warning.message,
    });
  }

  const ignoredLines = new Set<number>();
  for (let at = source.indexOf(IGNORE_LINE_MARKER); at !== -1; ) {
    ignoredLines.add(lineOf(at));
    at = source.indexOf(IGNORE_LINE_MARKER, at + 1);
  }
  const optionalLines = new Set<number>();
  for (let at = source.indexOf(OPTIONAL_LINE_MARKER); at !== -1; ) {
    const line = lineOf(at);
    optionalLines.add(line);
    optionalLines.add(line + 1);
    at = source.indexOf(OPTIONAL_LINE_MARKER, at + 1);
  }

  /* ------------------------------------------------------------- anchors */

  const anchors: Anchor[] = [];
  const bareProcess: number[] = [];

  for (let at = masked.indexOf("process"); at !== -1; at = masked.indexOf("process", at + 7)) {
    if (at > 0 && isIdentChar(masked.charCodeAt(at - 1))) continue;
    let cursor = skipWs(masked, at + 7);
    if (masked.charCodeAt(cursor) === CH_QUESTION && masked.charCodeAt(cursor + 1) === CH_DOT) {
      cursor = skipWs(masked, cursor + 2);
    } else if (masked.charCodeAt(cursor) === CH_DOT) {
      cursor = skipWs(masked, cursor + 1);
    } else {
      bareProcess.push(at);
      continue;
    }
    if (!isWordAt(masked, cursor, "env")) continue;
    anchors.push({ kind: "process.env", start: at, end: cursor + 3 });
  }

  for (let at = masked.indexOf("import"); at !== -1; at = masked.indexOf("import", at + 6)) {
    if (at > 0 && isIdentChar(masked.charCodeAt(at - 1))) continue;
    let cursor = skipWs(masked, at + 6);
    if (masked.charCodeAt(cursor) !== CH_DOT) continue;
    cursor = skipWs(masked, cursor + 1);
    if (!isWordAt(masked, cursor, "meta")) continue;
    cursor = skipWs(masked, cursor + 4);
    if (masked.charCodeAt(cursor) !== CH_DOT) continue;
    cursor = skipWs(masked, cursor + 1);
    if (!isWordAt(masked, cursor, "env")) continue;
    anchors.push({ kind: "import.meta.env", start: at, end: cursor + 3 });
  }

  /* ------------------------------------------------------------- aliases */

  const aliases = new Map<string, number>();
  const declarators = new Set(["const", "let", "var"]);

  const declaredNameBefore = (equalsAt: number): string | undefined => {
    const nameEnd = skipWsBack(masked, equalsAt - 1);
    const name = readIdentBack(masked, nameEnd);
    if (name === "") return undefined;
    const keywordEnd = skipWsBack(masked, nameEnd - name.length);
    if (!declarators.has(readIdentBack(masked, keywordEnd))) return undefined;
    return name;
  };

  for (const anchor of anchors) {
    if (anchor.kind !== "process.env") continue;
    const equalsAt = assignmentBefore(masked, anchor.start);
    if (equalsAt === -1) continue;
    const name = declaredNameBefore(equalsAt);
    if (name === undefined || aliases.has(name)) continue;
    aliases.set(name, anchor.end);
  }

  for (const at of bareProcess) {
    const equalsAt = assignmentBefore(masked, at);
    if (equalsAt === -1) continue;
    const closeAt = skipWsBack(masked, equalsAt - 1);
    if (masked.charCodeAt(closeAt) !== CH_RBRACE) continue;
    const openAt = matchingBraceBack(masked, closeAt);
    if (openAt === -1) continue;
    if (declaredNameBefore(openAt + 1) === undefined && !isDeclaratorBefore(masked, openAt)) continue;
    for (const entry of destructuringEntries(masked, openAt + 1, closeAt)) {
      if (entry.key !== "env") continue;
      const local = entry.local ?? "env";
      if (!aliases.has(local)) aliases.set(local, at + 7);
    }
  }

  for (const [name, from] of aliases) {
    for (let at = masked.indexOf(name); at !== -1; at = masked.indexOf(name, at + name.length)) {
      if (at < from) continue;
      const before = masked.charCodeAt(at - 1);
      if (at > 0 && (isIdentChar(before) || before === CH_DOT)) continue;
      if (isIdentChar(masked.charCodeAt(at + name.length))) continue;
      const next = skipWs(masked, at + name.length);
      const nextCode = masked.charCodeAt(next);
      if (nextCode !== CH_DOT && nextCode !== CH_LBRACKET && nextCode !== CH_QUESTION) continue;
      anchors.push({ kind: "process.env", start: at, end: at + name.length });
    }
  }

  anchors.sort((a, b) => a.end - b.end);

  /* -------------------------------------------------------------- refs */

  const raw: RawRef[] = [];
  const invalidKeys: number[] = [];

  const addKey = (key: string, keyOffset: number, kind: RefKind, optional: boolean): void => {
    if (!isValidKey(key)) {
      invalidKeys.push(keyOffset);
      return;
    }
    raw.push({ key, keyOffset, kind, optional });
  };

  for (const anchor of anchors) {
    let cursor = skipWs(masked, anchor.end);
    let code = masked.charCodeAt(cursor);
    if (code === CH_QUESTION && masked.charCodeAt(cursor + 1) === CH_DOT) {
      cursor = skipWs(masked, cursor + 2);
      code = masked.charCodeAt(cursor);
    } else if (code === CH_DOT) {
      cursor = skipWs(masked, cursor + 1);
      code = masked.charCodeAt(cursor);
      if (code === CH_LBRACKET) code = 0;
    }

    if (code === CH_LBRACKET) {
      const bracket = readBracketKey(source, masked, cursor);
      if (bracket === undefined) {
        result.dynamicAccess.push({
          file: file.path,
          line: lineOf(cursor),
          kind: anchor.kind,
        });
        continue;
      }
      addKey(
        bracket.key,
        bracket.keyOffset,
        anchor.kind,
        isOptionalSite(masked, source, anchor.start, bracket.end),
      );
      continue;
    }

    if (cursor > anchor.end) {
      // A member access: `…env.KEY`, `…env?.KEY`.
      const key = readIdent(source, cursor);
      if (key === "") continue;
      addKey(
        key,
        cursor,
        anchor.kind,
        isOptionalSite(masked, source, anchor.start, cursor + key.length),
      );
      continue;
    }

    // Nothing follows the `env` token: destructuring, or the `in` probe.
    const destructured = destructuringBefore(masked, anchor.start);
    if (destructured !== undefined) {
      for (const entry of destructuringEntries(masked, destructured.open + 1, destructured.close)) {
        addKey(entry.key, entry.offset, anchor.kind, entry.optional);
      }
      continue;
    }
    const probe = inProbeBefore(masked, source, anchor.start);
    if (probe !== undefined) addKey(probe.key, probe.keyOffset, anchor.kind, true);
  }

  for (const offset of invalidKeys) {
    const line = lineOf(offset);
    if (ignoredLines.has(line)) continue;
    result.warnings.push({
      file: file.path,
      line,
      code: "invalid_key",
      message: "key is not a valid environment variable name",
    });
  }

  /* ------------------------------------------------------------ filtering */

  const userIgnore = opts?.ignore ?? [];
  const builtins = new Set<string>();

  for (const item of raw) {
    const line = lineOf(item.keyOffset);
    if (ignoredLines.has(line)) continue;
    if (matchesAnyIgnorePattern(item.key, userIgnore)) continue;
    if (isBuiltinIgnored(item.key, item.kind)) {
      builtins.add(item.key);
      continue;
    }
    result.references.push({
      key: item.key,
      file: file.path,
      line,
      col: colOf(item.keyOffset, line),
      kind: item.kind,
      optional: item.optional || optionalLines.has(line),
    });
  }

  result.references.sort(compareReferences);
  result.ignoredBuiltins = [...builtins].sort(compareStrings);
  result.keys = buildKeys(result.references);
  return result;
}

/* ------------------------------------------------------------- utilities */

function isWordAt(text: string, at: number, word: string): boolean {
  if (!text.startsWith(word, at)) return false;
  return !isIdentChar(text.charCodeAt(at + word.length));
}

/** Offset of a plain `=` immediately before `start`, or -1. */
function assignmentBefore(masked: string, start: number): number {
  const at = skipWsBack(masked, start - 1);
  if (at < 0 || masked.charCodeAt(at) !== CH_EQ) return -1;
  const before = masked.charCodeAt(at - 1);
  if (before === CH_EQ || before === CH_BANG || before === CH_LT || before === CH_GT) return -1;
  if (masked.charCodeAt(at + 1) === CH_GT) return -1;
  return at;
}

function isDeclaratorBefore(masked: string, openBrace: number): boolean {
  const at = skipWsBack(masked, openBrace - 1);
  const word = readIdentBack(masked, at);
  return word === "const" || word === "let" || word === "var";
}

/** Offset of the `{` matching the `}` at `closeAt`, or -1. */
function matchingBraceBack(masked: string, closeAt: number): number {
  let depth = 0;
  for (let i = closeAt; i >= 0; i -= 1) {
    const code = masked.charCodeAt(i);
    if (code === CH_RBRACE) depth += 1;
    else if (code === CH_LBRACE) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `const { A, B } = <here>` — the brace pair assigned to, if any. */
function destructuringBefore(
  masked: string,
  start: number,
): { open: number; close: number } | undefined {
  const equalsAt = assignmentBefore(masked, start);
  if (equalsAt === -1) return undefined;
  const closeAt = skipWsBack(masked, equalsAt - 1);
  if (closeAt < 0 || masked.charCodeAt(closeAt) !== CH_RBRACE) return undefined;
  const openAt = matchingBraceBack(masked, closeAt);
  if (openAt === -1) return undefined;
  return { open: openAt, close: closeAt };
}

type DestructuringEntry = {
  key: string;
  /** Offset of the first character of the source key. */
  offset: number;
  /** The local name when the binding is renamed. */
  local?: string;
  optional: boolean;
};

/** Splits `{ A, B: local, C = "x", ...rest }` into its named bindings. */
function destructuringEntries(
  masked: string,
  from: number,
  to: number,
): DestructuringEntry[] {
  const entries: DestructuringEntry[] = [];
  let depth = 0;
  let start = from;

  const flush = (end: number): void => {
    const entry = parseDestructuringEntry(masked, start, end);
    if (entry !== undefined) entries.push(entry);
  };

  for (let i = from; i < to; i += 1) {
    const code = masked.charCodeAt(i);
    if (code === CH_LBRACE || code === CH_LBRACKET || code === CH_LPAREN) depth += 1;
    else if (code === CH_RBRACE || code === CH_RBRACKET || code === CH_RPAREN) depth -= 1;
    else if (code === CH_COMMA && depth === 0) {
      flush(i);
      start = i + 1;
    }
  }
  flush(to);
  return entries;
}

function parseDestructuringEntry(
  masked: string,
  from: number,
  to: number,
): DestructuringEntry | undefined {
  const start = skipWs(masked, from);
  if (start >= to) return undefined;
  if (masked.charCodeAt(start) === CH_DOT) return undefined;
  const key = readIdent(masked, start);
  if (key === "") return undefined;

  let local: string | undefined;
  let optional = false;
  let depth = 0;
  for (let i = start + key.length; i < to; i += 1) {
    const code = masked.charCodeAt(i);
    if (code === CH_LBRACE || code === CH_LBRACKET || code === CH_LPAREN) depth += 1;
    else if (code === CH_RBRACE || code === CH_RBRACKET || code === CH_RPAREN) depth -= 1;
    else if (depth === 0 && code === CH_COLON) {
      local = readIdent(masked, skipWs(masked, i + 1));
    } else if (
      depth === 0 &&
      code === CH_EQ &&
      masked.charCodeAt(i + 1) !== CH_EQ &&
      masked.charCodeAt(i - 1) !== CH_EQ
    ) {
      optional = true;
    }
  }
  return local === undefined || local === ""
    ? { key, offset: start, optional }
    : { key, offset: start, local, optional };
}

/** `"KEY" in process.env` — the probed key, when the site has that shape. */
function inProbeBefore(
  masked: string,
  source: string,
  start: number,
): { key: string; keyOffset: number } | undefined {
  const wordEnd = skipWsBack(masked, start - 1);
  if (readIdentBack(masked, wordEnd) !== "in") return undefined;
  const quoteEnd = skipWsBack(masked, wordEnd - 2);
  const quote = source.charCodeAt(quoteEnd);
  if (quote !== CH_DQUOTE && quote !== CH_SQUOTE && quote !== CH_BACKTICK) return undefined;
  let open = quoteEnd - 1;
  while (open >= 0 && source.charCodeAt(open) !== quote) open -= 1;
  if (open < 0) return undefined;
  return { key: source.slice(open + 1, quoteEnd), keyOffset: open + 1 };
}

/**
 * `env["KEY"]` — the static key, or `undefined` when the subscript is dynamic.
 * `at` is the offset of the `[`.
 */
function readBracketKey(
  source: string,
  masked: string,
  at: number,
): { key: string; keyOffset: number; end: number } | undefined {
  const open = skipWs(masked, at + 1);
  const quote = source.charCodeAt(open);
  if (quote !== CH_DQUOTE && quote !== CH_SQUOTE && quote !== CH_BACKTICK) return undefined;

  let i = open + 1;
  while (i < source.length) {
    const code = source.charCodeAt(i);
    if (code === CH_BACKSLASH) {
      i += 2;
      continue;
    }
    if (code === CH_LF || code === CH_CR) return undefined;
    if (code === quote) break;
    i += 1;
  }
  if (i >= source.length) return undefined;

  const key = source.slice(open + 1, i);
  if (quote === CH_BACKTICK && key.includes("${")) return undefined;

  const close = skipWs(masked, i + 1);
  if (masked.charCodeAt(close) !== CH_RBRACKET) return undefined;
  return { key, keyOffset: open + 1, end: close + 1 };
}

/* --------------------------------------------------------- optionality */

/** SPEC "Optional detection": looks at the tokens around the reference site. */
function isOptionalSite(masked: string, source: string, exprStart: number, end: number): boolean {
  const beforeEnd = skipWsBack(masked, exprStart - 1);
  if (readIdentBack(masked, beforeEnd) === "typeof") return true;

  let cursor = skipWs(masked, end);
  while (masked.charCodeAt(cursor) === CH_BANG && masked.charCodeAt(cursor + 1) !== CH_EQ) {
    cursor = skipWs(masked, cursor + 1);
  }

  const code = masked.charCodeAt(cursor);
  const next = masked.charCodeAt(cursor + 1);

  if (code === CH_QUESTION && next === CH_QUESTION) {
    return isOptionalFallback(source, skipWs(masked, cursor + 2));
  }
  if (code === CH_PIPE && next === CH_PIPE) {
    return isOptionalFallback(source, skipWs(masked, cursor + 2));
  }
  if (code === CH_AMP && next === CH_AMP) return true;
  if (code === CH_QUESTION && next !== CH_DOT && next !== CH_QUESTION) return true;
  if ((code === CH_EQ || code === CH_BANG) && next === CH_EQ) {
    let after = cursor + 2;
    if (masked.charCodeAt(after) === CH_EQ) after += 1;
    // Comparing against a literal is a presence test: the code has a branch for
    // the variable being absent. Comparing against another expression is not.
    return isLiteralComparand(source, skipWs(source, after));
  }
  if (code === CH_RPAREN && isSoleIfCondition(masked, exprStart)) return true;

  // `!x`, `!!x` and `Boolean(x)` coerce the value to a yes/no and never read it,
  // so the code already copes with the variable being absent. A member access on
  // the site (`!x.length`) does read it, and stays required.
  if (code !== CH_DOT && code !== CH_LBRACKET) {
    if (masked.charCodeAt(beforeEnd) === CH_BANG) return true;
    if (isBooleanCall(masked, beforeEnd)) return true;
  }
  return false;
}

/** The words that are literals rather than references to something else. */
const LITERAL_WORDS = new Set(["undefined", "null", "true", "false", "NaN", "Infinity"]);

/**
 * True when the token at `at` is a literal: a quoted string, a number, or one of
 * the literal keywords. Read from the raw source, because `masked` blanks out
 * the contents — and the quotes — of every string.
 */
function isLiteralComparand(source: string, at: number): boolean {
  const code = source.charCodeAt(at);
  if (code === CH_DQUOTE || code === CH_SQUOTE || code === CH_BACKTICK) return true;
  if (isDigit(code)) return true;
  if ((code === CH_MINUS || code === CH_PLUS || code === CH_DOT) && isDigit(source.charCodeAt(at + 1))) {
    return true;
  }
  return LITERAL_WORDS.has(readIdent(source, at));
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** True when the character at `beforeEnd` opens a `Boolean(` call. */
function isBooleanCall(masked: string, beforeEnd: number): boolean {
  if (masked.charCodeAt(beforeEnd) !== CH_LPAREN) return false;
  return readIdentBack(masked, skipWsBack(masked, beforeEnd - 1)) === "Boolean";
}

/**
 * The right-hand side of `??` / `||`. A bare `throw` expression or `undefined`
 * keeps the site required; anything else is a real fallback.
 */
function isOptionalFallback(source: string, at: number): boolean {
  const word = readIdent(source, at);
  if (word === "throw" || word === "undefined") return false;
  return true;
}

/** True when the site is the whole condition of an `if (...)`. */
function isSoleIfCondition(masked: string, exprStart: number): boolean {
  const parenAt = skipWsBack(masked, exprStart - 1);
  if (parenAt < 0 || masked.charCodeAt(parenAt) !== CH_LPAREN) return false;
  return readIdentBack(masked, skipWsBack(masked, parenAt - 1)) === "if";
}

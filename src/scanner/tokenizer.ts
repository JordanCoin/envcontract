/**
 * SPEC: docs/SPEC.md — Module A `scanner`, "Tokenizer robustness".
 *
 * A single-pass state machine over JS/TS/JSX source that classifies every byte
 * as either CODE (scannable for references) or NON-CODE (line comment, block
 * comment, string literal body, template literal text, regex literal body).
 *
 * Template literal `${ ... }` expression interiors are CODE, recursively, at any
 * nesting depth.
 */

/** A half-open `[start, end)` span of the source that is scannable code. */
export type CodeRegion = { start: number; end: number };

export type TokenizerWarningCode =
  | "unterminated_string"
  | "unterminated_template"
  | "unterminated_comment"
  | "unterminated_regex";

export type TokenizerWarning = {
  code: TokenizerWarningCode;
  /** Byte offset where the unterminated construct started. */
  offset: number;
  /** 1-based line of `offset`. */
  line: number;
  /** 1-based column of `offset`. */
  col: number;
  message: string;
};

export type TokenizeResult = {
  /** Sorted, non-overlapping, maximal code spans. */
  regions: CodeRegion[];
  warnings: TokenizerWarning[];
};

const CH_TAB = 9;
const CH_LF = 10;
const CH_VT = 11;
const CH_FF = 12;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_BANG = 33;
const CH_DQUOTE = 34;
const CH_HASH = 35;
const CH_DOLLAR = 36;
const CH_SQUOTE = 39;
const CH_STAR = 42;
const CH_SLASH = 47;
const CH_LT = 60;
const CH_LBRACKET = 91;
const CH_BACKSLASH = 92;
const CH_RBRACKET = 93;
const CH_UNDERSCORE = 95;
const CH_BACKTICK = 96;
const CH_LBRACE = 123;
const CH_RBRACE = 125;
const CH_RPAREN = 41;
const CH_NBSP = 0xa0;
const CH_LSEP = 0x2028;
const CH_PSEP = 0x2029;
const CH_IDEOGRAPHIC_SPACE = 0x3000;
const CH_BOM = 0xfeff;

/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

function isWhitespaceCode(code: number): boolean {
  return (
    code === CH_SPACE ||
    code === CH_TAB ||
    code === CH_LF ||
    code === CH_CR ||
    code === CH_VT ||
    code === CH_FF ||
    code === CH_NBSP ||
    code === CH_LSEP ||
    code === CH_PSEP ||
    code === CH_IDEOGRAPHIC_SPACE ||
    code === CH_BOM
  );
}

function isIdentifierCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === CH_UNDERSCORE ||
    code === CH_DOLLAR ||
    (code > 127 && !isWhitespaceCode(code))
  );
}

type Frame =
  | { kind: "template"; start: number; textStart: number }
  | { kind: "expr"; depth: number };

/** What the previous significant token implies for a following `/`. */
type PrevToken = "division" | "other";

const WARNING_MESSAGES: Record<TokenizerWarningCode, string> = {
  unterminated_string: "unterminated string literal",
  unterminated_template: "unterminated template literal",
  unterminated_comment: "unterminated block comment",
  unterminated_regex: "unterminated regular expression literal",
};

/** Classify the source into code regions. Never throws on malformed input. */
export function tokenize(source: string): TokenizeResult {
  const length = source.length;
  const holes: CodeRegion[] = [];
  const warnings: TokenizerWarning[] = [];

  const addHole = (start: number, end: number): void => {
    if (end > start) holes.push({ start, end });
  };
  const addWarning = (code: TokenizerWarningCode, offset: number): void => {
    const position = offsetToPosition(source, offset);
    warnings.push({
      code,
      offset,
      line: position.line,
      col: position.col,
      message: WARNING_MESSAGES[code],
    });
  };

  const stack: Frame[] = [];
  let prev: PrevToken = "other";
  let i = 0;

  // A hashbang is only a hashbang on the very first line, optionally after a BOM.
  const hashbangStart = source.charCodeAt(0) === CH_BOM ? 1 : 0;
  if (
    source.charCodeAt(hashbangStart) === CH_HASH &&
    source.charCodeAt(hashbangStart + 1) === CH_BANG
  ) {
    const end = lineEndFrom(source, hashbangStart);
    addHole(hashbangStart, end);
    i = end;
  }

  while (i < length) {
    const frame = stack.length > 0 ? stack[stack.length - 1] : undefined;

    if (frame !== undefined && frame.kind === "template") {
      let j = i;
      let resolved = false;
      while (j < length) {
        const code = source.charCodeAt(j);
        if (code === CH_BACKSLASH) {
          j += 2;
          continue;
        }
        if (code === CH_BACKTICK) {
          addHole(frame.textStart, j);
          stack.pop();
          i = j + 1;
          prev = "division";
          resolved = true;
          break;
        }
        if (code === CH_DOLLAR && source.charCodeAt(j + 1) === CH_LBRACE) {
          addHole(frame.textStart, j);
          stack.push({ kind: "expr", depth: 0 });
          i = j + 2;
          prev = "other";
          resolved = true;
          break;
        }
        j += 1;
      }
      if (!resolved) {
        addHole(frame.textStart, length);
        addWarning("unterminated_template", frame.start);
        stack.pop();
        i = length;
      }
      continue;
    }

    const code = source.charCodeAt(i);

    if (isWhitespaceCode(code)) {
      i += 1;
      continue;
    }

    if (code === CH_SLASH) {
      const next = source.charCodeAt(i + 1);
      if (next === CH_SLASH) {
        const end = lineEndFrom(source, i);
        addHole(i, end);
        i = end;
        continue;
      }
      if (next === CH_STAR) {
        const close = source.indexOf("*/", i + 2);
        if (close === -1) {
          addHole(i, length);
          addWarning("unterminated_comment", i);
          i = length;
        } else {
          addHole(i, close + 2);
          i = close + 2;
        }
        continue;
      }
      if (prev === "division") {
        i += 1;
        prev = "other";
        continue;
      }
      i = scanRegex(source, i, addHole, addWarning);
      prev = "division";
      continue;
    }

    if (code === CH_DQUOTE || code === CH_SQUOTE) {
      i = scanString(source, i, code, addHole, addWarning);
      prev = "division";
      continue;
    }

    if (code === CH_BACKTICK) {
      stack.push({ kind: "template", start: i, textStart: i + 1 });
      i += 1;
      continue;
    }

    if (code === CH_LBRACE) {
      if (frame !== undefined && frame.kind === "expr") frame.depth += 1;
      i += 1;
      prev = "other";
      continue;
    }

    if (code === CH_RBRACE) {
      if (frame !== undefined && frame.kind === "expr") {
        if (frame.depth === 0) {
          stack.pop();
          const outer = stack.length > 0 ? stack[stack.length - 1] : undefined;
          if (outer !== undefined && outer.kind === "template") outer.textStart = i + 1;
          i += 1;
          prev = "division";
          continue;
        }
        frame.depth -= 1;
      }
      i += 1;
      prev = "division";
      continue;
    }

    if (code === CH_LT && source.charCodeAt(i + 1) === CH_SLASH) {
      // A JSX closing tag: the slash must never open a regex.
      i += 2;
      prev = "other";
      continue;
    }

    if (isIdentifierCode(code)) {
      let j = i + 1;
      while (j < length && isIdentifierCode(source.charCodeAt(j))) j += 1;
      const word = source.slice(i, j);
      prev = REGEX_PRECEDING_KEYWORDS.has(word) ? "other" : "division";
      i = j;
      continue;
    }

    if (code === CH_RPAREN || code === CH_RBRACKET) {
      i += 1;
      prev = "division";
      continue;
    }

    i += 1;
    prev = "other";
  }

  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const frame = stack[k];
    if (frame !== undefined && frame.kind === "template") {
      addWarning("unterminated_template", frame.start);
      break;
    }
  }

  return { regions: complement(holes, length), warnings };
}

/** Offset of the line terminator at or after `from`, or the end of the source. */
function lineEndFrom(source: string, from: number): number {
  let j = from;
  while (j < source.length) {
    const code = source.charCodeAt(j);
    if (code === CH_LF || code === CH_CR) return j;
    j += 1;
  }
  return source.length;
}

type AddHole = (start: number, end: number) => void;
type AddWarning = (code: TokenizerWarningCode, offset: number) => void;

/** Consumes a string literal starting at its quote; returns the next offset. */
function scanString(
  source: string,
  start: number,
  quote: number,
  addHole: AddHole,
  addWarning: AddWarning,
): number {
  const length = source.length;
  let j = start + 1;
  while (j < length) {
    const code = source.charCodeAt(j);
    if (code === CH_BACKSLASH) {
      j += 2;
      continue;
    }
    if (code === CH_LF || code === CH_CR) {
      addHole(start + 1, j);
      addWarning("unterminated_string", start);
      return j;
    }
    if (code === quote) {
      addHole(start + 1, j);
      return j + 1;
    }
    j += 1;
  }
  addHole(start + 1, length);
  addWarning("unterminated_string", start);
  return length;
}

/** Consumes a regex literal starting at its opening slash; returns the next offset. */
function scanRegex(
  source: string,
  start: number,
  addHole: AddHole,
  addWarning: AddWarning,
): number {
  const length = source.length;
  let j = start + 1;
  let inClass = false;
  while (j < length) {
    const code = source.charCodeAt(j);
    if (code === CH_BACKSLASH) {
      j += 2;
      continue;
    }
    if (code === CH_LF || code === CH_CR) {
      addHole(start + 1, j);
      addWarning("unterminated_regex", start);
      return j;
    }
    if (code === CH_LBRACKET) inClass = true;
    else if (code === CH_RBRACKET) inClass = false;
    else if (code === CH_SLASH && !inClass) {
      addHole(start + 1, j);
      return j + 1;
    }
    j += 1;
  }
  addHole(start + 1, length);
  addWarning("unterminated_regex", start);
  return length;
}

/** The ascending complement of `holes` within `[0, length)`. */
function complement(holes: readonly CodeRegion[], length: number): CodeRegion[] {
  const regions: CodeRegion[] = [];
  let cursor = 0;
  for (const hole of holes) {
    if (hole.start > cursor) regions.push({ start: cursor, end: hole.start });
    if (hole.end > cursor) cursor = hole.end;
  }
  if (cursor < length) regions.push({ start: cursor, end: length });
  return regions;
}

/**
 * The source with every non-code byte replaced by a space (newlines preserved),
 * so byte offsets — and therefore line/col — are identical to the input.
 */
export function maskNonCode(source: string, precomputed?: readonly CodeRegion[]): string {
  const regions = precomputed ?? tokenize(source).regions;
  const parts: string[] = [];
  let cursor = 0;
  for (const region of regions) {
    if (region.start > cursor) parts.push(blankOut(source, cursor, region.start));
    parts.push(source.slice(region.start, region.end));
    cursor = region.end;
  }
  if (cursor < source.length) parts.push(blankOut(source, cursor, source.length));
  return parts.join("");
}

/** `[start, end)` with every character but `\r` and `\n` replaced by a space. */
function blankOut(source: string, start: number, end: number): string {
  let breakAt = -1;
  for (let i = start; i < end; i += 1) {
    const code = source.charCodeAt(i);
    if (code === CH_LF || code === CH_CR) {
      breakAt = i;
      break;
    }
  }
  if (breakAt === -1) return " ".repeat(end - start);

  const parts: string[] = [];
  let runStart = start;
  for (let i = start; i < end; i += 1) {
    const code = source.charCodeAt(i);
    if (code === CH_LF || code === CH_CR) {
      parts.push(" ".repeat(i - runStart), source[i] as string);
      runStart = i + 1;
    }
  }
  parts.push(" ".repeat(end - runStart));
  return parts.join("");
}

/** True when `offset` falls inside one of `regions`. */
export function isCodeOffset(regions: readonly CodeRegion[], offset: number): boolean {
  if (offset < 0) return false;
  let low = 0;
  let high = regions.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const region = regions[mid];
    if (region === undefined) return false;
    if (offset < region.start) high = mid - 1;
    else if (offset >= region.end) low = mid + 1;
    else return true;
  }
  return false;
}

/**
 * 1-based line/col for a byte offset. `\r\n` counts as one line break, a leading
 * UTF-8 BOM occupies no column.
 */
export function offsetToPosition(source: string, offset: number): { line: number; col: number } {
  let line = 1;
  let lineStart = 0;
  let cursor = 0;
  for (;;) {
    const breakAt = source.indexOf("\n", cursor);
    if (breakAt === -1 || breakAt >= offset) break;
    line += 1;
    lineStart = breakAt + 1;
    cursor = breakAt + 1;
  }
  let col = offset - lineStart + 1;
  if (line === 1 && source.charCodeAt(0) === CH_BOM) col -= 1;
  return { line, col: col < 1 ? 1 : col };
}

/** Strip a leading UTF-8 BOM, returning the text and how many chars were removed. */
export function stripBom(source: string): { text: string; removed: number } {
  if (source.charCodeAt(0) === CH_BOM) return { text: source.slice(1), removed: 1 };
  return { text: source, removed: 0 };
}

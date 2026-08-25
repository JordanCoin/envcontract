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

/** Classify the source into code regions. Never throws on malformed input. */
export function tokenize(_source: string): TokenizeResult {
  throw new Error("not implemented");
}

/**
 * The source with every non-code byte replaced by a space (newlines preserved),
 * so byte offsets — and therefore line/col — are identical to the input.
 */
export function maskNonCode(_source: string): string {
  throw new Error("not implemented");
}

/** True when `offset` falls inside one of `regions`. */
export function isCodeOffset(_regions: readonly CodeRegion[], _offset: number): boolean {
  throw new Error("not implemented");
}

/**
 * 1-based line/col for a byte offset. `\r\n` counts as one line break, a leading
 * UTF-8 BOM occupies no column.
 */
export function offsetToPosition(_source: string, _offset: number): { line: number; col: number } {
  throw new Error("not implemented");
}

/** Strip a leading UTF-8 BOM, returning the text and how many chars were removed. */
export function stripBom(_source: string): { text: string; removed: number } {
  throw new Error("not implemented");
}

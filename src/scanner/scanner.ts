/**
 * SPEC: docs/SPEC.md — Module A `scanner` ("Recognized syntaxes", "Optional
 * detection", "Must NOT produce a Reference").
 */

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

/** Pure: no I/O. Scans already-read files. */
export function scanFiles(_files: readonly SourceFile[], _opts?: ScanOptions): ScanResult {
  throw new Error("not implemented");
}

/** Scans one file. `scanFiles` merges the per-file results. */
export function scanSource(_file: SourceFile, _opts?: ScanOptions): ScanResult {
  throw new Error("not implemented");
}

/** `[A-Za-z_][A-Za-z0-9_]*` — Vercel's key grammar. Case is preserved. */
export function isValidKey(_key: string): boolean {
  throw new Error("not implemented");
}

/** An empty result, used as the identity when merging. */
export function emptyScanResult(): ScanResult {
  throw new Error("not implemented");
}

/** Merges per-file results, preserving the documented sort orders. */
export function mergeScanResults(_results: readonly ScanResult[]): ScanResult {
  throw new Error("not implemented");
}

/**
 * SPEC: docs/SPEC.md — Module A `scanner`, "File selection (`scanDirectory`)".
 *
 * Resolution baked into this API: directory walking is async (`Promise`), and
 * all filesystem access goes through an injectable `FileSystemAdapter` so the
 * runner and the tests can substitute a root without touching the real disk.
 */

import type { ScanOptions, ScanResult, ScanWarning, SourceFile } from "./scanner.js";

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** Extensions scanned as JavaScript. `.vue`/`.svelte`/`.astro` are scanned whole. */
export const DEFAULT_INCLUDE_EXTENSIONS: readonly string[] = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".astro",
];

export const ALWAYS_IGNORED_DIRECTORIES: readonly string[] = [
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vercel",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  "storybook-static",
];

/** Substrings/suffixes that mark a file as a test artifact (opt in via `includeTests`). */
export const TEST_FILE_MARKERS: readonly string[] = [
  ".test.",
  ".spec.",
  "__tests__",
  "__mocks__",
  ".stories.",
];

/** Suffixes never scanned, regardless of options. */
export const ALWAYS_IGNORED_SUFFIXES: readonly string[] = [".d.ts", ".min.js", ".map"];

export type DirEntry = {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
};

export type FileStat = { size: number; isDirectory: boolean; isFile: boolean };

export interface FileSystemAdapter {
  readdir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  /** Follows symlinks; used to detect loops via the resolved real path. */
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
}

/** The real Node filesystem adapter used by `main.ts`. */
export const nodeFileSystem: FileSystemAdapter = {
  readdir(_path: string): Promise<DirEntry[]> {
    throw new Error("not implemented");
  },
  stat(_path: string): Promise<FileStat> {
    throw new Error("not implemented");
  },
  realpath(_path: string): Promise<string> {
    throw new Error("not implemented");
  },
  readFile(_path: string): Promise<Buffer> {
    throw new Error("not implemented");
  },
  exists(_path: string): Promise<boolean> {
    throw new Error("not implemented");
  },
};

export type DiscoveredFile = {
  /** Absolute path. */
  path: string;
  /** POSIX-separated path relative to `root`. */
  relativePath: string;
  kind: "code" | "env-example";
};

export type ScanDirectoryOptions = ScanOptions & {
  include?: readonly string[];
  exclude?: readonly string[];
  includeTests?: boolean;
  respectGitignore?: boolean;
  maxFileSizeBytes?: number;
  fs?: FileSystemAdapter;
};

export type CollectResult = {
  /** Sorted by `relativePath` ascending — deterministic regardless of readdir order. */
  files: DiscoveredFile[];
  warnings: ScanWarning[];
};

/** Walks `root`, applying the ignore rules, gitignore, and user globs. */
export function collectFiles(_root: string, _opts?: ScanDirectoryOptions): Promise<CollectResult> {
  throw new Error("not implemented");
}

/** Reads the collected code files. Binary and oversized files are skipped with a warning. */
export function readSourceFiles(
  _files: readonly DiscoveredFile[],
  _opts?: ScanDirectoryOptions,
): Promise<{ sources: SourceFile[]; warnings: ScanWarning[] }> {
  throw new Error("not implemented");
}

/** `collectFiles` + `readSourceFiles` + `scanFiles`. */
export function scanDirectory(_root: string, _opts?: ScanDirectoryOptions): Promise<ScanResult> {
  throw new Error("not implemented");
}

/** Parses a `.gitignore` into the simple patterns this tool supports. */
export function parseGitignore(
  _content: string,
): { patterns: string[]; unsupported: string[] } {
  throw new Error("not implemented");
}

/** Minimal glob matcher: `*`, `**`, `?`, `{a,b}`, POSIX separators. */
export function matchesGlob(_relativePath: string, _pattern: string): boolean {
  throw new Error("not implemented");
}

/** True when the bytes look binary (a NUL in the first 8KB). */
export function looksBinary(_bytes: Uint8Array): boolean {
  throw new Error("not implemented");
}

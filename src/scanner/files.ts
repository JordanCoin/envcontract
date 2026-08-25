/**
 * SPEC: docs/SPEC.md — Module A `scanner`, "File selection (`scanDirectory`)".
 *
 * Resolution baked into this API: directory walking is async (`Promise`), and
 * all filesystem access goes through an injectable `FileSystemAdapter` so the
 * runner and the tests can substitute a root without touching the real disk.
 */

import { promises as nodeFs } from "node:fs";
import path from "node:path";

import { isEnvExampleFile } from "./envfile.js";
import { scanFiles } from "./scanner.js";
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
  async readdir(target: string): Promise<DirEntry[]> {
    const entries = await nodeFs.readdir(target, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  },
  async stat(target: string): Promise<FileStat> {
    const stats = await nodeFs.stat(target);
    return { size: stats.size, isDirectory: stats.isDirectory(), isFile: stats.isFile() };
  },
  realpath(target: string): Promise<string> {
    return nodeFs.realpath(target);
  },
  readFile(target: string): Promise<Buffer> {
    return nodeFs.readFile(target);
  },
  async exists(target: string): Promise<boolean> {
    try {
      await nodeFs.stat(target);
      return true;
    } catch {
      return false;
    }
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

/** A `.gitignore` line, reduced to the three shapes this tool supports. */
type GitignoreRule = {
  /** The pattern with any leading/trailing `/` removed. */
  pattern: string;
  /** `dir/` — matches directories only. */
  directoryOnly: boolean;
  /** Contains a `/`, so it is anchored to the repository root. */
  anchored: boolean;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate.startsWith(prefix);
}

function toGitignoreRule(raw: string): GitignoreRule {
  const directoryOnly = raw.endsWith("/");
  let pattern = directoryOnly ? raw.slice(0, -1) : raw;
  const anchored = pattern.includes("/") || pattern.startsWith("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  return { pattern, directoryOnly, anchored };
}

function isGitignored(
  relativePath: string,
  isDirectory: boolean,
  rules: readonly GitignoreRule[],
): boolean {
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    if (rule.anchored) {
      if (matchesGlob(relativePath, rule.pattern)) return true;
      if (relativePath.startsWith(`${rule.pattern}/`)) return true;
      continue;
    }
    if (relativePath.split("/").some((segment) => matchesGlob(segment, rule.pattern))) {
      return true;
    }
  }
  return false;
}

function isTestPath(relativePath: string): boolean {
  return TEST_FILE_MARKERS.some((marker) => relativePath.includes(marker));
}

/**
 * File-level selection. Hard rules (always-ignored suffixes, a real `.env`,
 * `.gitignore`) come first, then the user's `exclude`, then the user's
 * `include` — which can pull in a file the default rules would have skipped —
 * then the defaults.
 */
function isSelected(
  relativePath: string,
  name: string,
  opts: ScanDirectoryOptions,
  rules: readonly GitignoreRule[],
): boolean {
  if (ALWAYS_IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;

  const isExample = isEnvExampleFile(relativePath);
  // I1: a real `.env` is never opened, whatever the user's globs say.
  if (name.startsWith(".env") && !isExample) return false;

  if (isGitignored(relativePath, false, rules)) return false;
  if (opts.exclude?.some((pattern) => matchesGlob(relativePath, pattern))) return false;
  if (opts.include?.some((pattern) => matchesGlob(relativePath, pattern))) return true;
  if (isExample) return true;

  const extension = path.extname(name);
  if (!DEFAULT_INCLUDE_EXTENSIONS.includes(extension)) return false;
  if (opts.includeTests !== true && isTestPath(relativePath)) return false;
  return true;
}

/** Walks `root`, applying the ignore rules, gitignore, and user globs. */
export async function collectFiles(
  root: string,
  opts: ScanDirectoryOptions = {},
): Promise<CollectResult> {
  const fs = opts.fs ?? nodeFileSystem;
  const files: DiscoveredFile[] = [];
  const warnings: ScanWarning[] = [];

  let rootReal = root;
  try {
    rootReal = await fs.realpath(root);
  } catch (error) {
    warnings.push({
      file: ".",
      line: 1,
      code: "unreadable_file",
      message: `Could not resolve the scan root: ${describeError(error)}`,
    });
  }

  const rules = await loadGitignore(root, fs, opts, warnings);
  const visited = new Set<string>();

  const walk = async (absolute: string, real: string, relativeDir: string): Promise<void> => {
    if (visited.has(real)) return;
    visited.add(real);

    let entries: DirEntry[];
    try {
      entries = await fs.readdir(absolute);
    } catch (error) {
      warnings.push({
        file: relativeDir === "" ? "." : relativeDir,
        line: 1,
        code: "unreadable_file",
        message: `Could not read a directory: ${describeError(error)}`,
      });
      return;
    }

    for (const entry of [...entries].sort((a, b) => compareStrings(a.name, b.name))) {
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      let isDirectory = entry.isDirectory;
      let isFile = entry.isFile;
      let childReal = path.join(real, entry.name);

      if (entry.isSymbolicLink) {
        let resolved: string;
        try {
          resolved = await fs.realpath(childAbsolute);
        } catch {
          // A broken link is not an error worth failing the run over.
          continue;
        }
        // Never leave the scan root through a link.
        if (!isInside(rootReal, resolved)) continue;
        try {
          const stats = await fs.stat(childAbsolute);
          isDirectory = stats.isDirectory;
          isFile = stats.isFile;
        } catch {
          continue;
        }
        childReal = resolved;
      }

      if (isDirectory) {
        if (ALWAYS_IGNORED_DIRECTORIES.includes(entry.name)) continue;
        if (isGitignored(childRelative, true, rules)) continue;
        await walk(childAbsolute, childReal, childRelative);
        continue;
      }

      if (!isFile) continue;
      if (!isSelected(childRelative, entry.name, opts, rules)) continue;

      files.push({
        path: childAbsolute,
        relativePath: childRelative,
        kind: isEnvExampleFile(childRelative) ? "env-example" : "code",
      });
    }
  };

  await walk(root, rootReal, "");
  files.sort((a, b) => compareStrings(a.relativePath, b.relativePath));
  return { files, warnings };
}

/** Reads the root `.gitignore`, if any. Nested `.gitignore` files are not read. */
async function loadGitignore(
  root: string,
  fs: FileSystemAdapter,
  opts: ScanDirectoryOptions,
  warnings: ScanWarning[],
): Promise<GitignoreRule[]> {
  if (opts.respectGitignore === false) return [];

  const file = path.join(root, ".gitignore");
  let present = false;
  try {
    present = await fs.exists(file);
  } catch {
    present = false;
  }
  if (!present) return [];

  let content: string;
  try {
    content = (await fs.readFile(file)).toString("utf8");
  } catch (error) {
    warnings.push({
      file: ".gitignore",
      line: 1,
      code: "unreadable_file",
      message: `Could not read .gitignore: ${describeError(error)}`,
    });
    return [];
  }

  const parsed = parseGitignore(content);
  const lines = content.split(/\r\n|\n|\r/);
  for (const pattern of parsed.unsupported) {
    const index = lines.findIndex((line) => line.trim() === pattern);
    warnings.push({
      file: ".gitignore",
      line: index === -1 ? 1 : index + 1,
      code: "gitignore_unsupported_pattern",
      message: `Unsupported .gitignore pattern skipped: ${pattern}`,
    });
  }
  return parsed.patterns.map(toGitignoreRule);
}

/** Reads the collected files. Binary and oversized files are skipped with a warning. */
export async function readSourceFiles(
  files: readonly DiscoveredFile[],
  opts: ScanDirectoryOptions = {},
): Promise<{ sources: SourceFile[]; warnings: ScanWarning[] }> {
  const fs = opts.fs ?? nodeFileSystem;
  const limit = opts.maxFileSizeBytes ?? MAX_FILE_SIZE_BYTES;
  const sources: SourceFile[] = [];
  const warnings: ScanWarning[] = [];

  for (const file of files) {
    let size: number | null = null;
    try {
      size = (await fs.stat(file.path)).size;
    } catch (error) {
      warnings.push({
        file: file.relativePath,
        line: 1,
        code: "unreadable_file",
        message: `Could not stat the file: ${describeError(error)}`,
      });
      continue;
    }

    if (size > limit) {
      warnings.push({
        file: file.relativePath,
        line: 1,
        code: "file_too_large",
        message: `Skipped a file of ${size} bytes; the limit is ${limit} bytes.`,
      });
      continue;
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file.path);
    } catch (error) {
      warnings.push({
        file: file.relativePath,
        line: 1,
        code: "unreadable_file",
        message: `Could not read the file: ${describeError(error)}`,
      });
      continue;
    }

    if (looksBinary(bytes)) {
      warnings.push({
        file: file.relativePath,
        line: 1,
        code: "binary_file",
        message: "Skipped a file that looks binary.",
      });
      continue;
    }

    sources.push({ path: file.relativePath, content: bytes.toString("utf8") });
  }

  return { sources, warnings };
}

/** `collectFiles` + `readSourceFiles` + `scanFiles`. */
export async function scanDirectory(
  root: string,
  opts: ScanDirectoryOptions = {},
): Promise<ScanResult> {
  const collected = await collectFiles(root, opts);
  const code = collected.files.filter((file) => file.kind === "code");
  const read = await readSourceFiles(code, opts);
  const scanned = scanFiles(read.sources, opts);
  return {
    ...scanned,
    warnings: [...collected.warnings, ...read.warnings, ...scanned.warnings],
  };
}

/** Parses a `.gitignore` into the simple patterns this tool supports. */
export function parseGitignore(content: string): { patterns: string[]; unsupported: string[] } {
  const patterns: string[] = [];
  const unsupported: string[] = [];

  for (const raw of content.split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    // Negation and `**` are deliberately not approximated — see the SPEC note.
    if (line.startsWith("!") || line.includes("**")) {
      unsupported.push(line);
      continue;
    }
    patterns.push(line);
  }

  return { patterns, unsupported };
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(text: string): string {
  return text.replace(REGEXP_SPECIALS, "\\$&");
}

const globCache = new Map<string, RegExp>();

function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;

  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] ?? "";
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const atSegmentStart = i === 0 || pattern[i - 1] === "/";
        if (atSegmentStart && pattern[i + 2] === "/") {
          // `**/` also matches zero directories.
          source += "(?:.*/)?";
          i += 2;
          continue;
        }
        source += ".*";
        i += 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "{") {
      const end = pattern.indexOf("}", i);
      if (end > i) {
        const alternatives = pattern.slice(i + 1, end).split(",");
        source += `(?:${alternatives.map((alt) => escapeRegExp(alt)).join("|")})`;
        i = end;
        continue;
      }
    }
    source += escapeRegExp(char);
  }

  const compiled = new RegExp(`^${source}$`);
  globCache.set(pattern, compiled);
  return compiled;
}

/** Minimal glob matcher: `*`, `**`, `?`, `{a,b}`, POSIX separators. */
export function matchesGlob(relativePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relativePath);
}

const BINARY_SNIFF_BYTES = 8 * 1024;

/** True when the bytes look binary (a NUL in the first 8KB). */
export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

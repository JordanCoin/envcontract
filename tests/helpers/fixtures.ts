/**
 * Shared, implementation-free builders for the red suite.
 *
 * Nothing here calls into `src/` at runtime — these are data factories only, so
 * a helper can never be the reason a test is red.
 */

import { expect } from "vitest";

import type { Finding, FindingStatus, Report, ReportCounts } from "../../src/compare.js";
import type { DeclaredEntry, DeclaredMap } from "../../src/scanner/envfile.js";
import type {
  DynamicAccess,
  KeyInfo,
  Reference,
  ScanResult,
  ScanWarning,
  SourceFile,
} from "../../src/scanner/scanner.js";
import type { EnvVar, FetchLike, Target } from "../../src/vercel/client.js";
import type {
  GitHubDeps,
  Inputs,
  IssueComment,
  Logger,
  OutputName,
  RunDeps,
} from "../../src/run.js";
import type { Annotation } from "../../src/report/annotations.js";
import type {
  DirEntry,
  FileStat,
  FileSystemAdapter,
} from "../../src/scanner/files.js";
import { VERSION } from "../../src/version.js";

/* ------------------------------------------------------------------ scanner */

export function makeReference(over: Partial<Reference> = {}): Reference {
  return {
    key: "STRIPE_SECRET_KEY",
    file: "src/lib/stripe.ts",
    line: 3,
    col: 20,
    kind: "process.env",
    optional: false,
    ...over,
  };
}

export function makeFile(path: string, content: string): SourceFile {
  return { path, content };
}

/** Builds `keys` from `references` the way the scanner must: sorted, required = any non-optional. */
export function keysFromReferences(references: readonly Reference[]): Map<string, KeyInfo> {
  const byKey = new Map<string, Reference[]>();
  for (const ref of references) {
    const existing = byKey.get(ref.key);
    if (existing) existing.push(ref);
    else byKey.set(ref.key, [ref]);
  }
  const out = new Map<string, KeyInfo>();
  for (const key of [...byKey.keys()].sort()) {
    const sites = byKey.get(key) ?? [];
    out.set(key, { required: sites.some((s) => !s.optional), sites });
  }
  return out;
}

export function makeScanResult(
  over: Partial<ScanResult> & { references?: Reference[] } = {},
): ScanResult {
  const references = over.references ?? [];
  const base: ScanResult = {
    references,
    keys: over.keys ?? keysFromReferences(references),
    dynamicAccess: over.dynamicAccess ?? ([] as DynamicAccess[]),
    ignoredBuiltins: over.ignoredBuiltins ?? [],
    warnings: over.warnings ?? ([] as ScanWarning[]),
    filesScanned: over.filesScanned ?? 1,
  };
  return base;
}

export function makeDeclared(
  entries: Record<string, Partial<DeclaredEntry> | undefined> = {},
): DeclaredMap {
  const map: DeclaredMap = new Map();
  for (const key of Object.keys(entries).sort()) {
    const over = entries[key] ?? {};
    map.set(key, {
      optional: over.optional ?? false,
      file: over.file ?? ".env.example",
      line: over.line ?? 1,
    });
  }
  return map;
}

/* ------------------------------------------------------------------- vercel */

export function makeEnvVar(over: Partial<EnvVar> = {}): EnvVar {
  return {
    key: "STRIPE_SECRET_KEY",
    targets: ["production"],
    gitBranch: null,
    type: "encrypted",
    customEnvironmentIds: [],
    ...over,
  };
}

/** A raw Vercel API env row, including the `value` the tool must never touch. */
export function makeRawEnv(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "env_1",
    key: "STRIPE_SECRET_KEY",
    value: "sk_live_MUST_NEVER_APPEAR",
    type: "encrypted",
    target: ["production"],
    gitBranch: null,
    customEnvironmentIds: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    createdBy: "usr_1",
    updatedBy: "usr_1",
    comment: "a comment",
    decrypted: true,
    visibility: "public",
    contentHint: null,
    configurationId: null,
    edgeConfigId: null,
    ...over,
  };
}

/* ------------------------------------------------------------------ compare */

export function makeCounts(over: Partial<ReportCounts> = {}): ReportCounts {
  return {
    missing: 0,
    missing_optional: 0,
    present: 0,
    elsewhere: 0,
    unused: 0,
    dynamic: 0,
    ...over,
  };
}

export function makeFinding(over: Partial<Finding> = {}): Finding {
  const status: FindingStatus = over.status ?? "missing";
  const finding: Finding = {
    key: over.key ?? "STRIPE_SECRET_KEY",
    status,
    sites: over.sites ?? [{ file: "src/lib/stripe.ts", line: 3 }],
    foundIn: over.foundIn ?? ([] as Target[]),
  };
  if (over.detail !== undefined) finding.detail = over.detail;
  return finding;
}

export function makeReport(over: Partial<Report> = {}): Report {
  const findings = over.findings ?? [];
  return {
    status: over.status ?? "pass",
    target: over.target ?? "preview",
    branch: over.branch ?? null,
    counts: over.counts ?? countFindings(findings),
    findings,
    dynamicAccess: over.dynamicAccess ?? 0,
    version: over.version ?? VERSION,
  };
}

export function countFindings(findings: readonly Finding[]): ReportCounts {
  const counts = makeCounts();
  for (const f of findings) {
    if (f.status === "missing") counts.missing += 1;
    else if (f.status === "missing_optional") counts.missing_optional += 1;
    else if (f.status === "present") counts.present += 1;
    else if (f.status === "elsewhere") counts.elsewhere += 1;
    else if (f.status === "unused") counts.unused += 1;
  }
  return counts;
}

/* -------------------------------------------------------------- fetch mocks */

export type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

export type ResponseSpec = {
  status?: number;
  body?: unknown;
  /** Raw body, used to script malformed JSON. */
  text?: string;
  headers?: Record<string, string>;
};

export type FetchHandler =
  | ResponseSpec
  | ResponseSpec[]
  | ((request: RecordedRequest, index: number) => ResponseSpec | Error);

export type FetchRecorder = {
  fetch: FetchLike;
  requests: RecordedRequest[];
  urls(): string[];
};

/** An injectable `fetch` that records every request and replays a script. */
export function createFetchRecorder(handler: FetchHandler): FetchRecorder {
  const requests: RecordedRequest[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      if (Array.isArray(rawHeaders)) {
        for (const pair of rawHeaders) {
          const name = pair[0];
          const value = pair[1];
          if (name !== undefined && value !== undefined) headers[name.toLowerCase()] = value;
        }
      } else if (typeof (rawHeaders as Headers).forEach === "function") {
        (rawHeaders as Headers).forEach((value, name) => {
          headers[name.toLowerCase()] = value;
        });
      } else {
        for (const [name, value] of Object.entries(rawHeaders as Record<string, string>)) {
          headers[name.toLowerCase()] = value;
        }
      }
    }

    const bodyInit = init?.body;
    const request: RecordedRequest = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: typeof bodyInit === "string" ? bodyInit : null,
    };
    const index = requests.length;
    requests.push(request);

    let spec: ResponseSpec | Error;
    if (typeof handler === "function") spec = handler(request, index);
    else if (Array.isArray(handler)) spec = handler[Math.min(index, handler.length - 1)] ?? {};
    else spec = handler;

    if (spec instanceof Error) throw spec;

    const status = spec.status ?? 200;
    const text = spec.text ?? JSON.stringify(spec.body ?? {});
    return new Response(text, {
      status,
      headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
    });
  };

  return {
    fetch: fetchImpl,
    requests,
    urls: () => requests.map((r) => r.url),
  };
}

/** I4 + I1: `decrypt` must never appear in any URL this tool builds. */
export function assertNoDecrypt(recorder: FetchRecorder): void {
  for (const url of recorder.urls()) {
    expect(url.toLowerCase()).not.toContain("decrypt");
  }
}

/** I4: every Vercel request is a GET. */
export function assertOnlyGets(recorder: FetchRecorder): void {
  for (const request of recorder.requests) {
    expect(request.method).toBe("GET");
  }
}

/* ---------------------------------------------------------------- run deps */

export function makeInputs(over: Partial<Inputs> = {}): Inputs {
  return {
    vercel_token: "vcp_test_token",
    target: "preview",
    project: "",
    team_id: "",
    branch: "",
    path: ".",
    include: "",
    exclude: "",
    ignore: "",
    optional: "",
    required: "",
    fail_on: "elsewhere",
    on_error: "fail",
    comment: "true",
    github_token: "gh_token",
    license_key: "",
    report_url: "https://envcontract.dev/api/report",
    include_tests: "false",
    ...over,
  };
}

export type LogRecorder = Logger & {
  infos: string[];
  warnings: string[];
  errors: string[];
  debugs: string[];
  all(): string[];
};

export function createLogRecorder(): LogRecorder {
  const infos: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const debugs: string[] = [];
  return {
    infos,
    warnings,
    errors,
    debugs,
    info: (m) => void infos.push(m),
    warning: (m) => void warnings.push(m),
    error: (m) => void errors.push(m),
    debug: (m) => void debugs.push(m),
    all: () => [...infos, ...warnings, ...errors, ...debugs],
  };
}

export type FakeGitHub = GitHubDeps & {
  comments: IssueComment[];
  created: string[];
  updated: { id: number; body: string }[];
  failCreate?: Error;
  failList?: Error;
};

export function createFakeGitHub(over: Partial<GitHubDeps> = {}): FakeGitHub {
  const comments: IssueComment[] = [];
  const created: string[] = [];
  const updated: { id: number; body: string }[] = [];
  let nextId = 1;

  const gh: FakeGitHub = {
    eventName: over.eventName ?? "pull_request",
    repo: over.repo ?? { owner: "JordanCoin", repo: "envcontract" },
    sha: over.sha ?? "a".repeat(40),
    defaultBranch: over.defaultBranch ?? "main",
    prNumber: over.prNumber ?? 12,
    comments,
    created,
    updated,
    listComments: over.listComments ?? (async () => comments.map((c) => ({ ...c }))),
    createComment:
      over.createComment ??
      (async (_pr: number, body: string) => {
        created.push(body);
        const comment = { id: nextId++, body };
        comments.push(comment);
        return { ...comment };
      }),
    updateComment:
      over.updateComment ??
      (async (id: number, body: string) => {
        updated.push({ id, body });
        const existing = comments.find((c) => c.id === id);
        if (existing) existing.body = body;
        return { id, body };
      }),
  };
  return gh;
}

/** An in-memory filesystem: keys are absolute POSIX paths, values file contents. */
export function createMemoryFs(files: Record<string, string>): FileSystemAdapter {
  const normalized = new Map<string, string>(Object.entries(files));

  const dirsOf = (path: string): string[] => {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = new Set<string>();
    for (const key of normalized.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const head = rest.split("/")[0];
      if (head) names.add(head + (rest.includes("/") ? "/" : ""));
    }
    return [...names];
  };

  return {
    async readdir(path: string): Promise<DirEntry[]> {
      return dirsOf(path).map((name) => {
        const isDirectory = name.endsWith("/");
        return {
          name: isDirectory ? name.slice(0, -1) : name,
          isDirectory,
          isFile: !isDirectory,
          isSymbolicLink: false,
        };
      });
    },
    async stat(path: string): Promise<FileStat> {
      const content = normalized.get(path);
      if (content !== undefined) {
        return { size: Buffer.byteLength(content), isDirectory: false, isFile: true };
      }
      return { size: 0, isDirectory: true, isFile: false };
    },
    async realpath(path: string): Promise<string> {
      return path;
    },
    async readFile(path: string): Promise<Buffer> {
      const content = normalized.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return Buffer.from(content, "utf8");
    },
    async exists(path: string): Promise<boolean> {
      return normalized.has(path);
    },
  };
}

export type OutputRecorder = {
  values: Partial<Record<OutputName, string>>;
  setOutput(name: OutputName, value: string): void;
};

export type RunRecorders = {
  logs: LogRecorder;
  outputs: OutputRecorder;
  summaries: string[];
  annotations: Annotation[];
  writtenFiles: Record<string, string>;
  github: FakeGitHub;
};

export function createRunDeps(
  over: Partial<RunDeps> & { files?: Record<string, string> } = {},
): { deps: RunDeps; rec: RunRecorders } {
  const logs = createLogRecorder();
  const summaries: string[] = [];
  const annotations: Annotation[] = [];
  const writtenFiles: Record<string, string> = {};
  const outputValues: Partial<Record<OutputName, string>> = {};
  const github = (over.github as FakeGitHub | undefined) ?? createFakeGitHub();

  const outputs: OutputRecorder = {
    values: outputValues,
    setOutput(name, value) {
      outputValues[name] = value;
    },
  };

  const deps: RunDeps = {
    fetch: over.fetch ?? createFetchRecorder({ body: { envs: [] } }).fetch,
    fs: over.fs ?? createMemoryFs(over.files ?? {}),
    async writeFile(path: string, content: string) {
      writtenFiles[path] = content;
    },
    env: over.env ?? {},
    cwd: over.cwd ?? "/repo",
    github,
    logger: over.logger ?? logs,
    outputs: over.outputs ?? outputs,
    summary: over.summary ?? {
      async write(markdown: string) {
        summaries.push(markdown);
      },
    },
    annotations: over.annotations ?? {
      emit(annotation: Annotation) {
        annotations.push(annotation);
      },
    },
  };

  if (over.writeFile) deps.writeFile = over.writeFile;
  if (over.sleep) deps.sleep = over.sleep;
  if (over.now) deps.now = over.now;
  if (over.client) deps.client = over.client;

  return {
    deps,
    rec: { logs, outputs, summaries, annotations, writtenFiles, github },
  };
}

/** Deep-scans anything rendered for a planted secret (I1). */
export function assertNeverContains(haystack: unknown, needle: string): void {
  const serialized =
    typeof haystack === "string" ? haystack : JSON.stringify(haystack) ?? String(haystack);
  expect(serialized).not.toContain(needle);
}

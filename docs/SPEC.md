# EnvContract — engineering contract (v1)

> "Does the code in this commit require configuration that this deployment environment doesn't have?"

Two deliverables:
1. **`JordanCoin/envcontract`** (PUBLIC — Marketplace requires it): the GitHub Action + a CLI. TypeScript strict, **`runs.using: node24`** (node20 runners are removed 2026-09-16), bundled with `@vercel/ncc` to `dist/index.js` (committed). Test runner: **vitest + fast-check** (property tests). Package manager: pnpm. Runtime deps: `@actions/core`, `@actions/github` only (both bundled). CLI bin `envcontract` (`dist/cli.js`).
   Default branch detection for the Action: `GITHUB_HEAD_REF` (set on pull_request) → else `GITHUB_REF_NAME` (note: on PR events without HEAD_REF, REF_NAME is `<n>/merge` — treat a `/merge` suffix as "unknown branch").
2. **`JordanCoin/envcontract-web`** (private): Next.js on Vercel. Landing + pricing + `POST /api/report` (license-gated Slack/email alerts). Stack copied from aasa-link (Next + Tailwind + `tsx --test`, no DB, Stripe subscription metadata as datastore).

Hard invariants (tests enforce every one):
- **I1. Never see, log, store, or emit a value.** The Vercel client maps responses to `{key,target,gitBranch,type}` and discards everything else at the boundary. No log line, error, summary, annotation, output, or report body may contain a value.
- **I2. Fail closed.** An API/network/auth error is `status: "error"` and a non-zero exit, never a green run. (`on_error: warn` may downgrade to a warning, opt-in only.)
- **I3. Deterministic.** Same inputs → byte-identical report. Sorted keys, stable ordering, no timestamps in the body.
- **I4. Read-only.** The Action performs only GET requests to Vercel. (PR comment is the only write, to GitHub, and only when `comment: true`.)

---

## Module A — `scanner` (pure; no I/O except reading files given to it)

`scanFiles(files: {path: string, content: string}[], opts?) → ScanResult`
`scanDirectory(root: string, opts?) → ScanResult` (glob + ignore; delegates to scanFiles)

```ts
type Reference = { key: string; file: string; line: number; col: number; kind: "process.env"|"import.meta.env"; optional: boolean }
type ScanResult = {
  references: Reference[]            // every site, sorted by file,line,col
  keys: Map<string, { required: boolean; sites: Reference[] }>   // required = any site non-optional
  dynamicAccess: { file: string; line: number; kind: string }[]   // process.env[expr] — unresolvable
  filesScanned: number
}
```

Recognized syntaxes (all → a Reference):
- `process.env.KEY`, `process.env["KEY"]`, `process.env['KEY']`, `` process.env[`KEY`] `` (no `${}`)
- `process.env?.KEY`, `globalThis.process.env.KEY`, `window.process?.env.KEY` (kind `process.env`)
- destructuring: `const { A, B } = process.env`, `const { A: alias, B = "x" } = process.env` (B with default → optional), `const { A, ...rest } = process.env`, nested newline/whitespace/comments inside braces
- `import.meta.env.KEY`, `import.meta.env["KEY"]`, destructuring from `import.meta.env` (kind `import.meta.env`)
- `env.KEY` where `env` was bound by `const env = process.env` earlier in the same file (alias tracking, one level, same file only)
- TS: `process.env.KEY!`, `process.env.KEY as string`, `(process.env.KEY ?? "").trim()`
- JSX attribute values, template literal `${process.env.KEY}` expressions, inside arrow bodies, inside class fields

Optional detection (site is `optional: true` when):
- immediately followed by `??` or `||` (with a non-undefined RHS), e.g. `process.env.X ?? "dev"`, `process.env.X || 3000`
- destructured with a default `{ X = "a" }`
- `typeof process.env.X` / `"X" in process.env` / `process.env.X !== undefined` / `process.env.X === undefined`
- sole condition of `if (process.env.X)`, `process.env.X ? a : b`, `process.env.X && ...`
- a `// envcontract-optional` trailing/preceding-line comment
- inside `.env.example` with a commented-out line (`# KEY=`) → declared-optional
NOT optional: `process.env.X!`, `process.env.X as string`, `process.env.X.trim()`, `String(process.env.X)`, `Number(process.env.X)`, `parseInt(process.env.X)`, `new URL(process.env.X)`, passed as an argument `fn(process.env.X)`, `process.env.X ?? throwMissing()` (RHS is a throw/call → still required? → treat `??` with a call RHS as optional; only a `throw` expression RHS keeps it required), template literal interpolation.

Must NOT produce a Reference:
- inside `//` line comments, `/* */` block comments, JSDoc
- inside string literals: `'set process.env.FOO first'`, `"process.env.FOO"` (but the KEY inside `process.env["FOO"]` bracket access IS a reference)
- inside template literal TEXT (but expressions inside `${}` ARE scanned, recursively, nested templates too)
- inside regex literals `/process\.env\.X/`
- `process.env` bare (no key), `process.env[someVar]`, `process.env[\`${prefix}_X\`]` → dynamicAccess entry, not a Reference
- `process.environment.X`, `myprocess.env.X`, `process.envX`, `process.env.` followed by a non-identifier
- a line with `// envcontract-ignore` (trailing) or a file containing `/* envcontract-ignore-file */`
- keys in the built-in ignore list (below) — they are dropped before `keys` is built, but still counted in `references`? → NO: dropped entirely from both (simplest, deterministic). Exposed as `ignoredBuiltins: string[]` for transparency.

Tokenizer robustness (these are the "insane" cases):
- `'//'` inside a string is not a comment; `"http://x"` etc.
- `/* */` spanning lines; `*/` inside a string doesn't close a comment
- unterminated string at EOF → don't crash; stop scanning that file, record `warnings`
- regex vs division ambiguity: `a / b / c` is division; `const r = /ab+c/i` is a regex; `x = y /process.env.X/` (division) — scanner must not treat `/process.env.X/` in `foo / process.env.X / 2` as a regex (heuristic: previous significant token is an identifier/number/`)`/`]` → division)
- template literal with nested template: `` `${`${process.env.A}`}` ``
- CRLF line endings; a UTF-8 BOM; a 5MB minified single line (must complete < 1s; line = 1)
- JSX text `<p>process.env.X</p>` → not a reference (it's text) — ACCEPTABLE to count as a reference (document as known limitation) → test asserts it IS ignored only inside `{/* */}` JSX comments; plain JSX text: not tested (limitation noted)
- Unicode identifiers/keys: `process.env.ÜBER` → not a valid key (Vercel keys are `[A-Za-z_][A-Za-z0-9_]*`); skipped with a warning
- key validity: `[A-Z_][A-Z0-9_]*` case-sensitive; lowercase keys `process.env.port` are references too (Vercel allows), keep as-is

File selection (`scanDirectory`):
- include: `**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,vue,svelte,astro}` + `.env.example`/`.env.sample`/`.env.template`/`.env.*.example`
- always ignore: `node_modules`, `.git`, `.next`, `.nuxt`, `.svelte-kit`, `.vercel`, `.turbo`, `.cache`, `dist`, `build`, `out`, `coverage`, `storybook-static`, `*.d.ts`, `*.min.js`, `*.map`, `.test.`/`.spec.`/`__tests__`/`__mocks__`/`*.stories.*` (test files opt-in via `include_tests`)
- respects `.gitignore` at root (simple patterns: `dir/`, `*.ext`, `path`; negation not required)
- user `include`/`exclude` globs (inputs) applied after
- symlink loops don't hang; binary files skipped; files > 10MB skipped with warning

Built-in ignore list (never reported): Node/runtime: `NODE_ENV NODE_OPTIONS NODE_EXTRA_CA_CERTS PORT HOSTNAME HOME PATH PWD TZ LANG CI TMPDIR DEBUG COLOR NO_COLOR FORCE_COLOR TERM SHELL USER`; npm: `npm_*`; Next: `NEXT_RUNTIME NEXT_PHASE NEXT_TELEMETRY_DISABLED NEXT_MANUAL_SIG_HANDLE NEXT_PRIVATE_* __NEXT_*`; Vite builtins on import.meta.env: `MODE BASE_URL PROD DEV SSR`; Vercel system (from docs, the list the facts agent returns): `VERCEL VERCEL_ENV VERCEL_URL VERCEL_BRANCH_URL VERCEL_PROJECT_PRODUCTION_URL VERCEL_REGION VERCEL_DEPLOYMENT_ID VERCEL_PROJECT_ID VERCEL_TARGET_ENV VERCEL_OIDC_TOKEN VERCEL_SKEW_PROTECTION_ENABLED VERCEL_GIT_* NEXT_PUBLIC_VERCEL_*`; AWS Lambda: `AWS_REGION AWS_DEFAULT_REGION AWS_LAMBDA_* AWS_EXECUTION_ENV _HANDLER LAMBDA_TASK_ROOT`. Plus user `ignore` input (exact keys or `PREFIX_*` globs).

`.env.example` parsing: `KEY=`, `KEY=value`, `export KEY=`, `KEY="quoted"`, comments `#`, blank lines, `# KEY=` (commented → optional-declared), CRLF, BOM, `KEY` bare (no `=`) → key. Result: `declared: Map<key,{optional:boolean,file,line}>`. Keys declared but never referenced in code → `unused` (info).

## Module B — `vercel` client (I/O; tested with an injected `fetch`)

VERIFIED API FACTS (2026-08-25, vercel.com/docs/rest-api + openapi.vercel.sh):
- List env: `GET https://api.vercel.com/v10/projects/{idOrName}/env` — query `teamId` (opt), `gitBranch` (opt filter), `decrypt` (NEVER send), `customEnvironmentId` (opt). Response `{ envs: RawEnv[], pagination?: { count, next: number|null, prev } }` (next/prev are TIMESTAMPS used as `until`/`since` cursors, not offsets) — a non-paginated shape without `pagination` also exists.
- RawEnv fields: `id, key, value, type ('plain'|'encrypted'|'secret'|'sensitive'|'system'), target (ARRAY of 'production'|'preview'|'development' OR a single STRING — normalize!), gitBranch?, customEnvironmentIds?: string[], createdAt, updatedAt, createdBy, updatedBy, comment, decrypted, visibility, contentHint, configurationId, edgeConfigId`.
- **`plain` and `system` types return cleartext `value` WITHOUT asking** (encrypted/secret return ciphertext; sensitive never decryptable). So I1 is enforced at the boundary, not by omitting `decrypt`.
- Find project: `GET /v10/projects?repoUrl=https://github.com/{owner}/{repo}` (also `search`, `repo`, `repoId`, `limit`, `from` continuation token, `teamId`). Response: `{ projects: Project[], pagination: { count, next, prev } }` per OpenAPI — BUT the agent saw a bare array in one doc; the client must accept BOTH shapes (`Array.isArray(body) ? body : body.projects`). Project: `id, name, link?: { type:'github', org, repo, repoId, productionBranch }`.
- Rate limit: env retrieval 500/min per owner. 429 header names UNVERIFIED — honor `Retry-After` if present, else exponential backoff 1s/2s/4s.
- Token: `vcp_…` from vercel.com/account/tokens, scoped Full Account / Team / Project. No read-only scope exists → the README must say "Project-scoped token recommended".

`createVercelClient({ token, teamId?, fetch?, baseUrl?, sleep?, now? })`
- `listEnv(projectIdOrName, { gitBranch? , customEnvironmentId? }) → EnvVar[]` where `EnvVar = { key: string; targets: Target[]; gitBranch: string|null; type: string; customEnvironmentIds: string[] }`. **`toEnvVar(raw)` is a pure exported mapper: picks exactly these fields, normalizes `target` string→array, drops `value` and every other field; the resulting object has NO `value` property (not even undefined) — tests assert `Object.keys()` equality.** The client must never keep a reference to the raw body after mapping (no `raw` field, no debug cache).
- `findProject({ repo: "owner/repo" } | { idOrName })` → `{ id, name }`. For repo: `repoUrl=https://github.com/owner/repo`; match `link.org`/`link.repo` case-insensitively; if multiple projects match (monorepo), return `{ error: "ambiguous", candidates: [names] }`. Falls back to `search=<repo-name>` exact-name match if `repoUrl` returns none.
- Requests: `Authorization: Bearer <token>`, `User-Agent: envcontract/<version>`, `teamId` query when set, `decrypt` NEVER present in any URL (test greps every fetched URL), method always GET (I4).
- Errors (typed `VercelError` with `.code`): 401→`unauthorized`, 403→`forbidden` (hint: teamId/token scope), 404→`project_not_found`, 429→retry (max 3, honoring `Retry-After` seconds or backoff) then `rate_limited`, 5xx→retry once then `server_error`, network/abort→`network`, malformed JSON→`bad_response`. **`.message` is templated from status + our own hint only — never from the body** (I1). Redact the token if it ever appears in an error/URL string (test: error.toString() never contains the token).
- Timeout 15s/request (AbortController). Pagination: follow `pagination.next` (as `until=` query) while non-null, max 50 pages, dedupe by `id`.

## Module C — `compare` (pure)

`compare(scan: ScanResult, declared: DeclaredMap, env: EnvVar[], opts: { target: "production"|"preview"|"development"; branch?: string; customEnvironmentId?: string; ignore: string[]; optional: string[]; required: string[] }) → Report`

Presence rule: a key is present for `target` iff some EnvVar has `key` AND (`targets` includes target OR (customEnvironmentId given AND customEnvironmentIds includes it)) AND (`gitBranch` is null OR (target==="preview" AND `gitBranch === branch`)). A production-target var with a gitBranch? — Vercel doesn't allow; treat as present.

```ts
type Finding = { key: string; status: "missing"|"missing_optional"|"present"|"elsewhere"|"unused"|"ignored"; detail?: string; sites: {file,line}[]; foundIn: Target[] }
type Report = { status: "pass"|"fail"|"error"; target; branch; counts: {missing,missing_optional,present,elsewhere,unused,dynamic}; findings: Finding[] /* sorted: missing → missing_optional → elsewhere → unused → present, then key asc */; dynamicAccess: number; version }
```
- `missing`: required key, present in NO target → 🔴 fail
- `elsewhere`: required key, absent in target, present in another target/branch → 🟡 (fails by default; `fail_on: missing` → only `missing` fails) — detail names where it exists ("in Production only", "in Preview for branch `staging` only")
- `missing_optional`: optional key absent → 🟡 warn only
- `unused`: declared in .env.example, absent from code → ℹ️
- user `required` forces keys required even if not in code; `optional` forces optional; `ignore` drops (supports `PREFIX_*`)
- `status: "fail"` iff any finding's status is in the fail set; `"error"` only set by the runner.

## Module D — `report` renderers (pure)

- `renderMarkdown(report)` → the step summary / PR comment body. Header line `## EnvContract — <Target> readiness: ✅ PASS | 🔴 FAIL`; table `| | Key | Status | Referenced at |`; collapsed `<details>` for present keys when > 10; footer `Continuously monitor every environment → https://envcontract.dev` (free) — omitted when a license key is configured. Marker `<!-- envcontract:report -->` first line (sticky comment lookup). Never contains a value (I1) — property test with a randomized value in the input asserts absence.
- `renderAnnotations(report)` → `[{level:"error"|"warning"|"notice", file, line, title, message}]` — one per missing/elsewhere/missing_optional key at its FIRST site; message ≤ 200 chars.
- `renderText(report)` → the exact CLI block from the pitch:
  ```
  🔴 STRIPE_SECRET_KEY referenced but missing from Preview  (src/lib/stripe.ts:3)
  🟡 SUPABASE_URL exists in Production only  (src/db.ts:1)
  ✅ 17 other required variables covered
  Environment readiness: FAIL
  ```
- `toJSON(report)` → stable, sorted; `JSON.stringify(toJSON(r)) === JSON.stringify(toJSON(r))` across runs.

## Module E — `run` / Action entry (thin; fully mockable)

Inputs (action.yml): `vercel_token` (req), `target` (default `preview`; if event is push to default branch → `production` when `auto`), `project` (id/name; else auto-detect via repo link; else `VERCEL_PROJECT_ID` env; else `.vercel/project.json`), `team_id` (else `VERCEL_ORG_ID`/`VERCEL_TEAM_ID` env / `.vercel/project.json` orgId), `branch` (default `GITHUB_HEAD_REF` || `GITHUB_REF_NAME`), `path` (default `.`), `include`, `exclude`, `ignore`, `optional`, `required`, `fail_on` (`missing|elsewhere|never`, default `elsewhere`), `on_error` (`fail|warn`, default `fail`), `comment` (bool, default `true` on pull_request when `github_token` present), `github_token` (default `${{ github.token }}`), `license_key` (optional; posts report to `report_url`), `report_url` (default `https://envcontract.dev/api/report`), `include_tests` (bool).
Outputs: `status`, `missing` (comma list), `missing_count`, `report_json` (path to file), `summary` (markdown).
Behaviour: writes `GITHUB_STEP_SUMMARY`; emits annotations via workflow commands; sets outputs; exit 1 on fail/error. Sticky PR comment: find existing by marker → update, else create; comment failures are warnings, never change status. Report upload failures are warnings, never change status; upload body = `toJSON(report)` + `{repo, sha, target}` only.
CLI: `npx envcontract --target preview --project my-app [--token env VERCEL_TOKEN] [--json] [--dir .]` — same core, prints `renderText`, exit codes 0/1/2 (2 = error).

## Web (`envcontract-web`)
- `/` landing (problem → 3-line YAML install → sample output → pricing), `/pricing`, `/docs` (inputs table generated from action.yml), `/subscribed`.
- `POST /api/report` — headers `Authorization: Bearer <license_key>`; body `{repo, sha, target, report}`; validates license = active Stripe subscription (metadata `license_key`); size ≤ 64KB; rejects any body where a finding contains a `value` field (defense in depth, I1); on `report.status === "fail"` sends Slack (metadata `slack_webhook_url`) and/or email (SendGrid, metadata `alert_email`); returns `{ok, alerted: string[]}`. Rate-limit 60/min per license (in-memory).
- `POST /api/stripe/webhook` — from the `stripe-subscription` primitive; on `checkout.session.completed` stamps `license_key` (random 32 hex) + plan onto the subscription; emails the key.
- `GET /api/license/:key` → `{active, plan, repos_limit}` (used by the Action to surface "Pro" in the summary).
- Stripe: $12/mo Team, $39/mo Agency, $390/yr Agency — Payment Links (manual step, per pattern).

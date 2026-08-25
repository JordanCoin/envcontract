# EnvContract for Vercel

**Fail the PR before Vercel ships code that expects an environment variable you forgot to configure.**

EnvContract answers one question on every pull request:

> Does the code in this commit require configuration that this deployment environment doesn't have?

It scans your code for `process.env.X`, `NEXT_PUBLIC_X`, `import.meta.env.X` and `VITE_X`, reads the **names** of the variables configured in your Vercel project for the target environment (Production, Preview, Development, or a specific branch), and fails the check when the two disagree.

```
🔴 STRIPE_SECRET_KEY referenced but missing from Preview  (src/lib/stripe.ts:3)
🟡 SUPABASE_URL exists in Production only  (src/db.ts:1)
✅ 17 other required variables covered
Environment readiness: FAIL
```

It never reads a value. It never writes to Vercel. It runs inside your repository with your token.

## Install

```yaml
# .github/workflows/envcontract.yml
name: EnvContract
on: [pull_request]
jobs:
  env:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # only needed for the sticky PR comment
    steps:
      - uses: actions/checkout@v4
      - uses: JordanCoin/envcontract@v1
        with:
          vercel_token: ${{ secrets.VERCEL_TOKEN }}
          target: preview
```

Create the token at [vercel.com/account/tokens](https://vercel.com/account/tokens). Vercel has no read-only scope, so scope the token to the **one project** you are checking. Add it to the repository as the `VERCEL_TOKEN` secret.

That's the whole setup. The project is auto-detected from the repository link.

## What it checks

| Finding | Meaning | Default |
|---|---|---|
| 🔴 `missing` | Required in code, configured in **no** environment | fails |
| 🟡 `elsewhere` | Required in code, configured in another environment or branch only | fails (`fail_on: missing` downgrades to a warning) |
| 🟡 `missing_optional` | Referenced with a fallback (`?? "default"`), absent | warning |
| ℹ️ `unused` | Declared in `.env.example`, never referenced | info |

A reference counts as **optional** when the code can clearly run without it: `process.env.X ?? "dev"`, `process.env.X || 3000`, `if (process.env.X)`, a destructuring default, `typeof process.env.X`, or a `// envcontract-optional` comment. Everything else is required, including `process.env.X!`, `process.env.X as string`, and `new URL(process.env.X)`.

Branch-scoped Preview variables are matched against the pull request's head branch, so a variable that only exists for `staging` is reported as `elsewhere` on a PR from `feature/x`.

Built-in platform variables (`VERCEL_URL`, `VERCEL_ENV`, `NODE_ENV`, `VERCEL_GIT_*`, Vite's `MODE`/`DEV`/`PROD`, and friends) are never reported.

Code that never runs inside a deployment is skipped by default, so a variable only your tooling reads is not reported as missing: `scripts/`, `script/`, `test/`, `tests/`, `e2e/`, `cypress/`, `playwright/`, `.storybook/`, `.github/`, and the root `playwright.config.*`, `cypress.config.*`, `vitest.config.*`, `jest.config.*`, `eslint.config.*`, `prettier.config.*`, `.eslintrc.*` and `commitlint.config.*` files. Framework configs that Vercel evaluates at build time (`next.config.*`, `vite.config.*`, `astro.config.*`, `svelte.config.*`, `nuxt.config.*`) **are** scanned. Any of the skipped paths comes back with an `include` glob.

## Output

- The workflow check fails with a non-zero exit when the contract is broken.
- A Markdown report lands in the **job summary**.
- Each missing key gets an **annotation** at the first line that references it.
- On pull requests, a single **sticky comment** is created and updated in place (never duplicated).
- Outputs: `status` (`pass` / `fail` / `error`), `missing`, `missing_count`, `report_json`, `summary`.

## Inputs

| Input | Default | Description |
|---|---|---|
| `vercel_token` | required | Vercel API token. GET requests only. |
| `target` | `preview` | `production`, `preview`, `development`, or `auto` (production on a push to the default branch, preview otherwise). |
| `project` | auto | Vercel project id or name. Falls back to `VERCEL_PROJECT_ID`, then `.vercel/project.json`, then the repository link. |
| `team_id` | auto | Vercel team id. Falls back to `VERCEL_ORG_ID` / `VERCEL_TEAM_ID`, then `.vercel/project.json`. |
| `branch` | PR head | Branch used to match branch-scoped Preview variables. |
| `path` | `.` | Directory to scan. |
| `include` / `exclude` | | Extra globs, newline- or comma-separated. |
| `ignore` | | Keys to drop. Supports `PREFIX_*`. |
| `optional` / `required` | | Force keys optional or required. |
| `fail_on` | `elsewhere` | `missing`, `elsewhere`, or `never`. |
| `on_error` | `fail` | `fail` or `warn` when Vercel cannot be reached. Errors never produce a green run by default. |
| `comment` | `true` | Post the sticky PR comment. |
| `github_token` | `github.token` | Token for the comment. |
| `include_tests` | `false` | Also scan test, spec, story, and mock files. |
| `license_key` | | Team/Agency license. Sends the report (key names and statuses only) to `report_url` for Slack and email alerts. |
| `report_url` | EnvContract API | Where licensed reports are posted. |

## The contract file

If your repository has a `.env.example` (or `.env.sample`, `.env.template`), its keys are treated as **declared** requirements and merged with what the scanner finds. A commented-out line (`# OPTIONAL_KEY=`) declares an optional key. EnvContract never reads a real `.env`.

## CLI

The same engine runs locally:

```bash
npx envcontract --target preview            # uses VERCEL_TOKEN from the environment
npx envcontract --target production --json  # machine-readable report
```

Exit codes: `0` pass, `1` fail, `2` error.

## Security model

- **Read-only.** The Action performs only `GET` requests against the Vercel API.
- **Names only.** Vercel's API returns cleartext values for plain variables. EnvContract discards every field except `key`, `target`, `gitBranch`, `type`, and `customEnvironmentIds` at the HTTP boundary, before anything else sees the response. Values cannot appear in logs, summaries, annotations, comments, or outputs; the test suite plants random values in mocked responses and asserts they never surface.
- **Fail closed.** An API error is a failed check, not a silent pass.
- **Your repo, your token.** Nothing leaves your workflow unless you set `license_key`, and then only key names and statuses are sent.

## Pricing

Free: PR scan, one repository, annotations and PR comment.
**Team $12/mo:** 10 repositories, Slack and email alerts on FAIL, scheduled drift scans.
**Agency $39/mo or $390/yr:** 50 repositories.

Details at [envcontract.vercel.app/pricing](https://envcontract.vercel.app/pricing).

## Supported frameworks

Next.js (App and Pages router), Vite, SvelteKit, Astro, Remix, Nuxt, plain Node. Any JavaScript or TypeScript that reads `process.env` or `import.meta.env`.

## Known limitations

- Dynamic access such as `process.env[name]` cannot be resolved statically; it is reported as an info count, never a failure.
- Only JavaScript and TypeScript sources are scanned. A variable declared solely in a non-JS file — `schema.prisma` (`env("DATABASE_URL")`), `docker-compose.yml`, `wrangler.toml`, a `turbo.json` `env` array — is invisible to the scanner. List those keys under `required:` (for example `required: DATABASE_URL`) so they are still checked against the environment.
- Vercel custom environments are matched by `customEnvironmentId` when you pass one; the default targets are production, preview, and development.
- Monorepos: run the Action once per Vercel project with `path:` and `project:` set.

## Contact

Built by JWC Holdings LLC. Questions and licensing: jordan@jwcholding.com

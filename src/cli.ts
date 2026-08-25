/**
 * SPEC: docs/SPEC.md — Module E, CLI:
 * `npx envcontract --target preview --project my-app [--json] [--dir .]`
 * Exit codes: 0 pass, 1 fail, 2 error.
 *
 * Hand-rolled argument parsing, no dependencies. This is the ONLY module allowed
 * to write to stdout (`tests/invariants.test.ts` enforces that).
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

import { renderText } from "./report/text.js";
import { stringifyReport } from "./report/json.js";
import {
  DEFAULT_REPORT_URL,
  runEnvContract,
  type Inputs,
  type RunDeps,
} from "./run.js";
import { nodeFileSystem } from "./scanner/files.js";

export type CliArgs = {
  target: string;
  project: string | null;
  teamId: string | null;
  branch: string | null;
  dir: string;
  token: string | null;
  /** Name of the environment variable holding the token (`--token-env`). */
  tokenEnv: string | null;
  json: boolean;
  failOn: string;
  onError: string;
  include: string[];
  exclude: string[];
  ignore: string[];
  optional: string[];
  required: string[];
  includeTests: boolean;
  help: boolean;
};

export type CliError = { message: string; exitCode: 2 };

export const USAGE = `envcontract — does this commit need config this environment doesn't have?

Usage:
  envcontract --target <production|preview|development> [options]

Options:
  --project <id|name>      Vercel project (default: auto-detect)
  --team-id <id>           Vercel team id
  --branch <name>          Branch for preview-scoped variables
  --dir <path>             Directory to scan (default: .)
  --token <token>          Vercel token (default: $VERCEL_TOKEN)
  --token-env <name>       Read the token from another environment variable
  --fail-on <missing|elsewhere|never>
  --on-error <fail|warn>
  --include/--exclude <glob>
  --ignore/--optional/--required <key>
  --include-tests
  --json                   Print the JSON report instead of the text block
  --help

Exit codes: 0 pass, 1 fail, 2 error.
`;

const TARGET_WORDS = new Set(["production", "preview", "development", "auto"]);
const FAIL_ON_WORDS = new Set(["missing", "elsewhere", "never"]);
const ON_ERROR_WORDS = new Set(["fail", "warn"]);

/** Every flag that consumes the next argv entry. Anything else is unknown. */
const VALUE_FLAGS = new Set([
  "--target",
  "--project",
  "--team-id",
  "--branch",
  "--dir",
  "--token",
  "--token-env",
  "--fail-on",
  "--on-error",
  "--include",
  "--exclude",
  "--ignore",
  "--optional",
  "--required",
]);

function usageError(message: string): CliError {
  return { message, exitCode: 2 };
}

function defaults(): CliArgs {
  return {
    target: "preview",
    project: null,
    teamId: null,
    branch: null,
    dir: ".",
    token: null,
    tokenEnv: null,
    json: false,
    failOn: "elsewhere",
    onError: "fail",
    include: [],
    exclude: [],
    ignore: [],
    optional: [],
    required: [],
    includeTests: false,
    help: false,
  };
}

/** Parses argv (without `node` and the script path). Throws nothing; returns a CliError. */
export function parseArgs(argv: readonly string[]): CliArgs | CliError {
  const args = defaults();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";

    switch (flag) {
      case "--help":
      case "-h":
        args.help = true;
        continue;
      case "--json":
        args.json = true;
        continue;
      case "--include-tests":
        args.includeTests = true;
        continue;
      default:
        break;
    }

    if (!VALUE_FLAGS.has(flag)) return usageError(`Unknown option "${flag}".`);

    // A flag that takes a value consumes the next entry; another flag in that
    // slot means the value was forgotten, which is a usage error, not a guess.
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      return usageError(`${flag} needs a value.`);
    }
    index += 1;
    const raw = next;

    switch (flag) {
      case "--target": {
        const word = raw.trim().toLowerCase();
        if (!TARGET_WORDS.has(word)) {
          return usageError(`Unknown target "${raw}". Use production, preview, development, or auto.`);
        }
        args.target = word;
        break;
      }
      case "--fail-on": {
        const word = raw.trim().toLowerCase();
        if (!FAIL_ON_WORDS.has(word)) {
          return usageError(`Unknown --fail-on "${raw}". Use missing, elsewhere, or never.`);
        }
        args.failOn = word;
        break;
      }
      case "--on-error": {
        const word = raw.trim().toLowerCase();
        if (!ON_ERROR_WORDS.has(word)) {
          return usageError(`Unknown --on-error "${raw}". Use fail or warn.`);
        }
        args.onError = word;
        break;
      }
      case "--project":
        args.project = raw;
        break;
      case "--team-id":
        args.teamId = raw;
        break;
      case "--branch":
        args.branch = raw;
        break;
      case "--dir":
        args.dir = raw;
        break;
      case "--token":
        args.token = raw;
        break;
      case "--token-env":
        args.tokenEnv = raw;
        break;
      case "--include":
        args.include.push(raw);
        break;
      case "--exclude":
        args.exclude.push(raw);
        break;
      case "--ignore":
        args.ignore.push(raw);
        break;
      case "--optional":
        args.optional.push(raw);
        break;
      case "--required":
        args.required.push(raw);
        break;
      default:
        return usageError(`Unknown option "${flag}".`);
    }
  }

  return args;
}

function isCliError(value: CliArgs | CliError): value is CliError {
  return "message" in value;
}

function toInputs(args: CliArgs, token: string): Inputs {
  return {
    vercel_token: token,
    target: args.target,
    project: args.project ?? "",
    team_id: args.teamId ?? "",
    branch: args.branch ?? "",
    path: args.dir,
    include: args.include.join("\n"),
    exclude: args.exclude.join("\n"),
    ignore: args.ignore.join("\n"),
    optional: args.optional.join("\n"),
    required: args.required.join("\n"),
    fail_on: args.failOn,
    on_error: args.onError,
    // The CLI has no pull request to comment on and no license to report under.
    comment: "false",
    github_token: "",
    license_key: "",
    report_url: DEFAULT_REPORT_URL,
    include_tests: args.includeTests ? "true" : "false",
  };
}

/** The CLI, with injected deps and an injected writer. Returns the exit code. */
export async function cli(
  argv: readonly string[],
  deps: RunDeps,
  write: (line: string) => void,
): Promise<0 | 1 | 2> {
  const parsed = parseArgs(argv);
  if (isCliError(parsed)) {
    write(parsed.message);
    write("");
    write(USAGE.trimEnd());
    return 2;
  }

  if (parsed.help) {
    write(USAGE.trimEnd());
    return 0;
  }

  const fromEnv = parsed.tokenEnv === null ? deps.env["VERCEL_TOKEN"] : deps.env[parsed.tokenEnv];
  const token = (parsed.token ?? fromEnv ?? "").trim();
  if (token === "") {
    write("No Vercel token. Pass --token, or set VERCEL_TOKEN in the environment.");
    return 2;
  }

  const result = await runEnvContract(toInputs(parsed, token), deps);

  write(parsed.json ? stringifyReport(result.report) : renderText(result.report));

  // I2: an error is never a green run, and it is louder than a plain failure.
  if (result.report.status === "error") return 2;
  return result.exitCode === 0 ? 0 : 1;
}

/** Process wiring: builds real deps, writes to stdout, sets `process.exitCode`. */
export async function cliMain(): Promise<void> {
  const slug = (process.env["GITHUB_REPOSITORY"] ?? "").split("/");
  const deps: RunDeps = {
    fetch: (input, init) => globalThis.fetch(input, init),
    fs: nodeFileSystem,
    async writeFile(file: string, content: string): Promise<void> {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, content, "utf8");
    },
    env: process.env,
    cwd: process.cwd(),
    github: {
      eventName: "local",
      repo: { owner: slug[0] ?? "", repo: slug[1] ?? "" },
      sha: process.env["GITHUB_SHA"] ?? "",
      defaultBranch: "main",
      prNumber: null,
      listComments: async () => [],
      createComment: async (_pr: number, body: string) => ({ id: 0, body }),
      updateComment: async (id: number, body: string) => ({ id, body }),
    },
    // Diagnostics go to stderr so `--json` stdout stays machine-readable.
    logger: {
      info: (message) => console.error(message),
      warning: (message) => console.error(`warning: ${message}`),
      error: (message) => console.error(`error: ${message}`),
      debug: () => undefined,
    },
    outputs: { setOutput: () => undefined },
    summary: { write: async () => undefined },
    annotations: { emit: () => undefined },
  };

  process.exitCode = await cli(process.argv.slice(2), deps, (line) => console.log(line));
}

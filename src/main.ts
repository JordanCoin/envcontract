/**
 * SPEC: docs/SPEC.md — Module E. The Action entry point: builds real
 * dependencies and hands them to `runEnvContract`. No logic lives here.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";

import {
  INPUT_NAMES,
  runEnvContract,
  type GitHubDeps,
  type Inputs,
  type IssueComment,
  type RunDeps,
} from "./run.js";
import { nodeFileSystem } from "./scanner/files.js";

/** Reads every action.yml input through `@actions/core`. */
export function readInputs(): Inputs {
  const raw: Record<string, string> = {};
  for (const name of INPUT_NAMES) raw[name] = core.getInput(name);
  return raw as unknown as Inputs;
}

type Octokit = ReturnType<typeof github.getOctokit>;

function buildGitHub(token: string): GitHubDeps {
  const context = github.context;
  const payload = context.payload as {
    pull_request?: { number?: number };
    repository?: { default_branch?: string };
  };

  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const prNumber = payload.pull_request?.number ?? null;

  let octokit: Octokit | null = null;
  const client = (): Octokit => {
    if (octokit === null) {
      if (token === "") throw new Error("No github_token was provided.");
      octokit = github.getOctokit(token);
    }
    return octokit;
  };

  // Outside a real workflow these context fields are simply absent, whatever
  // their declared type says, so every one of them gets a floor here.
  return {
    eventName: context.eventName ?? "",
    repo: { owner, repo },
    sha: context.sha ?? "",
    defaultBranch: payload.repository?.default_branch ?? "main",
    prNumber,
    async listComments(issueNumber: number): Promise<IssueComment[]> {
      // Paginate: on a busy pull request the sticky comment is often past the
      // first page, and missing it would post a duplicate report every run.
      const octo = client();
      const comments = await octo.paginate(octo.rest.issues.listComments, {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
      });
      return comments.map((comment) => ({ id: comment.id, body: comment.body ?? "" }));
    },
    async createComment(issueNumber: number, body: string): Promise<IssueComment> {
      const response = await client().rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      return { id: response.data.id, body: response.data.body ?? body };
    },
    async updateComment(commentId: number, body: string): Promise<IssueComment> {
      const response = await client().rest.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
      });
      return { id: response.data.id, body: response.data.body ?? body };
    },
  };
}

/** Real `fetch`, real filesystem, real `@actions/core` + `@actions/github` writers. */
export async function buildDeps(): Promise<RunDeps> {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    fs: nodeFileSystem,
    async writeFile(file: string, content: string): Promise<void> {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, content, "utf8");
    },
    env: process.env,
    cwd: process.cwd(),
    github: buildGitHub(core.getInput("github_token")),
    logger: {
      info: (message) => core.info(message),
      warning: (message) => core.warning(message),
      error: (message) => core.error(message),
      debug: (message) => core.debug(message),
    },
    outputs: { setOutput: (name, value) => core.setOutput(name, value) },
    summary: {
      async write(markdown: string): Promise<void> {
        await core.summary.addRaw(markdown, true).write();
      },
    },
    annotations: {
      emit: (annotation) => {
        const properties = {
          title: annotation.title,
          file: annotation.file,
          startLine: annotation.line,
        };
        if (annotation.level === "error") core.error(annotation.message, properties);
        else if (annotation.level === "warning") core.warning(annotation.message, properties);
        else core.notice(annotation.message, properties);
      },
    },
  };
}

/** Runs the action and sets `process.exitCode`. Never throws. */
export async function main(): Promise<void> {
  try {
    const inputs = readInputs();

    // I2: no token means no answer, and no answer is never a pass.
    if (inputs.vercel_token.trim() === "") {
      core.setFailed("vercel_token is required. Pass it with `with: vercel_token: ${{ secrets.VERCEL_TOKEN }}`.");
      process.exitCode = 1;
      return;
    }

    const deps = await buildDeps();
    const result = await runEnvContract(inputs, deps);

    if (result.exitCode !== 0) {
      const missing = result.outputs.missing;
      core.setFailed(
        result.report.status === "error"
          ? "EnvContract could not verify this environment. See the error above."
          : `EnvContract: ${result.report.counts.missing} required variable(s) missing from ${result.report.target}${missing === "" ? "" : ` (${missing})`}.`,
      );
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    // Nothing below this line may throw a stack trace at a workflow log.
    core.setFailed(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();

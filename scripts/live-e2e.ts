import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AccountResolver } from "../src/auth/account-resolver.js";
import { PlatformCredentialStore } from "../src/auth/platform-credential-store.js";
import { ConfigRepository } from "../src/config/config-repository.js";
import { resolveConfigPath } from "../src/config/paths.js";
import { redactString } from "../src/core/redaction.js";
import { ForgejoHttpClient } from "../src/http/forgejo-http-client.js";
import { createLiveFixture, fixtureTarget } from "./live-fixture.js";

const { values } = parseArgs({
  options: {
    host: { type: "string" },
    repo: { type: "string" },
    confirm: { type: "string" },
    runner: { type: "string", default: "ubuntu-latest" },
  },
});
const target = fixtureTarget(values.host ?? "", values.repo ?? "", values.confirm ?? "");
const runner = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
  .parse(values.runner);
const artifact = resolve(import.meta.dir, "../dist/bin/forgejo.js");
assert(await Bun.file(artifact).exists(), "Run bun run build before live E2E tests.");
const steps: string[] = [];
const report: { repository: string; steps: string[]; pullRequest?: number; runs: number[] } = {
  repository: `${target.origin}/${target.repository}`,
  steps,
  runs: [],
};
const envelope = z.object({
  schema_version: z.literal("1"),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string() }).optional(),
});
const prSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  merged: z.boolean(),
  head: z.object({ sha: z.string() }),
  htmlUrl: z.string(),
});
const temporaryDirectory = await mkdtemp(join(tmpdir(), "forgejo-cli-live-"));
let commands = 0;

function passed(name: string): void {
  steps.push(name);
  process.stderr.write(`PASS ${name}\n`);
}

async function cli(args: readonly string[], expectedExit = 0, input = "", human = false) {
  commands += 1;
  const child = Bun.spawn(
    [process.execPath, artifact, "--host", target.origin, "--repo", target.repository, ...args],
    {
      cwd: temporaryDirectory,
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(
    exitCode,
    expectedExit,
    `${args.join(" ")} exited ${exitCode}: ${redactString(stdout)}`,
  );
  if (human) return { data: undefined, stdout, stderr };
  assert.equal(stdout.trim().split("\n").length, 1, "stdout must be exactly one JSON document");
  const result = envelope.parse(JSON.parse(stdout));
  assert.equal(result.ok, expectedExit === 0 || expectedExit === 10 || expectedExit === 11);
  return { data: result.data, stdout, stderr };
}

async function localGit(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd: temporaryDirectory,
    stdout: "ignore",
    stderr: "pipe",
  });
  assert.equal(await child.exited, 0, "Unable to prepare the isolated local branch fixture.");
}

async function cancelledWatch(number: string): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      artifact,
      "--host",
      target.origin,
      "--repo",
      target.repository,
      "pr",
      "checks",
      number,
      "--watch",
    ],
    {
      cwd: temporaryDirectory,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const interruptOnProgress = async () => {
      let interrupted = false;
      for await (const _chunk of child.stderr) {
        if (!interrupted) {
          interrupted = true;
          child.kill("SIGINT");
        }
      }
      return interrupted;
    };
    const [exitCode, stdout, interrupted] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      interruptOnProgress(),
    ]);
    assert(interrupted, "Watch did not report progress before cancellation.");
    assert.equal(exitCode, 130);
    assert.equal(stdout.trim().split("\n").length, 1);
    assert.equal(envelope.parse(JSON.parse(stdout)).error?.code, "cancelled");
  } finally {
    clearTimeout(watchdog);
  }
}

try {
  const account = await new AccountResolver({
    accounts: new ConfigRepository(resolveConfigPath(process.env)),
    credentials: new PlatformCredentialStore(),
  }).resolve({ origin: target.origin, explicitHost: target.origin, environment: process.env });
  const api = new ForgejoHttpClient({ origin: target.origin, token: account.token });
  const fixture = await createLiveFixture(api, target);
  passed("created and verified dedicated private repository");
  const path = ["repos", fixture.owner, fixture.name];
  await api.request({ method: "PATCH", path, body: { has_actions: true } });
  const writeFile = async (name: string, content: string, branch = "main", newBranch?: string) =>
    api.request({
      method: "POST",
      path: [...path, "contents", ...name.split("/")],
      body: {
        branch,
        content: Buffer.from(content).toString("base64"),
        message: `test: add ${name}`,
        ...(newBranch ? { new_branch: newBranch } : {}),
      },
    });
  await writeFile(
    ".forgejo/workflows/pass.yml",
    `name: CLI E2E pass\non:\n  pull_request:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  pass:\n    runs-on: ${runner}\n    timeout-minutes: 1\n    steps:\n      - run: printf '%s\\n' FORGEJO_CLI_E2E_PASS\n`,
  );
  await writeFile(
    ".forgejo/workflows/failure.yml",
    `name: CLI E2E expected failure\non:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  fail:\n    runs-on: ${runner}\n    timeout-minutes: 1\n    steps:\n      - run: |\n          printf '%s\\n' FORGEJO_CLI_E2E_EXPECTED_FAILURE\n          exit 7\n`,
  );
  await writeFile("e2e.txt", "Forgejo CLI E2E change\n", "main", "e2e-change");
  await localGit(["init", "--quiet", "--initial-branch=e2e-change"]);
  await localGit(["remote", "add", "origin", `${target.origin}/${target.repository}.git`]);
  passed("prepared isolated branches and harmless pass/failure workflows");

  const body = "First line\n\nSecond line with a tab:\tUnicode: Δ 🌊\n";
  const created = prSchema.parse(
    (
      await cli(
        [
          "pr",
          "create",
          "--title",
          "CLI E2E lifecycle",
          "--head",
          "e2e-change",
          "--base",
          "main",
          "--body-file",
          "-",
        ],
        0,
        body,
      )
    ).data,
  );
  report.pullRequest = created.number;
  const number = String(created.number);
  assert.equal(prSchema.parse((await cli(["pr", "view", number])).data).body, body);
  passed("PR create preserves multiline piped stdin and Unicode on readback");

  const comment = z
    .object({ id: z.number(), body: z.string() })
    .parse((await cli(["pr", "comment", number, "--body-stdin"], 0, body)).data);
  assert.equal(comment.body, body);
  const comments = z
    .object({ items: z.array(z.object({ id: z.number(), body: z.string() })) })
    .parse(
      (
        await cli([
          "api",
          `repos/${target.repository}/issues/${number}/comments`,
          "--paginate",
          "--max-items",
          "100",
        ])
      ).data,
    ).items;
  assert(comments.some((entry) => entry.id === comment.id && entry.body === body));
  passed("multiline PR comment persists and generic API reads it back");

  await cli(
    ["pr", "edit", number, "--title", "CLI E2E edited", "--body-file", "-"],
    0,
    `${body}Edited.\n`,
  );
  const edited = prSchema.parse((await cli(["pr", "view", number])).data);
  assert.equal(edited.title, "CLI E2E edited");
  assert.equal(edited.body, `${body}Edited.\n`);
  for (const selector of [[], ["e2e-change"], [edited.htmlUrl]]) {
    assert.equal(
      prSchema.parse((await cli(["pr", "view", ...selector])).data).number,
      created.number,
    );
  }
  passed("PR edit, numeric/branch/current-branch/URL selectors");

  const diff = z.object({ text: z.string() }).parse((await cli(["pr", "diff", number])).data);
  assert(diff.text.includes("e2e.txt"));
  const projected = (await cli(["--fields", "number,title", "pr", "view", number])).data;
  assert.deepEqual(projected, { number: created.number, title: "CLI E2E edited" });
  const table = await cli(["--human", "--fields", "number,title", "pr", "list"], 0, "", true);
  assert(table.stdout.includes("NUMBER") && table.stdout.includes("CLI E2E edited"));
  passed("diff, field selection and human tables");

  const countComments = async () =>
    z
      .array(z.unknown())
      .parse((await cli(["api", `repos/${target.repository}/issues/${number}/comments`])).data)
      .length;
  const before = await countComments();
  await cli(["--fields", "__proto__", "pr", "comment", number, "--body", "MUST NOT BE POSTED"], 2);
  assert.equal(await countComments(), before);
  await cli(["api", "https://example.com/steal"], 2);
  await cli(["pr", "view", `https://example.com/${target.repository}/pulls/${number}`], 2);
  passed("invalid fields and cross-host targets fail without mutation");

  await cli(["pr", "close", number]);
  assert.equal(prSchema.parse((await cli(["pr", "view", number])).data).state, "closed");
  await cli(["pr", "reopen"]);
  assert.equal(prSchema.parse((await cli(["pr", "view", number])).data).state, "open");
  passed("close and reopen with readback");

  const pending = () =>
    api.request({
      method: "POST",
      path: [...path, "statuses", edited.head.sha],
      body: {
        state: "pending",
        context: "forgejo-cli/e2e",
        description: "E2E pending-state fixture",
      },
    });
  await pending();
  assert.equal(
    z.object({ state: z.string() }).parse((await cli(["pr", "checks", number], 11)).data).state,
    "pending",
  );
  await cli(["pr", "checks", number, "--watch", "--timeout", "1", "--interval", "1"], 8);
  passed("pending checks are non-green and watch respects its deadline");
  await cancelledWatch(number);
  passed("SIGINT cancels a real watch with one JSON document and exit 130");
  await api.request({
    method: "POST",
    path: [...path, "statuses", edited.head.sha],
    body: {
      state: "success",
      context: "forgejo-cli/e2e",
      description: "E2E completed-state fixture",
    },
  });
  const checks = z
    .object({
      state: z.string(),
      head_sha: z.string(),
      required_checks_evaluated: z.literal(false),
    })
    .parse(
      (
        await cli([
          "pr",
          "checks",
          number,
          "--watch",
          "--workflow",
          "pass.yml",
          "--timeout",
          "360",
          "--interval",
          "2",
        ])
      ).data,
    );
  assert.equal(checks.state, "success");
  assert.equal(checks.head_sha, edited.head.sha);
  passed("PR checks watch the exact head and selected workflow to success");

  for (const [file, expectedExit, status] of [
    ["pass.yml", 0, "success"],
    ["failure.yml", 10, "failure"],
  ] as const) {
    const run = z
      .object({ number: z.number() })
      .parse((await cli(["workflow", "dispatch", file, "--ref", "main"])).data);
    report.runs.push(run.number);
    const watched = z
      .object({ status: z.string() })
      .parse(
        (
          await cli(
            [
              "run",
              "watch",
              String(run.number),
              "--exit-status",
              "--timeout",
              "360",
              "--interval",
              "2",
            ],
            expectedExit,
          )
        ).data,
      );
    assert.equal(watched.status, status);
    if (expectedExit === 10) {
      const failed = z
        .object({
          logs: z.array(z.object({ text: z.string(), job: z.object({ status: z.string() }) })),
        })
        .parse(
          (await cli(["run", "logs", String(run.number), "--failed", "--tail-bytes", "4096"])).data,
        );
      assert(failed.logs.length > 0);
      assert(
        failed.logs.every(
          (log) => log.job.status === "failure" && Buffer.byteLength(log.text) <= 4096,
        ),
      );
      assert(failed.logs.some((log) => log.text.includes("FORGEJO_CLI_E2E_EXPECTED_FAILURE")));
    }
    passed(
      `real workflow ${status}: watch exit status${expectedExit === 10 ? " and failed-job log tails" : ""}`,
    );
  }

  await cli(
    [
      "pr",
      "merge",
      number,
      "--squash",
      "--head-sha",
      "0".repeat(40),
      "--yes",
      "--confirm",
      `${target.repository}#pr:${number}`,
    ],
    6,
  );
  assert.equal(prSchema.parse((await cli(["pr", "view", number])).data).merged, false);
  await cli([
    "pr",
    "merge",
    number,
    "--squash",
    "--head-sha",
    edited.head.sha,
    "--yes",
    "--confirm",
    `${target.repository}#pr:${number}`,
  ]);
  assert.equal(prSchema.parse((await cli(["pr", "view", number])).data).merged, true);
  passed("stale-head merge rejected and confirmed exact-head squash merge read back");

  for (const shell of ["bash", "zsh", "fish"]) {
    const generated = await cli(["--human", "completion", shell], 0, "", true);
    assert(generated.stdout.includes("forgejo-cli"));
  }
  passed("completion generated for all supported shells");
  process.stdout.write(`${JSON.stringify({ ok: true, ...report, commands })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, ...report, commands, error: redactString(error instanceof Error ? error.message : "Live E2E failed") })}\n`,
  );
  process.exitCode = 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

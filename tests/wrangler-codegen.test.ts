import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateConfigFile, makeConfig, parseArgs, resolveAuthToken, validateWorkerName } from "../cf/wrangler-codegen.ts";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cf-gen-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

test("parses dry-run alongside config options", () => {
  expect(parseArgs([
    "--dry-run",
    "--account", "account-123",
    "--name", "example-worker",
    "--main", "src/worker.ts",
  ])).toEqual({
    accountId: "account-123",
    dryRun: true,
    force: false,
    main: "src/worker.ts",
    name: "example-worker",
    output: "wrangler.jsonc",
  });
});

test("renders a JSONC config with selected account and worker details", () => {
  const text = makeConfig({ id: "account-123", name: "Example account" }, "example-worker", "src/worker.ts");
  const config = JSON.parse(text.slice(text.indexOf("\n") + 1));

  expect(config).toMatchObject({
    account_id: "account-123",
    name: "example-worker",
    main: "src/worker.ts",
  });
  expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("validates Wrangler worker names", () => {
  expect(() => validateWorkerName("shop-api-v2")).not.toThrow();
  expect(() => validateWorkerName("bad_name")).toThrow();
  expect(() => validateWorkerName("-leading-dash")).toThrow();
});

test("uses CLOUDFLARE_API_TOKEN without calling Wrangler authentication commands", async () => {
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  const calls: string[][] = [];
  process.env.CLOUDFLARE_API_TOKEN = " test-api-token ";

  try {
    const auth = await resolveAuthToken("/project", {
      runWrangler: async (_projectDir, args) => {
        calls.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    expect(auth).toEqual({ type: "api_token", token: "test-api-token" });
    expect(calls).toEqual([]);
  } finally {
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousToken;
  }
});

test("checks Wrangler authentication when CLOUDFLARE_API_TOKEN is absent", async () => {
  const calls: string[][] = [];
  const auth = await resolveAuthToken("/project", {
    apiToken: "",
    runWrangler: async (_projectDir, args) => {
      calls.push(args);
      if (args[0] === "whoami") return { stdout: "{}", stderr: "", exitCode: 0 };
      return {
        stdout: JSON.stringify({ type: "oauth", token: "wrangler-token" }),
        stderr: "",
        exitCode: 0,
      };
    },
  });

  expect(calls).toEqual([["whoami", "--json"], ["auth", "token", "--json"]]);
  expect(auth).toEqual({ type: "oauth", token: "wrangler-token" });
});

test("fails the Wrangler auth check when no API token is available", async () => {
  await expect(resolveAuthToken("/project", {
    apiToken: "",
    runWrangler: async () => ({ stdout: "", stderr: "Not logged in", exitCode: 1 }),
  })).rejects.toThrow("Cloudflare is not authenticated in Wrangler");
});

test("dry-run reports a plan without creating the config file", async () => {
  const outputPath = join(testDir, "nested", "wrangler.jsonc");
  const result = await generateConfigFile(outputPath, "{\"name\":\"example\"}\n", true);

  expect(result).toEqual({ written: false, existed: false });
  expect(await Bun.file(outputPath).exists()).toBe(false);
});

test("dry-run leaves an existing config unchanged", async () => {
  const outputPath = join(testDir, "wrangler.jsonc");
  await Bun.write(outputPath, "original config\n");

  const result = await generateConfigFile(outputPath, "replacement config\n", true);

  expect(result).toEqual({ written: false, existed: true });
  expect(await Bun.file(outputPath).text()).toBe("original config\n");
});

test("writes the generated config when dry-run is disabled", async () => {
  const outputPath = join(testDir, "nested", "wrangler.jsonc");
  const result = await generateConfigFile(outputPath, "{\"name\":\"example\"}\n", false);

  expect(result).toEqual({ written: true, existed: false });
  expect(await Bun.file(outputPath).text()).toBe("{\"name\":\"example\"}\n");
});

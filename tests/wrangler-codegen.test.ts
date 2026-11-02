import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confirmOverwrite,
  defaultWorkerName,
  detectPackageManager,
  generateConfigFile,
  getWranglerAuthToken,
  isAuthFailure,
  listAccounts,
  makeConfig,
  parseArgs,
  resolveAuthToken,
  selectAccount,
  todayUtc,
  validateWorkerName,
  verifyAccount,
} from "../cf/wrangler-codegen.ts";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cf-gen-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

type FetchImpl = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;

/** Installs a fetch stub carrying the `preconnect` property `typeof fetch` requires. */
function stubFetch(impl: FetchImpl) {
  const previous = globalThis.fetch;
  globalThis.fetch = Object.assign(impl, { preconnect: () => {} }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

function membershipPage(accounts: Array<{ id: string; name: string }>, totalPages?: number) {
  return new Response(JSON.stringify({
    success: true,
    result: accounts.map((account) => ({ account, status: "accepted" })),
    ...(totalPages === undefined ? {} : { result_info: { total_pages: totalPages } }),
  }), { status: 200 });
}

function pageOf(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, name: `${prefix}-${index}` }));
}

const scriptedAsk = (answers: string[]) => {
  let index = 0;
  return async () => answers[index++] ?? "";
};

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

test("parses the secret-script escape hatch and deploy-key toggles", () => {
  expect(parseArgs(["--secret-script", "./scripts/secret-put.ts", "--deploy-keys"])).toMatchObject({
    secretScript: "./scripts/secret-put.ts",
    deployKeys: true,
  });
  expect(parseArgs(["--no-deploy-keys"])).toMatchObject({ deployKeys: false });
});

test("reports help and rejects malformed arguments", () => {
  expect(parseArgs(["--help"])).toBe("help");
  expect(parseArgs(["-h"])).toBe("help");
  expect(() => parseArgs(["--bogus"])).toThrow("Unknown option: --bogus");
  expect(() => parseArgs(["my-worker"])).toThrow("Unknown option: my-worker");
  expect(() => parseArgs(["--name"])).toThrow("Missing value for --name.");
  expect(() => parseArgs(["--name", "--dry-run"])).toThrow("Missing value for --name.");
  // A flag must not be swallowed as the previous option's value.
  expect(() => parseArgs(["--name", "-h"])).toThrow("Missing value for --name.");
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

test("dates the config in UTC so it is never ahead of Cloudflare's clock", () => {
  expect(todayUtc()).toBe(new Date().toISOString().slice(0, 10));

  const text = makeConfig({ id: "account-123", name: "Example" }, "example", "src/index.ts");
  const config = JSON.parse(text.slice(text.indexOf("\n") + 1));
  expect(config.compatibility_date).toBe(new Date().toISOString().slice(0, 10));
});

test("validates Wrangler worker names", () => {
  expect(() => validateWorkerName("shop-api-v2")).not.toThrow();
  expect(() => validateWorkerName("a".repeat(63))).not.toThrow();
  expect(() => validateWorkerName("bad_name")).toThrow();
  expect(() => validateWorkerName("-leading-dash")).toThrow();
  expect(() => validateWorkerName("trailing-dash-")).toThrow();
  expect(() => validateWorkerName("")).toThrow();
  // Cloudflare script names are lowercase and capped at 63 characters.
  expect(() => validateWorkerName("MyWorker")).toThrow("lowercase");
  expect(() => validateWorkerName("a".repeat(64))).toThrow("1-63 characters");
});

test("suggests a worker name that its own validator accepts", () => {
  for (const dir of ["/tmp/My Shop API", "/tmp/___", `/tmp/${"x".repeat(80)}`, "/tmp/-weird-"]) {
    expect(() => validateWorkerName(defaultWorkerName(dir))).not.toThrow();
  }
});

test("uses CLOUDFLARE_API_TOKEN directly without checking authentication", () => {
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = " test-api-token ";

  try {
    expect(resolveAuthToken()).toEqual({ type: "api_token", token: "test-api-token" });
  } finally {
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousToken;
  }
});

test("does not preflight Wrangler authentication when CLOUDFLARE_API_TOKEN is absent", () => {
  expect(resolveAuthToken("")).toBeUndefined();
});

test("reads saved Wrangler credentials only after an API request needs authentication", async () => {
  const calls: string[][] = [];
  const auth = await getWranglerAuthToken("/project", async (_projectDir, args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify({ type: "oauth", token: "wrangler-token" }),
      stderr: "",
      exitCode: 0,
    };
  });

  expect(calls).toEqual([["auth", "token", "--json"]]);
  expect(auth).toEqual({ type: "oauth", token: "wrangler-token" });
});

test("returns no saved Wrangler credential when authentication has not been configured", async () => {
  const auth = await getWranglerAuthToken("/project", async () => ({
    stdout: "",
    stderr: "Not logged in",
    exitCode: 1,
  }));
  expect(auth).toBeUndefined();
});

test("rejects unusable Wrangler authentication payloads", async () => {
  await expect(getWranglerAuthToken("/project", async () => ({
    stdout: "not json",
    stderr: "",
    exitCode: 0,
  }))).rejects.toThrow("unexpected authentication response");

  await expect(getWranglerAuthToken("/project", async () => ({
    stdout: JSON.stringify({ type: "magic" }),
    stderr: "",
    exitCode: 0,
  }))).rejects.toThrow("supported authentication method");
});

test("returns a manual account-selection fallback when membership listing is forbidden", async () => {
  const restore = stubFetch(async () => new Response("{}", { status: 403 }));

  try {
    const result = await listAccounts({ type: "api_token", token: "test-api-token" });
    expect(result).toEqual({ accounts: [], canList: false, unauthenticated: false });
  } finally {
    restore();
  }
});

test("recognizes unauthenticated account lookup before loading Wrangler credentials", async () => {
  let requestHeaders: Headers | undefined;
  const restore = stubFetch(async (_input, init) => {
    requestHeaders = new Headers(init?.headers);
    return new Response("{}", { status: 401 });
  });

  try {
    const result = await listAccounts();
    expect(result).toEqual({ accounts: [], canList: false, unauthenticated: true });
    expect(requestHeaders?.has("authorization")).toBe(false);
  } finally {
    restore();
  }
});

test("treats Cloudflare's HTTP 400 auth errors as unauthenticated", () => {
  // Verified against the live API: /memberships answers 400 + code 9106 for
  // both a missing and an invalid credential, never 401.
  expect(isAuthFailure(400, [{ code: 9106, message: "Missing X-Auth-Key, X-Auth-Email or Authorization headers" }])).toBe(true);
  expect(isAuthFailure(400, [{ code: 9106, message: "Authentication failed (status: 400)" }], true)).toBe(true);
  expect(isAuthFailure(401, [])).toBe(true);
  expect(isAuthFailure(403, [], false)).toBe(true);
  // A scoped token that simply lacks Memberships Read is signed in, not rejected.
  expect(isAuthFailure(403, [{ code: 9109, message: "Insufficient permissions" }], true)).toBe(false);
  expect(isAuthFailure(500, [{ code: 1, message: "Internal error" }], true)).toBe(false);
});

test("falls back to Wrangler credentials when Cloudflare rejects a missing credential with HTTP 400", async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({
    success: false,
    errors: [{ code: 9106, message: "Missing X-Auth-Key, X-Auth-Email or Authorization headers" }],
    result: null,
  }), { status: 400 }));

  try {
    expect(await listAccounts()).toEqual({ accounts: [], canList: false, unauthenticated: true });
  } finally {
    restore();
  }
});

test("reports an invalid API token as unauthenticated rather than a permission problem", async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({
    success: false,
    errors: [{ code: 9106, message: "Authentication failed (status: 400)" }],
    result: null,
  }), { status: 400 }));

  try {
    const result = await listAccounts({ type: "api_token", token: "not-a-real-token" });
    expect(result).toEqual({ accounts: [], canList: false, unauthenticated: true });
  } finally {
    restore();
  }
});

test("includes Cloudflare's explanation in an unexpected listing failure", async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({
    success: false,
    errors: [{ code: 7003, message: "Could not route to /memberships" }],
  }), { status: 500 }));

  try {
    await expect(listAccounts({ type: "api_token", token: "t" }))
      .rejects.toThrow("(HTTP 500): Could not route to /memberships.");
  } finally {
    restore();
  }
});

test("sends API key credentials as key and email headers", async () => {
  let requestHeaders: Headers | undefined;
  const restore = stubFetch(async (_input, init) => {
    requestHeaders = new Headers(init?.headers);
    return membershipPage([{ id: "a", name: "Account A" }], 1);
  });

  try {
    await listAccounts({ type: "api_key", key: "secret-key", email: "dev@example.com" });
    expect(requestHeaders?.get("x-auth-key")).toBe("secret-key");
    expect(requestHeaders?.get("x-auth-email")).toBe("dev@example.com");
    expect(requestHeaders?.has("authorization")).toBe(false);
  } finally {
    restore();
  }
});

test("pages through memberships and sorts the result by name", async () => {
  const pages = [
    membershipPage([...pageOf(49, "mid"), { id: "zz", name: "Zulu" }], 2),
    membershipPage([{ id: "aa", name: "Alpha" }], 2),
  ];
  let calls = 0;
  const restore = stubFetch(async () => pages[calls++]!);

  try {
    const result = await listAccounts({ type: "api_token", token: "t" });
    expect(calls).toBe(2);
    expect(result.canList).toBe(true);
    expect(result.accounts).toHaveLength(51);
    expect(result.accounts[0]).toEqual({ id: "aa", name: "Alpha" });
    expect(result.accounts.at(-1)).toEqual({ id: "zz", name: "Zulu" });
  } finally {
    restore();
  }
});

test("stops paging when a page adds no new accounts", async () => {
  const repeated = pageOf(50, "acct");
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return membershipPage(repeated, 10);
  });

  try {
    const result = await listAccounts({ type: "api_token", token: "t" });
    expect(calls).toBe(2);
    expect(result.accounts).toHaveLength(50);
  } finally {
    restore();
  }
});

test("caps paging when the API never reports a total page count", async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return membershipPage(pageOf(50, `page${calls}`));
  });

  try {
    const result = await listAccounts({ type: "api_token", token: "t" });
    expect(calls).toBe(100);
    expect(result.accounts).toHaveLength(5000);
  } finally {
    restore();
  }
});

test("surfaces Cloudflare error messages from a successful HTTP response", async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({
    success: false,
    errors: [{ message: "Invalid request headers" }],
  }), { status: 200 }));

  try {
    await expect(listAccounts({ type: "api_token", token: "t" })).rejects.toThrow("Invalid request headers");
  } finally {
    restore();
  }
});

test("resolves a supplied account ID to its real name", async () => {
  let requestedUrl = "";
  const restore = stubFetch(async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ success: true, result: { id: "abc123", name: "Example Org" } }), { status: 200 });
  });

  try {
    expect(await verifyAccount("abc123", { type: "api_token", token: "t" })).toEqual({
      id: "abc123",
      name: "Example Org",
    });
    expect(requestedUrl).toBe("https://api.cloudflare.com/client/v4/accounts/abc123");
  } finally {
    restore();
  }
});

test("rejects an account ID Cloudflare does not know", async () => {
  const restore = stubFetch(async () => new Response("{}", { status: 404 }));

  try {
    await expect(verifyAccount("typo", { type: "api_token", token: "t" })).rejects.toThrow("does not exist");
  } finally {
    restore();
  }
});

test("trusts a supplied account ID when the token cannot read account details", async () => {
  const restore = stubFetch(async () => new Response("{}", { status: 403 }));

  try {
    expect(await verifyAccount("abc123", { type: "api_token", token: "t" })).toBeUndefined();
  } finally {
    restore();
  }
});

test("skips account verification when there is no credential to verify with", async () => {
  let called = false;
  const restore = stubFetch(async () => {
    called = true;
    return new Response("{}", { status: 200 });
  });

  try {
    expect(await verifyAccount("abc123")).toBeUndefined();
    expect(called).toBe(false);
  } finally {
    restore();
  }
});

test("selects a requested account and rejects one outside the login", async () => {
  const accounts = [{ id: "a", name: "Alpha" }, { id: "b", name: "Bravo" }];
  expect(await selectAccount(accounts, "b")).toEqual({ id: "b", name: "Bravo" });
  await expect(selectAccount(accounts, "missing")).rejects.toThrow("is not available");
});

test("uses the only available account without prompting", async () => {
  expect(await selectAccount([{ id: "a", name: "Alpha" }], undefined)).toEqual({ id: "a", name: "Alpha" });
  await expect(selectAccount([], undefined)).rejects.toThrow("No accepted Cloudflare accounts");
});

test("re-prompts until an account number is in range", async () => {
  const accounts = [{ id: "a", name: "Alpha" }, { id: "b", name: "Bravo" }];
  const ask = scriptedAsk(["0", "3", "nonsense", "2"]);

  expect(await selectAccount(accounts, undefined, ask)).toEqual({ id: "b", name: "Bravo" });
});

test("requires a terminal to choose between multiple accounts", async () => {
  const accounts = [{ id: "a", name: "Alpha" }, { id: "b", name: "Bravo" }];
  await expect(selectAccount(accounts, undefined)).rejects.toThrow("needs an interactive terminal");
});

test("confirms before replacing an existing config", async () => {
  const path = join(testDir, "wrangler.jsonc");

  // Nothing to overwrite.
  await confirmOverwrite(path, false, scriptedAsk(["no"]));

  await Bun.write(path, "original\n");
  await confirmOverwrite(path, true, scriptedAsk(["no"]));
  await confirmOverwrite(path, false, scriptedAsk(["YES"]));
  await expect(confirmOverwrite(path, false, scriptedAsk(["no"]))).rejects.toThrow("Cancelled");
  await expect(confirmOverwrite(path, false, scriptedAsk([""]))).rejects.toThrow("Cancelled");
  await expect(confirmOverwrite(path, false)).rejects.toThrow("needs an interactive terminal");
});

test("detects the package manager from the manifest before the lockfile", async () => {
  await Bun.write(join(testDir, "package.json"), JSON.stringify({ packageManager: "pnpm@9.0.0" }));
  await Bun.write(join(testDir, "yarn.lock"), "");
  expect(await detectPackageManager(testDir)).toBe("pnpm");
});

test("detects the package manager from a lockfile and defaults to bun", async () => {
  await Bun.write(join(testDir, "package.json"), "{}");
  expect(await detectPackageManager(testDir)).toBe("bun");

  await Bun.write(join(testDir, "package-lock.json"), "{}");
  expect(await detectPackageManager(testDir)).toBe("npm");

  await Bun.write(join(testDir, "pnpm-lock.yaml"), "");
  expect(await detectPackageManager(testDir)).toBe("pnpm");
});

test("explains that cf-gen must run inside a JavaScript project", async () => {
  await expect(detectPackageManager(join(testDir, "nope"))).rejects.toThrow("No package.json found");
});

test("reports an unreadable manifest instead of guessing", async () => {
  await Bun.write(join(testDir, "package.json"), "{ not json");
  await expect(detectPackageManager(testDir)).rejects.toThrow("Could not read");
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

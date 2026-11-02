import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

type Account = { id: string; name: string };
type AuthToken =
  | { type: "api_token" | "oauth"; token: string }
  | { type: "api_key"; key: string; email: string };
type CloudflareError = { code?: number; message?: string };
type MembershipResponse = {
  success?: boolean;
  result?: Array<{ account?: { id?: string; name?: string }; status?: string }>;
  result_info?: { total_pages?: number };
  errors?: CloudflareError[];
};
type AccountResponse = {
  success?: boolean;
  result?: { id?: string; name?: string };
  errors?: CloudflareError[];
};

type Options = {
  accountId?: string;
  dryRun: boolean;
  envFile?: string;
  force: boolean;
  main?: string;
  name?: string;
  output: string;
  deployKeys?: boolean;
  secretScript?: string;
};
type PackageManager = "bun" | "npm" | "pnpm" | "yarn";
type Ask = (question: string) => Promise<string>;

// Cloudflare Worker script names: 1-63 characters, lowercase alphanumeric and dashes.
const maxWorkerNameLength = 63;
// Safety net so a malformed result_info cannot spin the membership pager forever.
const maxMembershipPages = 100;
const membershipPageSize = 50;
// Cloudflare answers /memberships with HTTP 400 (not 401) for both missing and
// invalid credentials, so the error code is what distinguishes "not signed in"
// from "signed in without permission".
const authErrorCodes = new Set([9103, 9106, 10000]);

const usage = `Usage: cf-gen [options]

Generate a Wrangler configuration in the current project.

Options:
  --account <id>       Use an account ID directly, skipping account discovery
  --name <name>        Worker name (prompted when omitted)
  --main <path>        Worker entrypoint (prompted when omitted)
  --output <path>      Output wrangler.jsonc path (default: ./wrangler.jsonc)
  --env-file <path>    .env file to upload as Worker secrets
  --secret-script <p>  Run this script instead of \`wrangler secret bulk\`
  --deploy-keys        Deploy secrets after generating the config
  --no-deploy-keys     Skip the deploy secrets prompt
  --dry-run            Preview the config without writing or deploying secrets
  --force              Replace an existing output file
  -h, --help           Show this help`;

export function parseArgs(args: string[]): Options | "help" {
  const options: Options = { dryRun: false, force: false, output: "wrangler.jsonc" };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return next;
    };

    switch (arg) {
      case "--account": options.accountId = value(); break;
      case "--env-file": options.envFile = value(); break;
      case "--main": options.main = value(); break;
      case "--name": options.name = value(); break;
      case "--output": options.output = value(); break;
      case "--secret-script": options.secretScript = value(); break;
      case "--deploy-keys": options.deployKeys = true; break;
      case "--no-deploy-keys": options.deployKeys = false; break;
      case "--dry-run": options.dryRun = true; break;
      case "--force": options.force = true; break;
      case "--help":
      case "-h": return "help";
      default: throw new Error(`Unknown option: ${arg}\n\n${usage}`);
    }
  }

  return options;
}

function wranglerPath(projectDir: string) {
  return join(projectDir, "node_modules", ".bin", "wrangler");
}

async function requireWranglerBinary(projectDir: string) {
  const executable = wranglerPath(projectDir);
  if (!(await Bun.file(executable).exists())) {
    throw new Error(`Wrangler is not installed in ${projectDir}.`);
  }
  return executable;
}

async function runWrangler(projectDir: string, args: string[]) {
  const executable = await requireWranglerBinary(projectDir);
  const child = Bun.spawn([executable, ...args], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
  const [out, err, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout: out, stderr: err, exitCode };
}

// Callers must release stdin (prompt.close()) before this runs; the child inherits the terminal.
async function runWranglerInteractive(projectDir: string, args: string[]) {
  const executable = await requireWranglerBinary(projectDir);
  const child = Bun.spawn([executable, ...args], {
    cwd: projectDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`wrangler ${args.join(" ")} failed with exit code ${exitCode}.`);
}

function isAuthToken(value: unknown): value is AuthToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Record<string, unknown>;
  return ((token.type === "api_token" || token.type === "oauth") && typeof token.token === "string")
    || (token.type === "api_key" && typeof token.key === "string" && typeof token.email === "string");
}

type WranglerRunner = (projectDir: string, args: string[]) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export function resolveAuthToken(apiToken = process.env.CLOUDFLARE_API_TOKEN): AuthToken | undefined {
  const token = apiToken?.trim();
  return token ? { type: "api_token", token } : undefined;
}

export async function getWranglerAuthToken(
  projectDir: string,
  runner: WranglerRunner = runWrangler,
): Promise<AuthToken | undefined> {
  const result = await runner(projectDir, ["auth", "token", "--json"]);
  if (result.exitCode !== 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Wrangler returned an unexpected authentication response.");
  }

  if (!isAuthToken(parsed)) throw new Error("Wrangler did not return a supported authentication method.");
  return parsed;
}

export async function detectPackageManager(projectDir: string): Promise<PackageManager> {
  const packagePath = join(projectDir, "package.json");
  if (!(await Bun.file(packagePath).exists())) {
    throw new Error(`No package.json found in ${projectDir}. Run cf-gen from a JavaScript project.`);
  }

  let packageManager: string | undefined;
  try {
    const manifest = JSON.parse(await Bun.file(packagePath).text()) as { packageManager?: unknown };
    if (typeof manifest.packageManager === "string") packageManager = manifest.packageManager.split("@")[0];
  } catch {
    throw new Error(`Could not read ${packagePath}.`);
  }

  if (packageManager === "bun" || packageManager === "npm" || packageManager === "pnpm" || packageManager === "yarn") {
    return packageManager;
  }

  const lockfiles: Array<[string, PackageManager]> = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ];
  for (const [lockfile, manager] of lockfiles) {
    if (await Bun.file(join(projectDir, lockfile)).exists()) return manager;
  }

  return "bun";
}

/** Returns whether Wrangler is usable in projectDir. A dry run reports instead of installing. */
async function ensureWrangler(projectDir: string, dryRun: boolean) {
  const installedPackage = join(projectDir, "node_modules", "wrangler", "package.json");
  const installedBinary = wranglerPath(projectDir);
  if (await Bun.file(installedPackage).exists() && await Bun.file(installedBinary).exists()) return true;

  const manager = await detectPackageManager(projectDir);
  if (dryRun) {
    console.log(`Dry run: Wrangler is missing from ${projectDir}; would install wrangler@latest with ${manager}.`);
    return false;
  }

  const managerPath = Bun.which(manager);
  if (!managerPath) throw new Error(`Cannot install Wrangler: ${manager} is not available on PATH.`);

  const installArgs: Record<PackageManager, string[]> = {
    bun: ["add", "--dev", "wrangler@latest"],
    npm: ["install", "--save-dev", "wrangler@latest"],
    pnpm: ["add", "--save-dev", "wrangler@latest"],
    yarn: ["add", "--dev", "wrangler@latest"],
  };

  console.log(`Wrangler is missing from ${projectDir}; installing the latest version with ${manager}...`);
  const child = Bun.spawn([managerPath, ...installArgs[manager]], {
    cwd: projectDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Installing Wrangler failed with exit code ${exitCode}.`);

  if (!(await Bun.file(installedPackage).exists()) || !(await Bun.file(installedBinary).exists())) {
    throw new Error(`The package manager completed, but Wrangler was not found in ${projectDir}/node_modules.`);
  }
  return true;
}

function authHeaders(auth?: AuthToken) {
  const headers = new Headers({ accept: "application/json" });
  if (auth?.type === "api_key") {
    headers.set("X-Auth-Key", auth.key);
    headers.set("X-Auth-Email", auth.email);
  } else if (auth) {
    headers.set("Authorization", `Bearer ${auth.token}`);
  }
  return headers;
}

export function isAuthFailure(status: number, errors: CloudflareError[] = [], hasAuth = false) {
  if (status === 401 || (!hasAuth && status === 403)) return true;
  if (errors.some((error) => error.code !== undefined && authErrorCodes.has(error.code))) return true;
  return errors.some((error) => /authenticat|x-auth-key|authorization header/i.test(error.message ?? ""));
}

export async function listAccounts(auth?: AuthToken): Promise<{
  accounts: Account[];
  canList: boolean;
  unauthenticated: boolean;
}> {
  const headers = authHeaders(auth);
  const accounts = new Map<string, Account>();
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= maxMembershipPages) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/memberships?status=accepted&per_page=${membershipPageSize}&page=${page}`, { headers });
    if (!response.ok) {
      const failure = await response.json().catch(() => undefined) as MembershipResponse | undefined;
      if (isAuthFailure(response.status, failure?.errors, Boolean(auth))) {
        return { accounts: [], canList: false, unauthenticated: true };
      }
      if (response.status === 403) return { accounts: [], canList: false, unauthenticated: false };
      const detail = failure?.errors?.map((error) => error.message).filter(Boolean).join("; ");
      throw new Error(`Could not list Cloudflare accounts (HTTP ${response.status})${detail ? `: ${detail}.` : "."} Check that this token can read memberships.`);
    }

    const body = await response.json() as MembershipResponse;
    if (!body.success) {
      const message = body.errors?.map((error) => error.message).filter(Boolean).join("; ");
      throw new Error(message || "Cloudflare rejected the account membership request.");
    }

    const results = body.result ?? [];
    const seenBefore = accounts.size;
    for (const membership of results) {
      const id = membership.account?.id;
      const name = membership.account?.name;
      if (id && name) accounts.set(id, { id, name });
    }

    // Stop when a page adds nothing new, so a stuck pager cannot loop.
    if (results.length === 0 || accounts.size === seenBefore) break;

    totalPages = body.result_info?.total_pages ?? (results.length === membershipPageSize ? page + 1 : page);
    page += 1;
  }

  return { accounts: [...accounts.values()].sort((a, b) => a.name.localeCompare(b.name)), canList: true, unauthenticated: false };
}

/**
 * Confirms a user-supplied account ID exists, returning its real name.
 * Returns undefined when the credential cannot read account details, so a
 * narrowly scoped token still works with --account.
 */
export async function verifyAccount(id: string, auth?: AuthToken): Promise<Account | undefined> {
  if (!auth) return undefined;

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(id)}`, {
    headers: authHeaders(auth),
  });
  if (response.status === 404) {
    throw new Error(`Cloudflare account ${id} does not exist or is not visible to this login.`);
  }
  if (!response.ok) return undefined;

  const body = await response.json().catch(() => undefined) as AccountResponse | undefined;
  if (!body?.success || !body.result?.id) return undefined;
  return { id: body.result.id, name: body.result.name || body.result.id };
}

function requireAsk(ask: Ask | undefined): Ask {
  if (!ask) {
    throw new Error("This step needs an interactive terminal. Supply the relevant CLI options and run from a TTY.");
  }
  return ask;
}

/**
 * Owns the readline interface. Opened lazily and closed before any child
 * process inherits stdin, because two concurrent readers on the terminal
 * race and the parent swallows input meant for the child.
 */
function createPromptManager(interactive: boolean) {
  let rl: ReturnType<typeof createInterface> | undefined;
  const ask: Ask | undefined = interactive
    ? (question: string) => {
        rl ??= createInterface({ input: stdin, output: stdout });
        return rl.question(question);
      }
    : undefined;

  return {
    ask,
    close: () => {
      rl?.close();
      rl = undefined;
    },
  };
}

export async function selectAccount(accounts: Account[], requestedId: string | undefined, ask?: Ask) {
  if (requestedId) {
    const match = accounts.find((account) => account.id === requestedId);
    if (!match) throw new Error(`Account ${requestedId} is not available to the current Cloudflare login.`);
    console.log(match.name === match.id ? `Selected account: ${match.id}` : `Selected account: ${match.name} (${match.id})`);
    return match;
  }

  if (accounts.length === 0) throw new Error("No accepted Cloudflare accounts are available to this login.");
  if (accounts.length === 1) {
    console.log(`Using your only available account: ${accounts[0]!.name} (${accounts[0]!.id})`);
    return accounts[0]!;
  }

  const prompt = requireAsk(ask);
  console.log("\nCloudflare accounts:");
  accounts.forEach((account, index) => console.log(`  ${index + 1}. ${account.name} (${account.id})`));

  while (true) {
    const answer = (await prompt("Select account number: ")).trim();
    const selection = Number(answer);
    if (Number.isInteger(selection) && selection >= 1 && selection <= accounts.length) {
      return accounts[selection - 1]!;
    }
    console.log(`Enter a number from 1 to ${accounts.length}.`);
  }
}

/**
 * Strips leading and trailing dashes in one linear pass. `/^-+|-+$/g` reads more
 * naturally but is quadratic: `-+$` is unanchored at the start, so an interior run
 * of dashes is retried from every position in the run.
 */
function trimDashes(value: string) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}

export function defaultWorkerName(projectDir: string) {
  const slug = trimDashes(basename(projectDir).toLowerCase().replace(/[^a-z0-9-]+/g, "-"));
  return trimDashes(slug.slice(0, maxWorkerNameLength)) || "my-worker";
}

async function defaultEntrypoint(projectDir: string) {
  for (const candidate of ["./src/index.ts", "./src/index.js", "./index.ts", "./index.js"]) {
    if (await Bun.file(resolve(projectDir, candidate)).exists()) return candidate;
  }
  return "./src/index.ts";
}

/**
 * Cloudflare account IDs are 32 hexadecimal characters. Checking the shape keeps an
 * API token pasted into CLOUDFLARE_ACCOUNT_ID from being printed and written into
 * wrangler.jsonc, which projects commit.
 */
export function validateAccountId(id: string) {
  if (!/^[0-9a-f]{32}$/i.test(id)) {
    throw new Error("A Cloudflare account ID is 32 hexadecimal characters. Check --account or CLOUDFLARE_ACCOUNT_ID — an API token is not an account ID.");
  }
}

export function validateWorkerName(name: string) {
  if (name.length > maxWorkerNameLength || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new Error(`Worker name must be 1-${maxWorkerNameLength} characters of lowercase letters, numbers, and dashes, and cannot start or end with a dash.`);
  }
}

/** Cloudflare resolves compatibility dates in UTC; a local date can land a day ahead. */
export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export async function confirmOverwrite(path: string, force: boolean, ask?: Ask) {
  if (!(await Bun.file(path).exists()) || force) return;
  const prompt = requireAsk(ask);
  const answer = (await prompt(`${path} already exists. Replace it? Type "yes" to continue: `)).trim().toLowerCase();
  if (answer !== "yes") throw new Error("Cancelled. Existing configuration was left unchanged.");
}

export function makeConfig(account: Account, name: string, main: string) {
  const config = {
    "$schema": "./node_modules/wrangler/config-schema.json",
    name,
    main,
    compatibility_date: todayUtc(),
    account_id: account.id,
  };

  return `// Generated by cf-gen. Review the entrypoint and compatibility date before deploying.\n${JSON.stringify(config, null, 2)}\n`;
}

export async function generateConfigFile(path: string, contents: string, dryRun: boolean) {
  const existed = await Bun.file(path).exists();
  if (!dryRun) {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, contents);
  }
  return { written: !dryRun, existed };
}

async function deploySecrets(envFileInput: string, configDir: string, scriptOption?: string) {
  const envFile = resolve(configDir, envFileInput);
  if (!(await Bun.file(envFile).exists())) throw new Error(`Env file not found: ${envFile}`);

  const scriptOverride = scriptOption ?? process.env.CF_GEN_SECRET_SCRIPT;
  if (scriptOverride) {
    const script = resolve(process.cwd(), scriptOverride);
    if (!(await Bun.file(script).exists())) throw new Error(`Secret uploader not found: ${script}`);

    // Name the setting rather than echoing its value, which came from the environment.
    const source = scriptOption ? "--secret-script" : "CF_GEN_SECRET_SCRIPT";
    console.log(`\nStarting the secret uploader from ${source} for ${envFile}...`);
    const child = Bun.spawn([process.execPath, script, envFile], {
      cwd: configDir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Secret upload stopped with exit code ${exitCode}.`);
    return;
  }

  // wrangler secret bulk reads KEY=VALUE .env files directly.
  console.log(`\nUploading secrets from ${envFile} with wrangler secret bulk...`);
  await runWranglerInteractive(configDir, ["secret", "bulk", envFile]);
}

async function main(args: string[]) {
  const parsedOptions = parseArgs(args);
  if (parsedOptions === "help") {
    console.log(usage);
    return;
  }
  const options = parsedOptions;
  if (basename(resolve(process.cwd(), options.output)) !== "wrangler.jsonc") {
    throw new Error("The output filename must be wrangler.jsonc so Wrangler can find it.");
  }

  const projectDir = dirname(resolve(process.cwd(), options.output));
  const wranglerAvailable = await ensureWrangler(projectDir, options.dryRun);

  let auth = resolveAuthToken();
  const apiTokenWasProvided = Boolean(auth);
  const prompt = createPromptManager(Boolean(stdin.isTTY && stdout.isTTY));
  const ask = prompt.ask;

  try {
    const configuredAccountId = options.accountId?.trim() || process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    let selectedAccountId = configuredAccountId;
    let accounts: Account[];

    if (configuredAccountId) {
      // A known account ID avoids the Memberships Read permission needed for account discovery.
      validateAccountId(configuredAccountId);
      const verified = await verifyAccount(configuredAccountId, auth);
      accounts = [verified ?? { id: configuredAccountId, name: configuredAccountId }];
    } else {
      let accountList = await listAccounts(auth);

      if (accountList.unauthenticated) {
        if (apiTokenWasProvided) {
          throw new Error("Cloudflare rejected CLOUDFLARE_API_TOKEN as unauthenticated. Check that the token is valid.");
        }
        if (!wranglerAvailable) {
          throw new Error("Wrangler is not installed and --dry-run will not install it. Set CLOUDFLARE_API_TOKEN, pass --account <id>, or re-run without --dry-run.");
        }

        auth = await getWranglerAuthToken(projectDir);
        if (auth) accountList = await listAccounts(auth);

        if (accountList.unauthenticated) {
          if (!ask) {
            throw new Error("Cloudflare returned unauthenticated. Run cf-gen in a terminal to sign in with Wrangler, or set CLOUDFLARE_API_TOKEN.");
          }

          console.log("Cloudflare returned unauthenticated. Starting Wrangler login...");
          prompt.close();
          await runWranglerInteractive(projectDir, ["login"]);
          auth = await getWranglerAuthToken(projectDir);
          if (!auth) throw new Error("Wrangler login completed without returning a usable credential.");
          accountList = await listAccounts(auth);
        }

        if (accountList.unauthenticated) {
          throw new Error("Cloudflare still returned unauthenticated after Wrangler login.");
        }
      }

      accounts = accountList.accounts;

      if (!accountList.canList) {
        if (!ask) {
          throw new Error("Could not list Cloudflare accounts (HTTP 403; token lacks Memberships Read). Pass --account <id> or set CLOUDFLARE_ACCOUNT_ID.");
        }

        console.log("This token cannot list account memberships. You can enter the account ID directly.");
        const accountId = (await ask("Cloudflare account ID: ")).trim();
        if (!accountId) throw new Error("An account ID is required when account membership listing is unavailable.");
        validateAccountId(accountId);
        selectedAccountId = accountId;
        const verified = await verifyAccount(accountId, auth);
        accounts = [verified ?? { id: accountId, name: accountId }];
      }
    }

    const account = await selectAccount(accounts, selectedAccountId, ask);

    const outputPath = resolve(process.cwd(), options.output);
    const configDir = dirname(outputPath);
    const suggestedName = defaultWorkerName(configDir);
    const workerName = options.name ?? (ask
      ? (await ask(`Worker name [${suggestedName}]: `)).trim() || suggestedName
      : suggestedName);
    const suggestedEntrypoint = await defaultEntrypoint(configDir);
    const entrypoint = options.main ?? (ask
      ? (await ask(`Worker entrypoint [${suggestedEntrypoint}]: `)).trim() || suggestedEntrypoint
      : suggestedEntrypoint);

    validateWorkerName(workerName);
    if (!(await Bun.file(resolve(configDir, entrypoint)).exists())) {
      console.warn(`Warning: entrypoint ${entrypoint} does not exist yet. Create it before deploying.`);
    }
    const configText = makeConfig(account, workerName, entrypoint);

    if (options.dryRun) {
      const result = await generateConfigFile(outputPath, configText, true);
      console.log(`Dry run: would ${result.existed ? "replace" : "write"} ${outputPath}`);
      console.log(configText);
      prompt.close();
      console.log("Dry run: skipped secret deployment.");
      return;
    }

    await confirmOverwrite(outputPath, options.force, ask);
    await generateConfigFile(outputPath, configText, false);
    console.log(`Generated ${outputPath}`);

    let shouldDeploy = options.deployKeys;
    if (shouldDeploy === undefined) {
      const answer = (await requireAsk(ask)("Deploy keys/secrets now? (y/N): ")).trim().toLowerCase();
      shouldDeploy = answer === "y" || answer === "yes";
    }

    if (!shouldDeploy) {
      prompt.close();
      console.log("Skipped secret deployment.");
      return;
    }

    let envFile = options.envFile;
    if (!envFile) {
      envFile = (await requireAsk(ask)("Env file to upload [./.env]: ")).trim() || ".env";
    }
    prompt.close();
    await deploySecrets(envFile, configDir, options.secretScript);
  } finally {
    prompt.close();
  }
}

export async function runCli(args = process.argv.slice(2)) {
  try {
    await main(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate Wrangler configuration.";
    console.error(message);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  void runCli();
}

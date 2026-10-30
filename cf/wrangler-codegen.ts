import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

type Account = { id: string; name: string };
type AuthToken =
  | { type: "api_token" | "oauth"; token: string }
  | { type: "api_key"; key: string; email: string };
type MembershipResponse = {
  success?: boolean;
  result?: Array<{ account?: { id?: string; name?: string }; status?: string }>;
  result_info?: { total_pages?: number };
  errors?: Array<{ message?: string }>;
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
};
type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

const usage = `Usage: cf-gen [options]

Generate a Wrangler configuration in the current project.

Options:
  --account <id>       Select an account by ID
  --name <name>        Worker name (prompted when omitted)
  --main <path>        Worker entrypoint (prompted when omitted)
  --output <path>      Output wrangler.jsonc path (default: ./wrangler.jsonc)
  --env-file <path>    .env file to pass to secret-put.ts
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
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return next;
    };

    switch (arg) {
      case "--account": options.accountId = value(); break;
      case "--env-file": options.envFile = value(); break;
      case "--main": options.main = value(); break;
      case "--name": options.name = value(); break;
      case "--output": options.output = value(); break;
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

async function runWrangler(projectDir: string, args: string[]) {
  const executable = join(projectDir, "node_modules", ".bin", "wrangler");
  if (!(await Bun.file(executable).exists())) {
    throw new Error(`Wrangler is not installed in ${projectDir}.`);
  }
  const child = Bun.spawn([executable, ...args], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
  const [out, err, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout: out, stderr: err, exitCode };
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

export async function resolveAuthToken(
  projectDir: string,
  options: { apiToken?: string; runWrangler?: WranglerRunner } = {},
): Promise<AuthToken> {
  const apiToken = (options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN)?.trim();
  if (apiToken) return { type: "api_token", token: apiToken };

  const runner = options.runWrangler ?? runWrangler;
  const identity = await runner(projectDir, ["whoami", "--json"]);
  if (identity.exitCode !== 0) {
    throw new Error("Cloudflare is not authenticated in Wrangler. Set CLOUDFLARE_API_TOKEN or run `wrangler login`.");
  }

  const result = await runner(projectDir, ["auth", "token", "--json"]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Wrangler has no usable Cloudflare authentication.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Wrangler returned an unexpected authentication response.");
  }

  if (!isAuthToken(parsed)) throw new Error("Wrangler did not return a supported authentication method.");
  return parsed;
}

async function detectPackageManager(projectDir: string): Promise<PackageManager> {
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

async function ensureWrangler(projectDir: string) {
  const installedPackage = join(projectDir, "node_modules", "wrangler", "package.json");
  const installedBinary = join(projectDir, "node_modules", ".bin", "wrangler");
  if (await Bun.file(installedPackage).exists() && await Bun.file(installedBinary).exists()) return;

  const manager = await detectPackageManager(projectDir);
  const command = manager;
  const managerPath = Bun.which(command);
  if (!managerPath) throw new Error(`Cannot install Wrangler: ${command} is not available on PATH.`);

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
}

async function listAccounts(auth: AuthToken): Promise<Account[]> {
  const headers = new Headers({ accept: "application/json" });
  if (auth.type === "api_key") {
    headers.set("X-Auth-Key", auth.key);
    headers.set("X-Auth-Email", auth.email);
  } else {
    headers.set("Authorization", `Bearer ${auth.token}`);
  }

  const accounts = new Map<string, Account>();
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/memberships?status=accepted&per_page=50&page=${page}`, { headers });
    if (!response.ok) {
      throw new Error(`Could not list Cloudflare accounts (HTTP ${response.status}). Check that this token can read memberships.`);
    }

    const body = await response.json() as MembershipResponse;
    if (!body.success) {
      const message = body.errors?.map((error) => error.message).filter(Boolean).join("; ");
      throw new Error(message || "Cloudflare rejected the account membership request.");
    }

    for (const membership of body.result ?? []) {
      const id = membership.account?.id;
      const name = membership.account?.name;
      if (id && name) accounts.set(id, { id, name });
    }

    totalPages = body.result_info?.total_pages ?? (body.result?.length === 50 ? page + 1 : page);
    page += 1;
  }

  return [...accounts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function requireInteractive() {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("This step needs an interactive terminal. Supply the relevant CLI options and run from a TTY.");
  }
}

function createPrompt() {
  const rl = createInterface({ input: stdin, output: stdout });
  return {
    ask: (question: string) => rl.question(question),
    close: () => rl.close(),
  };
}

async function selectAccount(accounts: Account[], requestedId: string | undefined, ask: (question: string) => Promise<string>) {
  if (requestedId) {
    const match = accounts.find((account) => account.id === requestedId);
    if (!match) throw new Error(`Account ${requestedId} is not available to the current Cloudflare login.`);
    console.log(`Selected account: ${match.name} (${match.id})`);
    return match;
  }

  if (accounts.length === 0) throw new Error("No accepted Cloudflare accounts are available to this login.");
  if (accounts.length === 1) {
    console.log(`Using your only available account: ${accounts[0]!.name} (${accounts[0]!.id})`);
    return accounts[0]!;
  }

  requireInteractive();
  console.log("\nCloudflare accounts:");
  accounts.forEach((account, index) => console.log(`  ${index + 1}. ${account.name} (${account.id})`));

  while (true) {
    const answer = (await ask("Select account number: ")).trim();
    const selection = Number(answer);
    if (Number.isInteger(selection) && selection >= 1 && selection <= accounts.length) {
      return accounts[selection - 1]!;
    }
    console.log(`Enter a number from 1 to ${accounts.length}.`);
  }
}

function defaultWorkerName(projectDir: string) {
  const slug = basename(projectDir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return (slug || "my-worker").slice(0, 63).replace(/-+$/g, "") || "my-worker";
}

async function defaultEntrypoint(projectDir: string) {
  for (const candidate of ["./src/index.ts", "./src/index.js", "./index.ts", "./index.js"]) {
    if (await Bun.file(resolve(projectDir, candidate)).exists()) return candidate;
  }
  return "./src/index.ts";
}

export function validateWorkerName(name: string) {
  if (name.length > 255 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name)) {
    throw new Error("Worker name must contain only letters, numbers, and dashes, and cannot start or end with a dash.");
  }
}

function todayLocal() {
  const date = new Date();
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function confirmOverwrite(path: string, force: boolean, ask: (question: string) => Promise<string>) {
  if (!(await Bun.file(path).exists()) || force) return;
  requireInteractive();
  const answer = (await ask(`${path} already exists. Replace it? Type "yes" to continue: `)).trim().toLowerCase();
  if (answer !== "yes") throw new Error("Cancelled. Existing configuration was left unchanged.");
}

export function makeConfig(account: Account, name: string, main: string) {
  const config = {
    "$schema": "./node_modules/wrangler/config-schema.json",
    name,
    main,
    compatibility_date: todayLocal(),
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

async function deployKeys(envFileInput: string, configDir: string) {
  const envFile = resolve(configDir, envFileInput);
  if (!(await Bun.file(envFile).exists())) throw new Error(`Env file not found: ${envFile}`);

  const script = join(homedir(), "Code", "shop", "scripts", "secret-put.ts");
  if (!(await Bun.file(script).exists())) throw new Error(`Secret uploader not found: ${script}`);

  console.log(`\nStarting ${script} for ${envFile}...`);
  const child = Bun.spawn([process.execPath, script, envFile], {
    cwd: configDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Secret upload stopped with exit code ${exitCode}.`);
}

async function main(args: string[]) {
  const parsedOptions = parseArgs(args);
  if (parsedOptions === "help") {
    console.log(usage);
    return;
  }
  const options = parsedOptions;
  if (basename(resolve(process.cwd(), options.output)) !== "wrangler.jsonc") {
    throw new Error("The output filename must be wrangler.jsonc so Wrangler and secret-put.ts can find it.");
  }

  const projectDir = dirname(resolve(process.cwd(), options.output));
  await ensureWrangler(projectDir);

  // Wrangler's JSON mode exits non-zero when the current credentials are missing or invalid.
  const auth = await resolveAuthToken(projectDir);
  const accounts = await listAccounts(auth);
  const hasPrompt = stdin.isTTY && stdout.isTTY;
  const ask = hasPrompt ? createPrompt() : undefined;
  let promptClosed = false;
  const closePrompt = () => {
    if (!promptClosed) {
      ask?.close();
      promptClosed = true;
    }
  };

  try {
    const account = await selectAccount(accounts, options.accountId, ask?.ask ?? (async () => {
      throw new Error("Multiple Cloudflare accounts are available. Use --account <id> to select one in a non-interactive terminal.");
    }));

    const currentDir = process.cwd();
    const outputPath = resolve(currentDir, options.output);
    const configDir = dirname(outputPath);
    const suggestedName = defaultWorkerName(configDir);
    const workerName = options.name ?? (hasPrompt
      ? (await ask!.ask(`Worker name [${suggestedName}]: `)).trim() || suggestedName
      : suggestedName);
    const entrypoint = options.main ?? (hasPrompt
      ? (await ask!.ask(`Worker entrypoint [${await defaultEntrypoint(configDir)}]: `)).trim() || await defaultEntrypoint(configDir)
      : await defaultEntrypoint(configDir));

    validateWorkerName(workerName);
    const configText = makeConfig(account, workerName, entrypoint);

    if (options.dryRun) {
      const result = await generateConfigFile(outputPath, configText, true);
      console.log(`Dry run: would ${result.existed ? "replace" : "write"} ${outputPath}`);
      console.log(configText);
      closePrompt();
      console.log("Dry run: skipped secret deployment.");
      return;
    }

    await confirmOverwrite(outputPath, options.force, ask?.ask ?? (async () => "no"));
    await generateConfigFile(outputPath, configText, false);
    console.log(`Generated ${outputPath}`);

    let shouldDeploy = options.deployKeys;
    if (shouldDeploy === undefined) {
      requireInteractive();
      const answer = (await ask!.ask("Deploy keys/secrets now? (y/N): ")).trim().toLowerCase();
      shouldDeploy = answer === "y" || answer === "yes";
    }

    if (!shouldDeploy) {
      closePrompt();
      console.log("Skipped secret deployment.");
      return;
    }

    let envFile = options.envFile;
    if (!envFile) {
      requireInteractive();
      envFile = (await ask!.ask("Env file to upload [./.env]: ")).trim() || ".env";
    }
    closePrompt();
    await deployKeys(envFile, configDir);
  } finally {
    closePrompt();
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

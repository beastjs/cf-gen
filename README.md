# @beastjs/cf-gen

Interactive CLI for generating a Cloudflare Workers `wrangler.jsonc` configuration.

## Requirements

- Bun 1.4 or newer
- A JavaScript project with a `package.json`
- `CLOUDFLARE_API_TOKEN`, or Wrangler authentication via `wrangler login`

The CLI uses `CLOUDFLARE_API_TOKEN` directly when it is set. Otherwise, it starts the account lookup without credentials. Only if Cloudflare rejects that request as unauthenticated does it load saved Wrangler credentials or start `wrangler login`. If the target project does not have Wrangler installed, `cf-gen` adds the latest Wrangler as a development dependency using the package manager selected by the project.

Some API tokens cannot list account memberships. In that case, provide the account ID with `--account <id>` or `CLOUDFLARE_ACCOUNT_ID`; an interactive run will prompt for the ID if account listing returns HTTP 403. A supplied account ID is confirmed against Cloudflare when the credential can read account details, so a typo is caught before the config is written.

## Install

```bash
npm install --global @beastjs/cf-gen
cd path/to/worker-project
cf-gen
```

The CLI checks authentication, lets you select a Cloudflare account, prompts for the Worker name and entrypoint, and writes `wrangler.jsonc`. It then asks whether to deploy secrets.

Use `--dry-run` to preview the generated config without writing it or deploying secrets. A dry run never modifies the project: if Wrangler is missing it reports what it would install instead of installing it.

## Deploying secrets

Answering yes to the secrets prompt uploads the chosen `.env` file with `wrangler secret bulk`, which reads `KEY=VALUE` files directly. Deleting a secret is not supported through a `.env` file; use `wrangler secret delete` for that.

To run your own uploader instead, pass `--secret-script <path>` or set `CF_GEN_SECRET_SCRIPT`. The script is invoked as `bun <script> <env-file>` from the config directory.

```bash
cf-gen --deploy-keys --env-file ./.env.production
cf-gen --deploy-keys --env-file ./.env --secret-script ./scripts/secret-put.ts
```

## Options

```text
--account <id>       Select an account by ID
--name <name>        Worker name (1-63 lowercase letters, numbers, dashes)
--main <path>        Worker entrypoint
--output <path>      Output wrangler.jsonc path
--env-file <path>    .env file to upload as Worker secrets
--secret-script <p>  Run this script instead of `wrangler secret bulk`
--deploy-keys        Deploy secrets after generating the config
--no-deploy-keys     Skip the deploy secrets prompt
--dry-run            Preview without writing or deploying secrets
--force              Replace an existing output file
-h, --help           Show help
```

The generated `compatibility_date` is today's date in UTC, so it is never ahead of Cloudflare's clock.

## Development

```bash
bun install
bun run cf:codegen
bun run test        # typecheck + tests
bun run typecheck
```

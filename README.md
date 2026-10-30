# @beastjs/cf-gen

Interactive CLI for generating a Cloudflare Workers `wrangler.jsonc` configuration.

## Requirements

- Bun 1.4 or newer
- A JavaScript project with a `package.json`
- `CLOUDFLARE_API_TOKEN`, or Wrangler authentication via `wrangler login`

If `CLOUDFLARE_API_TOKEN` is set, the CLI uses it directly and skips Wrangler's authentication check. Otherwise, it checks Wrangler authentication. If the target project does not have Wrangler installed, `cf-gen` adds the latest Wrangler as a development dependency using the package manager selected by the project.

## Install

```bash
npm install --global @beastjs/cf-gen
cd path/to/worker-project
cf-gen
```

The CLI checks authentication, lets you select a Cloudflare account, prompts for the Worker name and entrypoint, and writes `wrangler.jsonc`. It then asks whether to deploy keys. If you choose yes, it invokes `~/Code/shop/scripts/secret-put.ts` with the selected env file.

Use `--dry-run` to preview the generated config without writing it or deploying secrets. The Wrangler prerequisite check still runs, so a dry run may install Wrangler in the target project.

## Options

```text
--account <id>       Select an account by ID
--name <name>        Worker name
--main <path>        Worker entrypoint
--output <path>      Output wrangler.jsonc path
--env-file <path>    .env file to pass to secret-put.ts
--deploy-keys        Deploy secrets after generating the config
--no-deploy-keys     Skip the deploy secrets prompt
--dry-run            Preview without writing or deploying secrets
--force              Replace an existing output file
-h, --help           Show help
```

## Development

```bash
bun install
bun run cf:codegen
bun test
```

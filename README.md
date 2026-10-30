# cf-gen

Generate a Cloudflare Workers `wrangler.jsonc` file from the current project.

## Run

```bash
bun install
bun run cf:codegen
```

The CLI checks the target project for a local Wrangler install first. If missing, it adds the latest Wrangler as a development dependency using the project's package manager. It then checks authentication, lets you select an account, prompts for the Worker name and entrypoint, and writes `wrangler.jsonc`. Finally, it asks whether to deploy secrets. If you choose yes, it invokes `~/Code/shop/scripts/secret-put.ts` with the selected env file.

Pass `--dry-run` to preview the generated config without writing it or deploying secrets. The Wrangler prerequisite check still runs, so the CLI may install Wrangler if the target project does not have it yet.

Wrangler must be authenticated first. Run `bunx wrangler login` if needed.

Options are available with:

```bash
bun run cf:codegen -- --help
```

Run the tests with:

```bash
bun test
```

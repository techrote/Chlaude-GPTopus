# Development and contributing

[← Overview](README.md) · [Architecture](docs/ARCHITECTURE.md)

The plugin is dependency-free Node.js ESM plus Windows PowerShell scripts. Keep the two-key boundary, local quota ledger and permission-based tool execution intact.

## Run tests

```bash
cd plugins/openai-workers
npm test
```

The suite covers actual mod event handling with mocks, MCP transport health, Response payload shapes, tier selection, strict key profile routing and quota accounting, concurrency, persistence and midnight UTC behaviour. The tests do **not** call a live OpenAI API. Live validation must be conducted separately on the target Claude Code version.

On Windows, also run:

```powershell
claude plugin validate .\plugins\openai-workers
claude plugin validate .
```

## Adding or changing an agent

1. Add the new type, model ID, tier and description in `hooks/register.js`.
2. Confirm `keyProfileForWorker()` in `bridge/openai.mjs` selects **free** only for the daily/free-agent family. Never invent a silent fallback.
3. If a free worker's model changes, review the model-group allowlist in `bridge/usage.mjs` and verify against current OpenAI documentation.
4. Update `set-worker-tier.ps1`, this repository's docs and the plugin README.
5. Add tests for registration, tier, key routing, continuation, and quota reservation (when applicable).
6. Run automated tests and a real, read-only Claude Code smoke test before calling the release qualified.

## Principles

Never commit `.dpapi`, `.env`, `free-usage-ledger.json` or any credential output. Avoid changing API prices without sources and effective-date notes. Validate user-supplied model/tier names. Preserve calls through Claude Code's own tool permission boundary. Report what was actually tested versus mocked.


## Desktop extension

Worker defaults live in `plugins/openai-workers/bridge/workers.mjs`, shared by the native Code mod and Chat MCP facade. The MCP stdio facade is `plugins/openai-workers/bridge/desktop-server.mjs`, with protocol/packaging tests in `tests/desktop.test.mjs`. The extension source manifest is `desktop-extension/manifest.json`.

Build the distributable bundle from the repository root with `node scripts/build-desktop.mjs`. The reproducible `.mcpb` (ZIP) contains no third-party Node modules. Run `npm test` in the plugin folder, and manually install the `.mcpb` in Claude Desktop before claiming graphical end-to-end validation. The Chat extension intentionally does not offer file or shell tools.

CI verifies that the committed `.mcpb` is byte-for-byte reproducible from its reviewed source. If bundle inputs change, run `node scripts/build-desktop.mjs` and commit the regenerated artifact; never bypass the reproducibility check.

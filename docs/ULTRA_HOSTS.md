# ULTRA host interfaces and project-access boundary

## Qualification status

This interface investigation used the official Claude Code documentation and
the official `anthropics/claude-code` mods declarations on 2026-11-21. The
declarations retrieved from `mods/types/claude-code.d.ts` had Git blob identity
`85729df6231501d7554d8a05fc530badcfff83d9`.

The implementation environment did **not** have a `claude` executable or a
running Claude Desktop installation. Documentation inspection, deterministic
adapter tests, and MCP protocol tests are not live host qualification. The
Windows owner evaluator must record both the Desktop version and the Code
runtime version, run the installed host's plugin validation/tests, and exercise
the UI before those integrations can be called accepted.

Claude Code writes declarations for the installed runtime under
`.claude-plugin/types/claude-code/index.d.ts`. Those declarations take precedence
over the repository's published copy. `claude plugin validate` uses the host's
static analysis; `claude plugin test` exercises a mod using the actual host's
test runtime without signing in or spending API credits. See the official
[mod authoring and validation guide](https://code.claude.com/docs/en/plugins/mods/create)
and [mods reference](https://code.claude.com/docs/en/plugins/mods/reference).

## Supported adaptation points

| Requirement | Actual supported interface | Enforcement detail |
|---|---|---|
| Primary Claude identity | Main-loop `turn.step.model`, root `agent.spawn.parentModel`, and `$.session.model()` | Use the effective step/fallback and pinned root parent identity ahead of the configured `/model` label. A descendant's inherited Claude placeholder must not upgrade root authority. |
| Host compatibility | `$.session.version()`, `$.session.info()` | Record runtime version, platform and hosting. Refuse unsupported protected mode. |
| Host surface | `$.session.surfaces()` (documented as every surface the session draws on: `terminal` first, then attached remote ones) | Forwarded at init and recorded in the mission. `terminal` selects `surfaces.codeCli`, `desktop` selects `surfaces.desktopCode`; empty, other or mixed values are an unknown surface with the think-only ceiling. |
| Spawn gate | `agent.spawn` hook | `parentModel` and `parentAgentId` are pinned host facts. A hook may return `{ deny }` before `next`. |
| Child identity | Result of `next(e)` at `agent.spawn` | Successful result carries `agentId`; bind that host ID to the durable ULTRA job. |
| Native recursive spawning | `$.agent.spawn({ prompt, subagentType, parentAgentId, ... })`, or the native `Agent` tool | Preserve the parent ID and the host's own restrictions. An omitted parent creates a main-level child, so adapters must never omit a known parent. |
| Native tool dispatch retaining permission checks | `$.agent.call({ tool, input, agentId }, { signal })` | Runs with that agent's tools, folder, mode and rules; use this if the adapter must dispatch a tool itself. |
| Native tree and running state | `$.agent.list()` | Gives `id`, `parentId`, `type`, `model`, and status including `waiting` and `idle`. |
| Model step replacement | `turn.step` async-generator hook | Existing OpenAI worker adapter can answer a step without invoking a Claude model. |
| Tool admission | `tool.check` | `e.agentId` identifies the calling subagent; available from Code 2.1.290. Only tighten the native decision. |
| Last preexecution gate | `tool.run` | Available from Code 2.1.326. Revalidate the immutable action and policy before execution. |
| Human confirmation | Local interactive ULTRA CLI | The current adapter does not turn a caller string or slash-command argument into a human vote. The CLI shows the exact request and requires an interactive terminal confirmation. |
| Completion/cancellation | `turn.complete`, `session.stop`, agent status | Preserve results and reconcile durable reservations; do not assume interrupted work was never billed. |

The minimum version for an adapter relying on the last preexecution hook is
**Claude Code 2.1.326**. That version is a compatibility prerequisite, not proof
that every adapter has been exercised on the user's installation. The native
adapter must also verify that the required APIs are present.

An OpenAI worker's native host model may still be inherited from Claude while
its requests are intercepted by `turn.step`. Therefore the recruitment policy
must obtain the worker's actual OpenAI family, model, key route, and service
tier from its ULTRA allocation. It must not mistake the inherited native
placeholder model for the worker's actual capability rank.

Claude Code supports nested subagents. Its default depth is three layers below
the main conversation; `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` controls this.
`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` controls the host concurrency limit,
normally 20. These are independent host ceilings; they do not implement ULTRA's
Core/Review populations, protected supervisor slot, or shared spending budget.
ULTRA must enforce its own limits as well. See
[the official subagent guide](https://code.claude.com/docs/en/sub-agents).

Resuming an existing agent raises `agent.spawn` with `resume.agentId` on
supported versions. A resume is not a new population allocation, and attempts
to rewrite its model are ignored by the host. Recheck scope and reservations
for the existing identity instead of silently making a second allocation.

## Host restrictions that affect safety

Mods run in an isolated JavaScript environment with **no Node imports**, no
`require`, and no dynamic `import()`. Use static ES imports inside the plugin
and the explicit `$.fs`, `$.process`, `$.mcp` and other supported APIs. Keep
Node filesystem modules in the bridge, not in a file imported by a mod.

Do not dispatch a worker's tools using `$.tool.call`: the official declarations
state that a plugin's call uses different permission semantics, including
turning asks into allows. Preserve the existing `turn.step`-emitted native
tool calls, or use `$.agent.call` for that specific agent. Adding a custom
recruitment tool is supported through `$.tool.register({ name, description,
inputSchema, isDeferred })`; its exposed name is
`mcp__<plugin>__<name>`. The implemented scoped tools are served at **`tool.run`
after native permission checks**, as the official `ToolSpec` contract permits.
The current native
recruitment tool is named `Agent`, with `subagent_type`, `prompt`,
`description`, and optional `run_in_background` inputs.

The host's static analysis requires literal event names and explicit API calls
such as `$.session.model()`. Passing `$` to a top-level helper in the same module
is supported. Passing `$` to an imported helper, aliasing its namespaces, or
using computed API method names can fail validation. A generic JavaScript mock
does not prove that a module passes this analysis.

**A mod hook that throws or times out is normally skipped.** Every admission or
execution guard needs a registration-level `.catch` handler that returns the
event's refusal shape. A `try/catch` inside the handler does not cover host
timeouts. For example:

```js
on('agent.spawn', async ($, e, next) => {
  const decision = await evaluateWithTrustedHostFacts($, e);
  if (!decision.allowed) return { deny: decision.reason };
  return next(e);
}).catch(() => ({ deny: 'ULTRA admission unavailable; recruitment held.' }));

on('tool.check', async ($, e, next) => {
  const native = await next(e);
  if (native.decision === 'deny') return native;
  const decision = await checkUltraScope($, e);
  return decision.allowed ? native : { decision: 'deny', reason: decision.reason };
}).catch(() => ({ decision: 'deny', reason: 'ULTRA tool policy unavailable.' }));
```

These are illustrative API shapes, not a standalone adapter. The registration
must remain in the hook module so the host can analyse it.

In a registration-level `.catch`, the documented `next.called` path is
**replay-safe**: `next(e)` returns the already settled result and does not run
the underlying spawn/tool twice. This differs from making a second ordinary
tool call. A spawn that already succeeded cannot be undone by returning a late
deny. The adapter preserves that host outcome and holds any child whose durable
binding could not be established.

Code Mode's own script entry point is a special case: wildcard tool hooks do
not receive it. The adapter registers literal `{ tool: 'REPL' }` guards at
`tool.call`, `tool.check` and `tool.run`, each with a fail-closed `.catch`.
Code Mode script execution is unavailable in protected ULTRA mode. A tool-list
filter alone cannot remove Code Mode's own tools. Installed-host qualification
must inspect any newer mode-specific execution tools before enabling them.

A `tool.call` guard runs before permission checks; `tool.run` runs after an
allowed call reaches the execution boundary. Refusing after `await next(e)` in
a tool execution hook does not undo a completed action. The `isReadOnly` field
is the tool's own claim; it does not prove that an agent, network request or
MCP operation is harmless. See
[the official event and failure-handling reference](https://code.claude.com/docs/en/plugins/mods/events).

## Desktop, cloud and WSL

| Environment | Status and practical limitation |
|---|---|
| CLI native local session | Mods and native subagents are documented. Validate installed runtime and plugin before enabling ULTRA. |
| Desktop Code local session | Mods are documented. Desktop has its own bundled Code runtime; obtain its version using `/status`. |
| Desktop Code WSL session | The current official Desktop documentation says plugins are unavailable. The native ULTRA mod is therefore unavailable there. |
| Standalone CLI running inside WSL | This is a CLI environment, not Desktop's WSL integration. Validate separately; Windows DPAPI credentials are not automatically Linux credentials. |
| Desktop cloud session | Desktop-installed local plugins do not carry over, and the current Desktop page says repository `enabledPlugins` do not install them. Treat ULTRA as unavailable unless the runtime actually loads and qualifies it. |
| Desktop Chat | Local stdio MCP extension. It has no trusted primary-model attestation and cannot inherit native Code permissions. Use its server-owned project policy. |

The Desktop documentation changes over time, and older mirrors disagree about
cloud plugin installation. The implementation must probe actual capabilities
and report them rather than relying on a UI label. Desktop agent teams also
have different availability from native subagents; ULTRA does not require
agent-team APIs. See
[the official Desktop reference](https://code.claude.com/docs/en/desktop).

MCP 2026-07-28 uses per-request protocol metadata and `server/discover`;
2025-era clients use the `initialize` handshake. Retain both behaviours and
explicit unsupported-version errors. MCP `clientInfo`, server metadata, tool
annotations and caller-supplied model names are not authentication or approval
proof. See [MCP versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
and [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

A shared bridge must not infer privileged native provenance from a JSON field.
Controller-only operations need an authenticated private channel or a qualified
native mod that blocks every model-origin call to those operations and invokes
them only with host-derived facts. Hiding a tool from `tools/list` does not
prevent a direct `tools/call`. Test that direct caller path explicitly.

### Implemented native workflow

The existing six profiles keep their original tools while ULTRA is disabled.
Protected native mode requires both owner policy `enabled: true` and
`OPENAI_ULTRA_ENABLED=1`. Actual provider calls additionally require
`OPENAI_ULTRA_ALLOW_API=1`; the offline evaluator does not set this.

In protected mode, the **primary Claude model is inside the mission boundary**.
It can use governed `Agent` recruitment, approved scoped reads, diagnostics,
review workflow creation and specifically configured judgement operations.
Arbitrary `Bash`, native live `Read`/`Edit`/`Write`, unknown external tools and
untracked Claude intermediaries are denied. Native deny and ask decisions
continue to apply to every allowed operation. This restriction prevents a
lower-authority primary model from launching an unmediated control bridge,
editing its policy, or delegating those actions to an unrestricted child.
Leaving the primary model an unrestricted shell would invalidate the claimed
authority boundary. The ordinary disabled integration remains available.

The mod obtains its private session capability from the native stdio bridge
and keeps it only in its closure. Every model-origin `ultra_native_*` and raw
bridge request is denied, including calls from the primary model. Desktop
Chat never routes this namespace. MCP itself does not provide model identity
attestation: the installed mod, native host, bridge process and owner-controlled
policy files form the trusted boundary. A hostile same-user external process
or separately installed malicious plugin is outside that boundary. A failed
environment lookup or bootstrap holds workers rather than selecting the legacy
path.

`Agent` requests pass through `agent.spawn`, the shared broker, fleet admission
and any required HELICOP decisions before the host starts the child. A
single-use binding ticket handles a first-turn race; `turn.start` binds the
pinned host ID/type/parent and the successful spawn return confirms the same
identity. The marker is removed before external model input. Foreground child
waits release the parent's running slot. Native nodes remain separate from
runtime nodes for claiming purposes, while sharing one durable mission,
population accounting and spending ceiling.

Use these native operations:

| Operation | Behavior |
|---|---|
| `/ultra` and `/openai-workers` | Current authority, lineage, fleets, reservations, pending decisions and workflow state. |
| `/ultra supervise` | One bounded shared runtime tick for configured approvals, reviews, rework or adjudication; fresh host organization data rules are checked before the send. |
| `/ultra review <native-author-id>` | Start review from the preserved result of a completed native implementation author. |
| `/ultra cancel` | Revoke the native mission's authority before best-effort cancellation of known remote responses; preserve incurred usage and uncertain reservations. |
| `ultra_read_file` | Root or worker scoped read, subject to its actual permissions and the A/B/C ceiling of the host surface (`surfaces.codeCli` / `surfaces.desktopCode`), not Desktop Chat's profile. |
| `ultra_create_stage`, `ultra_stage_read`, `ultra_stage_write`, `ultra_stage_patch` | Core author/reworker private-stage operations in explicitly enabled C. |
| `ultra_start_review` | Root starts the actual review controller for a completed bound author; may supply an explicitly labelled immutable source snapshot. |
| `ultra_recruitment_decide` | Root provides only a configured `trusted-orchestrator` vote, bound to the exact recruitment input hash. It cannot supply a user or HELICOP vote. |
| `ultra_action_propose`, `ultra_action_decide` | Record an actual action and evidence, then provide a separately configured root judgement bound to its hash. Neither tool executes the action. |
| `ultra_risk_override` | Full trusted root records a rationale, replacement classification and expiry for an exact Core allocation; affected approvals become stale. |
| `ultra_promote`, `ultra_escalate` | Full trusted root grants a scoped expiring recruitment promotion or authorises bounded re-evaluation of an escalated request. Root limits and independent gates remain binding. |

Registered tool names have the prefix `mcp__openai-workers__`. Review selection,
blind second opinion, coverage-gap inspection, rework and final adjudication use
the shared `ReviewController` and scheduler. Caller-supplied snapshots are
labelled as such; approval binds those exact bytes, not an assumed live commit.
Source changes require re-review, and missing independent test evidence holds
completion. Test evidence cannot be fabricated through a native model tool.
An explicit `authority.profiles.sonnet.final: false` uses Sol consultation plus
a distinct configured root final vote. Model switches/fallbacks update that
authority before a consequential root decision.

Native prompt metadata is a proposal, never permission. For example:

```json
{
  "task": "Inspect the listed source and return bounded findings.",
  "ultra": {
    "role": "exploration",
    "mode": "SWARM",
    "risk": {
      "complexity": "low", "impact": "low", "verifiability": "high",
      "confidence": 0.95, "rationale": "Read-only review of a synthetic fixture."
    },
    "budget": { "tokens": 40000, "usd": 4 }
  }
}
```

Use the native `subagent_type: "openai-workers:sol"`; do not pass an invented
native model name. A pending spawn is reported as pending. After approval,
retrying the same proposal reuses its approved allocation. A permitted revised
proposal can name `ultra.revisionOf` to use the broker's bounded revision path.
After explicit escalation, `ultra.approvedRequestId` may bind the resulting
approved allocation. It is checked against the parent and worker, cannot be
replayed, and runs the stored approved task rather than a replacement prompt.
An opaque `ultra.planId` can refer to an already authorised, scoped recruitment
plan; the broker still checks the plan's parent, limits and expiry. **Plan-level
approval authorises future matching recruitment without inspecting each spawn.**
Only a trusted root assignment may set
`ultra.reviewerPolicy: { "selection": "B", "primary": "astra" }` (or Policy C).
Descendants cannot replace their assigned reviewer policy.
No unavailable approver produces an implicit approval.

New API requests reserve conservative input/output cost before sending and
are bound to one worker/model/key/tier. Only one unsettled request may exist
per native agent. Verified incurred usage is committed before an overrun or
model-substitution error is raised; missing usage retains reservations. A
crash/transport ambiguity never causes a blind repeat POST. Restarted native
work remains on explicit reconciliation hold, preserving completed responses,
tool results, stage patches, approvals and reservations.

MCPB supports directory configuration fields and sensitive key fields. The
manifest is a packaging/configuration contract, not a filesystem sandbox.
User-selected roots must be independently enforced by the local server. Keep
the existing two sensitive key fields and DPAPI fallback. The official
[MCPB manifest specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)
defines these fields; the
[Desktop extension installation guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
describes their user-facing configuration.

## Implemented permission boundary

`plugins/openai-workers/ultra/permissions.mjs` implements a server-side
`PermissionBoundary`:

- **A:** no project reads, staged editing or execution.
- **B:** explicit configured roots and path scopes; bounded UTF-8 reads.
- **C:** opt-in Core author/reworker edits to private staged snapshots, with
  immutable before/after hashes and structured patches. It never applies a
  patch to the live project automatically.

Relative paths are validated before normalization. Traversal, absolute paths,
backslashes, Windows alternate data streams, reserved device names, trailing
dots/spaces, short-name aliases and secret/control paths are rejected.
Ancestors must be canonical and free of symlinks/junctions. Files with multiple
hard links are rejected. Reads open a bounded file descriptor and verify its
device/inode identity, size and timestamps before returning bytes. Known
credential paths and caller-configured `protectedPaths` remain excluded even
inside an allowed root. These protections are not a general classifier for
secrets embedded in ordinary source text; users must select source scopes that
are appropriate to send to the configured API.

Snapshots include only an explicit bounded file list. They use a private
directory and serialised optimistic edits, so conflicting changes with an old
hash fail instead of overwriting one another. A durable manifest preserves
accepted originals and modifications. `recoverStage(id)` reopens accepted work
**on read-only hold**, permitting inspection and patch export while requiring
a fresh allocation before modification or execution. Interrupted operations
are not automatically replayed; untracked temporary files can remain for
manual recovery. Production deployments should place `stageDirectory` in a
durable user-owned location, not a periodically cleaned temporary directory.

### Exact bridge API

```js
const boundary = new PermissionBoundary({
  profile: 'C', // trusted local configuration; disabled by default
  roots: [{ id: 'project', path: canonicalRoot,
    read: ['src', 'README.md'], write: ['src'] }],
  protectedPaths: [absoluteLedgerPath, absolutePolicyPath],
  principal: { id: durableAgentId, role: 'author' },
});

const input = await boundary.readFile('project', 'src/app.js');
const stage = await boundary.createStage([{ rootId: 'project', path: 'src/app.js' }]);
await boundary.stageWrite(stage.id, 'src/app.js', replacement, input.sha256);
const proposedPatch = await boundary.stagePatch(stage.id);
```

Construct the boundary from the ledger's approved principal and permissions.
Never accept a tool argument that assigns its own role, profile, project roots
or command policy.

### Testing and live execution boundary

`runApprovedTest` accepts a configured command ID, not a shell string. Its
allowlist pins an absolute executable by SHA-256, fixed arguments, test effect,
and bounded timeout. It requires **all three trusted server dependencies**:

- `attestIsolation`: establishes stage-only access, read-only host access,
  denied network, removed secrets and process-tree cleanup.
- `consumeApproval`: validates and consumes an action-bound approval against
  the exact stage source hash, executable, arguments and principal.
- `executeIsolated`: actually enforces that OS isolation and pins executable
  identity through launch; it must fail if isolation is unavailable.

These callbacks are part of the trusted computing base, not model tools or
JSON configuration flags. Without them the module refuses execution. It ships
no arbitrary-shell fallback and does not claim that a mocked executor proved
an OS sandbox works.

Portable Node filesystem preflight checks cannot make a later arbitrary host
tool's Windows file open atomic. `inspectPath` is therefore only preflight;
use `readFile` for verified bridge reads. Live project edits, general commands,
merge, deployment and destructive execution remain refused by this module
unless handled by a separately qualified host transaction with its own
approval gate. Private staging assumes no untrusted process can concurrently
mutate the staging tree; test executors must end all descendants before
returning. A hostile same-user local process is outside this boundary's
isolation guarantee.

Run deterministic qualification with:

```console
node --test plugins/openai-workers/tests/ultra-permissions.test.mjs plugins/openai-workers/tests/ultra-native.test.mjs
```

The tests cover real filesystem reads and staged edits, links and junctions,
hardlinks, traversal/ADS/device paths, secrets, size limits, scope, stale and
concurrent edits, recovery holds, role separation, command pinning, missing
sandbox enforcement and action-bound approval. Tests that inject an executor
are labelled synthetic; Windows and Desktop host acceptance remain separate.

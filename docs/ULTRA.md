# ULTRA operational guide

ULTRA is the repository's opt-in orchestration system for bounded, recursive OpenAI workers. It separates **recruitment, implementation, review, approval and consequential execution**. A small model can author a straightforward change while stronger, independent models review its consequences. Increasing a model's rank or a fleet's capacity does not grant tools or start additional agents.

ULTRA is **disabled by default**. The six existing worker profiles, separate standard/free keys, Windows DPAPI setup, reasoning policies and Desktop think-only integration remain available. ULTRA is not an OpenAI `reasoning.effort` value.

The implemented control plane can be exercised offline with real policy, scheduling, review, filesystem and recovery code. That evidence is distinct from live OpenAI calls, installed Claude Code validation and physical Windows/Desktop acceptance. Profile C currently supports **private staged patches**; this distribution does not provide a qualified general operating-system executor or automatic application to a live project. See [host boundaries](ULTRA_HOSTS.md) and [owner acceptance](ULTRA_ACCEPTANCE.md) before enabling it.

## Contents

- [Start with an offline evaluation](#start-with-an-offline-evaluation) — Check the exact candidate without credentials or API expenditure.
- [Choose a profile and configure it](#choose-a-profile-and-configure-it) — Set explicit limits and understand precedence and opt-in switches.
- [Models, reasoning and recruitment](#models-reasoning-and-recruitment) — Keep model rank, API effort and delegation authority separate.
- [Authority and HELICOP decisions](#authority-and-helicop-decisions) — Understand trusted identity, mandatory supervisors and bounded approvals.
- [Assess difficulty, consequence and evidence](#assess-difficulty-consequence-and-evidence) — Select author capability independently of verification and execution controls.
- [Run independent review and rework](#run-independent-review-and-rework) — Use Policy B/C, blind second opinions, gap inspection and source-bound tests.
- [Protect review capacity and control spending](#protect-review-capacity-and-control-spending) — Apply separate fleets under shared mission and usage limits.
- [Use the local command interface](#use-the-local-command-interface) — Operate missions and record explicit owner authority with concrete JSON files.
- [Choose a host and permission profile](#choose-a-host-and-permission-profile) — Understand native Code, Desktop Chat A/B/C and actual tool boundaries.
- [Understand the shared architecture](#understand-the-shared-architecture) — Locate the modules that implement each decision and adapter.
- [Inspect evidence and recover safely](#inspect-evidence-and-recover-safely) — Interpret diagnostic traces, preserve accepted work and respect recovery holds.
- [Qualification and further reading](#qualification-and-further-reading) — Run reproducible checks and keep live acceptance evidence separate.

## Start with an offline evaluation

Use a complete reviewed checkout and Node.js 20.11 or newer. From the repository root:

```sh
node scripts/ultra-evaluate.mjs
```

On Windows 11, double-click `scripts\Run-ULTRA-Evaluator.cmd`, or run it from PowerShell. The wrapper checks Node, runs the same scenarios and records optional owner observations. It does not download dependencies, install the plugin, change production defaults or authorise live API use.

To retain reports in a chosen new directory:

```sh
node scripts/ultra-evaluate.mjs --output /tmp/ultra-evaluation-01
```

Use a Windows path when running native Windows Node. Add `--expect-sha` followed by the full candidate commit SHA to reject an unexpected checkout. The evaluator also records a dirty-worktree flag and source fingerprint; a dirty run is not evidence for a clean commit. Existing reports are not overwritten. Disposable engineering fixtures are removed after the run; reports remain.

The six scenarios exercise cheap implementation with strong review; actual recursive mixed-tier delegation and HELICOP decisions; Claude model-dependent authority; protected reviewers under Core saturation; A/B/C tool boundaries; and interrupted-work recovery. The model backend is synthetic, while the broker, runtime, approvals, review controller and permission boundary are the real implementation. All evaluator dollar/token figures are synthetic accounting inputs, with zero actual API spend. The [Windows/offline acceptance guide](ULTRA_ACCEPTANCE.md) describes every scenario and report field.

## Choose a profile and configure it

### Presets allocate capacity, not agents

The preset names accepted by `init` are `Lite`, `Balanced`, `Research`, `Critical Engineering` and `Custom`. `Critical` is also accepted as an alias by the preset constructor.

| Preset | Core: depth / total invocations / concurrent | Review: depth / total invocations / concurrent | Main distinction |
|---|---|---|---|
| Lite | 2 / 12 / 4 | 2 / 12 / 3 | Small bounded fleets; one protected Review concurrency slot. |
| Balanced | 3 / 24 / 6 | 2 / 18 / 4 | Larger capacity, with a shared 42-job ceiling. |
| Research | 3 / 24 / 8 | 2 / 12 / 3 | More parallel investigation and read-oriented capability settings; roots still require explicit selection. Shared job ceiling 36. |
| Critical Engineering | 2 / 12 / 4 | 2 / 12 / 3 | Adds high-impact recruitment approval, always-on execution approval, free-to-paid policy C, and second/gap reviews for medium, high, critical or unknown impact. |
| Custom | Initially Lite | Initially Lite | Independent editing of the validated owner policy. |

All presets retain `enabled: false`, Desktop profile A and no selected roots. Research does not turn on project access by itself. A capability name in configuration only permits an implemented adapter tool; it does not create a new tool. For example, the shared runtime exposes scoped `read_file`, not a general filesystem search executor.

Create and inspect an owner configuration:

```sh
node plugins/openai-workers/ultra/cli.mjs init Lite
node plugins/openai-workers/ultra/cli.mjs show
node plugins/openai-workers/ultra/cli.mjs validate
```

`init` writes the selected preset to the owner file and can replace an existing configuration. Preserve intentional customisations before using it again. Changing only the `profile` label in an already complete file does not erase its explicit fleet and policy values. Start from a fresh preset when changing the whole preset.

### Owner file, policy layers and exact snapshots

The default owner file is `ultra-policy.json` in the local per-user state directory:

| Platform | Default state directory |
|---|---|
| Windows | `%LOCALAPPDATA%\ClaudeOpenAIWorkers` |
| Linux/macOS | `$XDG_STATE_HOME/claude-openai-workers`, or `~/.local/state/claude-openai-workers` |

`OPENAI_ULTRA_CONFIG` selects an owner file. `OPENAI_ULTRA_STATE_DIR` selects the execution-state directory. Both (and `OPENAI_ULTRA_CHANNEL_KEY_FILE`) must be absolute paths; a relative value is refused rather than resolved against whatever working directory the reading process has. `show` and `validate` report the resolved paths and warn if the channel key file lies inside a configured project root. Keep these owner-controlled files outside source scopes available to workers. Private staging requires canonical directory spelling for the state path and every ancestor, as it does for selected project roots. On Windows, use the actual long directory name and casing, not an 8.3 alias or a junction. This also applies if the default `LOCALAPPDATA` or home path is noncanonical: configure a canonical owner state directory before using private staging. A `PATH_ALIAS` hold requires correcting the owner path; it does not authorise relaxing the path boundary.

Configuration version 1 is supported. Missing settings are filled from the selected preset; objects merge recursively and arrays replace their previous values. Unknown fields, unsupported versions, malformed values and unclassified worker models fail validation. A malformed file is not silently reset to defaults. `validate file.json` checks a candidate and prints its policy hash; it does not install the candidate.

The shared [`resolveConfig`](../plugins/openai-workers/ultra/config.mjs) API accepts ordered owner, project, worker, mission and stage layers. Unauthorised scoped layers may reduce capabilities and ceilings; they cannot change model classifications, authority rules, review assignments or other security policy. Owner-authorised layers are trusted control-plane inputs, never model tool arguments. The shipped public adapters load the selected owner file; they do **not** automatically discover and trust policy files in arbitrary repositories. To use different project profiles today, select the appropriate owner file before creating the mission.

Each mission stores its resolved policy and canonical SHA-256 policy hash. Approvals refer to that snapshot. Public Chat operations reject an existing mission if the current owner policy has changed; diagnostics and cancellation remain available. Create a newly authorised mission after changing policy instead of assuming old approvals apply to the new rules.

### A bounded starting policy

This partial owner document resolves against Lite defaults. The numbers are local ceilings chosen for illustration, not estimated task costs or a recommendation to spend them:

```json
{
  "version": 1,
  "enabled": false,
  "profile": "Lite",
  "recruitment": { "mode": "SWARM", "reviewHigher": true },
  "mission": {
    "maxTokens": 400000,
    "maxUsd": 25,
    "maxWallMs": 1800000,
    "maxOutstanding": 12,
    "maxJobs": 24
  },
  "desktop": { "profile": "A", "enableExecutionBridge": false, "roots": [] },
  "surfaces": {
    "codeCli": { "profile": "A", "enableExecutionBridge": false },
    "desktopCode": { "profile": "A", "enableExecutionBridge": false }
  }
}
```

`desktop` is the Desktop **Chat** ceiling only; `surfaces.codeCli` (Claude Code CLI) and `surfaces.desktopCode` (Desktop Code local sessions) are the native Code ceilings. See [Capability ceilings per surface](#capability-ceilings-per-surface).

Preset mission token, dollar and wall-clock limits are `null` until explicitly configured. Population limits alone are not a dollar budget. Include review, rework and supervisory reservations when choosing limits. An allocation omitted from a recruitment proposal defaults to 40,000 tokens and $4 in local reservation capacity; actual verified usage is accounted separately.

After offline evaluation and host checks, the owner can opt in:

```sh
node plugins/openai-workers/ultra/cli.mjs set mission.maxUsd 25
node plugins/openai-workers/ultra/cli.mjs set enabled true
```

The existing PowerShell workflow is also available:

```powershell
& .\plugins\openai-workers\scripts\set-ultra-policy.ps1 -Command show
& .\plugins\openai-workers\scripts\set-ultra-policy.ps1 -Command set -Field enabled -Value true
```

`set` takes a dotted existing field and one JSON value. Strings need JSON quotation marks as well as the shell's argument quoting; for extensive changes, edit the owner JSON shown by `show` and run `validate`. The `--help` output contains a POSIX string example.

Live ULTRA provider calls additionally require `OPENAI_ULTRA_ALLOW_API=1` in the bridge process's environment. Protected native Code additionally requires `OPENAI_ULTRA_ENABLED=1` and an owner-provisioned channel key (`node plugins/openai-workers/scripts/provision-ultra-channel.mjs`; Windows `plugins/openai-workers/scripts/set-ultra-channel.ps1`; see [the private channel](ULTRA_HOSTS.md#private-native-control-channel)). Neither switch is set by the offline evaluator. Enabling the owner policy alone does not grant live-call authorisation, project access or execution permission.

## Models, reasoning and recruitment

### Six worker routes remain explicit

These defaults come from [`bridge/workers.mjs`](../plugins/openai-workers/bridge/workers.mjs). They are local configured model IDs, not a promise of availability for a particular API account.

| Worker | Default exact model | Family | Key route | Default processing tier | Reasoning minimum / maximum / default |
|---|---|---|---|---|---|
| `sol` | `gpt-6.2-sol` | Sol | Standard | Project default | medium / max / high |
| `astra` | `gpt-6.2-astra` | Astra | Standard | Project default | medium / max / high |
| `luna` | `gpt-6-luna` | Luna | Standard | Project default | max / max / max |
| `flex6-1` | `gpt-6.1-sol` | Sol | Standard | flex | medium / max / high |
| `daily-astrafree` | `gpt-6-astra` | Astra | Free programme | default | medium / max / high |
| `daily-terrafree` | `gpt-5.6-terra` | Terra | Free programme | default | high / max / high |

The family hierarchy defaults to Astra 4, Sol 3, Luna 2, Terra 1. Exact models inherit the family's rank when their `models` entry has `rank: null`; an owner can set an explicit rank exception. Paid and daily Astra therefore have equal rank, as do standard and Flex Sol. Reasoning effort, processing speed and price do not alter rank. Unknown IDs receive no inferred privileges.

Existing worker environment settings continue to select transport model, processing tier and reasoning range. A specific worker tier overrides its named preset, which overrides the global `OPENAI_WORKER_SERVICE_TIER`. A model override uses the existing `OPENAI_WORKER_<WORKER>_MODEL` name, with hyphens converted to underscores in worker suffixes. Reasoning uses `_EFFORT_MIN`, `_EFFORT_MAX`, `_EFFORT_DEFAULT` and `_EFFORT_NOTE`.

The ULTRA allocation also pins an exact model and service tier in owner policy. **That allocation and the bridge's worker settings must agree.** Changing only an environment model override does not rewrite policy classification; changing only a policy model does not override the transport. Mismatches are refused. New model IDs need classification, known pricing, a valid effort policy and an intentionally configured transport route. Adding a schema entry does not make an additional named transport worker executable.

Requested reasoning is clamped to the worker's configured range; invalid values and unsupported known model/effort combinations fail before sending. The current shared runtime uses the worker default, while the native adapter accepts a host-provided requested effort within that range. Existing [configuration guidance](CONFIGURATION.md) covers the worker settings. `ULTRA` describes this orchestration system and is never sent as API effort.

### Modes are permission presets

| Mode | Recruit lower rank | Recruit equal rank | Recruit higher rank |
|---|---|---|---|
| SWARM | Yes | No | No |
| REPLICATOR | Yes | Yes | No |
| SKYNET | Yes | Yes | Yes |
| CUSTOM | Independent flag | Independent flag | Independent flag |

For example, this owner fragment allows lower and equal recruitment globally, with an explicit Sol worker default:

```json
{
  "recruitment": {
    "mode": "CUSTOM",
    "custom": { "lower": true, "equal": true, "higher": false },
    "reviewHigher": true
  },
  "workers": { "sol": { "mode": "REPLICATOR" } }
}
```

A recruitment proposal can request a mode. The evaluator considers the parent mode, mission mode where supplied by the trusted adapter, global default and worker default, but always intersects the result with inherited root and parent capabilities. A SWARM descendant cannot regain equal/higher authority by writing `SKYNET`, using a lower-tier intermediary or changing its role label. An authorised, scoped promotion is the separate mechanism for a bounded exception.

`reviewHigher` is independent of ordinary recruitment. With it enabled, Luna can request a preauthorised Astra review while remaining in SWARM. The resulting Review allocation is read-only, has no further recruitment authority and cannot act as an unrestricted Astra implementation worker. Any required fix returns through the controller as a new Core reworker allocation.

## Authority and HELICOP decisions

### Trust belongs to the existing primary orchestrator

| Trusted existing primary | Default authority |
|---|---|
| Opus | Full decision authority within root policy, tools and budgets. |
| Fable | The same initial trust as Opus, through its own editable profile. |
| Sonnet | Routine authority; Sol consultation and default final approval for restricted Sol/Astra recruitment. |
| Haiku | Limited authority; Sol makes the restricted Sol/Astra recruitment decision. |
| Unknown or unverified | Restricted profile; user approval for Sol/Astra recruitment. |

These rules do not spawn extra Claude models. Native identity is supplied by pinned host facts, including the effective main-loop model and parent model. A descendant's inherited Claude placeholder is not evidence of the root's authority. Desktop Chat and the standalone local mission CLI have no trusted Claude model attestation; a caller saying “Opus” remains unverified.

An owner can explicitly configure `authority.configuredIdentity` with `model`, `authorisedBy` and an `expiresAt` timestamp. That is an owner-authorised profile with an expiry, not a claim that MCP verified the active model. Expired configuration falls back to restricted authority. A verified host identity takes precedence. Keep this configuration outside agent-editable scopes.

The `authority.profiles` entries are independently configurable. `final: false` makes the supervisor's completed consultation advisory and requires a separate trusted-orchestrator final vote; it does not remove the consultation. Unknown identity cannot receive this trusted final authority.

### HELICOP rules are independent gates

Default Sol→Sol recruitment requires HELICOP-SOL; Sol→Astra requires HELICOP-ASTRA. Permitted Sol→Luna/Terra requests have no such peer/higher rule, though uncertainty, key transition or orchestrator rules may still apply. Sol and Astra toggles are independent. Disabling a helicopter does not bypass a requirement imposed elsewhere: an unavailable required authority causes a hold or rejection. An unverified primary cannot obtain a restricted Sol/Astra allocation indirectly by requesting uncertain lower-tier work: required root authority is obtained before the supervisor is invoked. The intended trusted Sonnet/Haiku consultation with Sol remains available.

Rules can match mode; parent/child exact model or family; role; complexity, effective impact and verifiability; confidence; proposed tools; estimated tokens/dollars; population, running count and depth; and key transition. The executable fields and matching logic are in [`config.mjs`](../plugins/openai-workers/ultra/config.mjs) and [`policy.mjs`](../plugins/openai-workers/ultra/policy.mjs).

This example retains the default gates explicitly. Replacing the `rules` array replaces the whole array, so keep any existing rules you still require:

```json
{
  "helicop": {
    "sol": true,
    "astra": true,
    "combination": "AND",
    "denial": "revise",
    "maxRevisions": 1,
    "rules": [
      {
        "id": "sol-peer", "authority": "helicop-sol", "enabled": true,
        "when": { "parentFamilies": ["sol"], "childFamilies": ["sol"] },
        "mandatory": true, "veto": true, "priority": 50
      },
      {
        "id": "sol-astra", "authority": "helicop-astra", "enabled": true,
        "when": { "parentFamilies": ["sol"], "childFamilies": ["astra"] },
        "mandatory": true, "veto": true, "priority": 100
      }
    ]
  }
}
```

Multiple rules can apply to one request. Their combination is deterministic:

| Combination | Behavior after mandatory gates and vetoes are checked |
|---|---|
| `AND` | All applicable authorities approve. |
| `OR` | At least one eligible optional authority approves; mandatory authorities still must approve. |
| `veto` | Applicable authorities respond; a rejecting gate prevents approval. |
| `prioritised` | Highest-priority optional authorities determine the optional result; equal highest priorities must all approve. |
| `escalation` | Optional rejection/disagreement produces explicit escalation; mandatory rejection remains rejection. |

A mandatory or veto rejection wins before a lower-authority approval. `MODIFY` requests a revised proposal and `ESCALATE` holds for an authorised escalation. Missing mandatory votes remain pending. Revisions re-run model, scope, budget, lineage and approval checks; they do not apply a supervisor's requested modification as an unchecked permission grant. Defaults permit one bounded revision per proposal. Revised proposals, explicit escalations and renewed adjudication after late test evidence consume the same mission-wide `maxRetries` allowance; diagnostics show used and remaining retries. Review/rework rounds have their own configured ceiling.

Supervisors receive the actual proposal and evidence as fresh, tool-free Review allocations. They cannot recruit further approval reviewers. Stored approvals bind the request input hash, mission policy, principal, scope and expiry, and cannot be replayed for unrelated work.

## Assess difficulty, consequence and evidence

[`risk.mjs`](../plugins/openai-workers/ultra/risk.mjs) keeps three assessments independent:

| Assessment | Determines |
|---|---|
| Complexity | How much implementation reasoning the task needs. |
| Failure impact | The consequence of an incorrect result. |
| Verifiability | How well tests and independent evidence can establish correctness. |

The owner/orchestrator supplies a structured assessment; the system validates and derives controls from it. It does not independently prove that a model's risk description is true. Uncertain impact, low/unknown verifiability or confidence below the configured threshold requires additional scrutiny. The default confidence threshold is 0.75.

For a simple cleanup planner, a suitable proposal can say:

```json
{
  "complexity": "low",
  "impact": "high",
  "verifiability": "high",
  "confidence": 0.95,
  "rationale": "Selection logic is simple, but a future execution could remove valuable project data. Review scope checks and dry-run evidence before any execution.",
  "blastRadius": "project",
  "reversibility": "partial",
  "destructive": true,
  "testsAvailable": true,
  "independentEvidence": false
}
```

Luna may author that planner. The high impact drives stronger independent review, test evidence, gap inspection and a separate execution gate. It does not force Astra to author the code. Destructive, deployment, external, persistent, security-sensitive or privacy-sensitive work raises effective impact to at least high; organisation/public blast radius raises it to critical. A risk flag requiring dry-run evidence is a control requirement, not proof that the dry run occurred or that a safe executor exists.

Author-declared tests are not trusted test evidence. Review cannot lower the original admitted consequence flags. A local owner or configured full trusted native orchestrator can make a scoped risk override with a rationale and an expiry of at most one hour. The record preserves original and replacement assessments. It invalidates affected workflows/actions and grants no new tool, budget or model authority. After expiry, original risk applies and workflows depending on the override require fresh review.

## Run independent review and rework

### Select reviewers independently of the author

**Policy B**, the default, assigns the reviewer policy with the implementation allocation. The trusted native root can choose a task reviewer at assignment; otherwise the owner policy supplies it. An author can invoke the preauthorised review but cannot substitute its preferred reviewer later.

**Policy C** requires an independent HELICOP selection. The shared workflow appoints a fresh Sol selector with the source, risk and permitted workers. Its completed, workflow-bound decision selects the reviewer; an author's recommendation is not authority. A missing required selector holds the workflow. Descendants cannot downgrade a mission requiring C to B.

The default role assignments are explicit and editable:

```json
{
  "review": {
    "selection": "B",
    "primary": "astra",
    "reworker": "sol",
    "rereviewer": "astra",
    "secondOpinion": "sol",
    "gapInspector": "luna",
    "judge": "astra",
    "maxRounds": 3,
    "secondOpinionImpacts": ["high", "critical"],
    "gapInspectionImpacts": ["high", "critical"],
    "freshGapInspector": true,
    "blindSecondOpinion": true,
    "requireTests": true
  }
}
```

Use `"selection": "C"` in owner policy to require supervised selection. A workflow caller may reduce its round ceiling or add optional second/gap reviews. It cannot replace model assignments or turn off reviews required by the mission. The current workflow implements an initial reviewer, a re-review model and a reworker model; it does not interpret arbitrary per-round workflow scripts from configuration.

### The implemented workflow

A completed Core author provides an immutable source snapshot. The controller allocates the primary and, where required, second reviewer separately. By default each receives the same implementation, declared tests and trusted evidence without the other's conclusions. Setting `blindSecondOpinion: false` deliberately produces an informed second opinion after the primary completes; that choice is recorded and should not be described as a blind review.

High/critical-impact and uncertain work require the configured stronger review path. High-severity findings trigger a separately allocated Core reworker. A reviewer can request fixes but cannot edit using its Review allocation. The reworker receives the source and findings, has no greater edit permission than the author, and returns a new snapshot. Fresh review then binds to that new identity.

Coverage-Gap Review is a distinct stage after the senior reviews. The coverage map uses `examined`, `partial`, `not_examined` and `uncertain`. A fresh Luna receives the source and senior coverage notes and investigates omissions. Its findings return to the configured senior judge. A successful gap inspection is not a senior sign-off. Setting `freshGapInspector: false` explicitly chooses continuation of the original author conversation under a new read-only Review allocation; that mode is not an independent second opinion.

The final judge sees the current source, review findings and test evidence. Consequential disagreements require explicit resolutions by finding ID and rationale; they are not averaged away. The workflow reaches `code_approved` only when its required conditions pass. That status grants no delete, command, merge or deployment permission.

The default ceiling is three review rounds, counting the initial round. Repeated severe findings, no meaningful content change, oscillation back to earlier content, exhausted rounds, unavailable authority, stale evidence or an exhausted allocation stop progress. Accepted source, patches, findings and tests remain in the ledger. Adding valid test evidence after a missing-test hold can request bounded fresh adjudication; it does not silently reuse an earlier judge's approval.

### Source and test evidence must identify the actual work

`source.json` is an immutable snapshot, for example:

```json
{
  "id": "cleanup-planner-candidate-1",
  "content": "The complete reviewed source or patch belongs here, not only a filename.",
  "commit": "the actual candidate commit when applicable",
  "tests": ["Author-declared test notes; independently recorded evidence is separate."]
}
```

The controller hashes the whole snapshot, including provenance and supplied evidence, and separately hashes content to detect no-progress changes. An `id` or claimed commit does not prove that the live tree matches. Caller-supplied snapshots are labelled as such. Native private-stage patches include their preserved before/after identities; any later live application would still require a qualified executor to verify the actual target transaction.

Use the workflow's returned `source.hash` when recording a test. Do not substitute a Git commit SHA or a file hash. A test record contains exactly:

```json
{
  "sourceHash": "replace with the current workflow source.hash",
  "name": "cleanup planner scope cases",
  "passed": true,
  "details": "Record the actual command, environment, cases and outcome of an independently performed test."
}
```

`record-test` files an **owner-attested** record after explicit local confirmation; it does not run anything, and at the impact tiers the owner has not allowed (by default `high`, `critical` and `unknown`) the confirmation screen warns that the record will be stored but cannot satisfy the gate. Model output cannot set a trusted runner identity. Source changes invalidate affected reviews and pending execution approvals, and revised source needs matching new test evidence.

### Getting high-, critical- and unknown-impact work to code approval

Such work is held as `unplanned` until the local owner registers a verification plan, and then needs **executed** evidence for every executable test (or an explicit waiver of a non-executable one). These routes exist only in the interactive owner CLI; no MCP tool, native tool, hook or model can use them:

```text
node plugins/openai-workers/ultra/cli.mjs test-status MISSION_ID WORKFLOW_ID          # what is required, what is missing, what to do next
node plugins/openai-workers/ultra/cli.mjs plan-add MISSION_ID WORKFLOW_ID plan.json   # register / extend the plan: [{ "id": "unit:scope", "description": "..." }]
node plugins/openai-workers/ultra/cli.mjs test-digest --root C:/Projects/Synthetic -- node --test      # the digest a required test may pin
node plugins/openai-workers/ultra/cli.mjs run-test MISSION_ID WORKFLOW_ID unit:scope --root C:/Projects/Synthetic -- node --test
node plugins/openai-workers/ultra/cli.mjs waive-test MISSION_ID WORKFLOW_ID waiver.json   # { "testId": "manual:ui", "rationale": "..." }; non-executable tests only
```

- `plan-add` shows the exact entries and the plan hash before and after, and binds the confirmation to that hash: if the plan or source changes before you confirm, nothing is added. The set can only grow here (a reviewer may also request more tests); removing or redefining an entry is a separate owner change with a reason.
- `run-test` **runs the command you typed** and records the result as `executed` evidence from the principal `test-runner`, attested with the command digest, the exit code, the runner id and the exact source and plan hash. The command is an argv array after `--` (never a shell string; nothing from a model is an argument). The program is resolved from absolute `PATH` entries only (a relative name or a file planted in the project is never chosen; `.bat`/`.cmd` are refused). `--root` must be one of the policy's `permissions.roots`, canonical and link-free, and `--cwd` a relative subdirectory inside it. The child gets a minimal environment (PATH, temp/home/locale variables and the Windows system root; no API keys, no ULTRA variables), a timeout (`--timeout-ms`, default 120000, at most 3600000; the whole process tree is killed and the result recorded as a failure with exit code 124) and a cap on retained output (`--max-output-bytes`, default 262144; the tail is kept and a SHA-256 of what was retained is recorded). A non-zero exit is recorded as a **failing** result. A command that cannot start records nothing.
- A required test may pin `commandDigest` (owner policy or a plan entry): only that exact argv, root and subdirectory counts, and `run-test` refuses any other command before it asks you anything.
- **Limits, stated plainly.** The runner is not a sandbox: your command runs with your privileges. It cannot prove that the tree under `--root` contains the reviewed snapshot; the confirmation screen says so and you assert it by confirming. `.bat`/`.cmd` programs and shell pipelines are not supported (run `node script.js` or a program directly). Every confirmation needs a real interactive terminal.

## Protect review capacity and control spending

### Two pools under one mission ceiling

Core includes implementation, exploration and modifying rework. Review includes reviewers, second opinions, gap inspectors, supervisors and judges. Each has its own depth, lifetime invocation count and running concurrency limit. Claude is depth zero; direct workers start at depth one in their pool. Nodes retain both depth counters, so a role change does not reset ancestry. Ordinary reviewers cannot recruit implementation or manufacture privileged supervisor roles.

Lite's Review concurrency is three with one protected slot. At most two ordinary reviews occupy running Review slots; mandatory supervisors and critical adjudication can use protected capacity. The reserve protects concurrency, not an unlimited Review population or independent spending pot. Review invocations, its depth ceiling and shared mission limits still apply.

A parent waiting on admitted children releases its running slot and keeps its lineage and reservation. It resumes when those children terminate. Native foreground waits use the same cooperative accounting. Completion does not refund a consumed lifetime invocation; retries and rework remain bounded work. Simultaneous admission and claims use the durable transaction lock.

Shared optional ceilings cover tokens, estimated dollars, wall time, outstanding requests, job count, retries, request rate, and per-key/per-model tokens/dollars/requests. Admission considers **incurred usage + outstanding reservations + the proposed allocation**. Every new API send rechecks applicable limits. Core saturation cannot consume Review population, but either fleet can be held by the same shared dollar limit.

### Free-to-paid transitions

| Policy | Behavior |
|---|---|
| A | Permit within an explicit mission dollar budget and known estimate. |
| B — default | Permit within configured thresholds; require the configured additional authority beyond them or when the estimate is unknown. |
| C | Require explicit user approval for each applicable free-to-paid transition. |

Default B thresholds are 16,000 allocated tokens and $0.25 estimated allocation. These are permission thresholds, not promises of provider charges. Controllers retain the originating key route for review/rework decisions so calling through the root does not conceal a free-to-paid transition. Paid supervisory allocations are also subject to the transition policy.

A missing free key never falls back to the standard key. `daily-astrafree` and `daily-terrafree` always retain the free route; the other four named workers retain the standard route. Polling, cancellation and continuations verify the stored worker/key/model binding.

### Two durable records, different purposes

`ultra-execution.json` stores missions, lineage, allocations, approvals, source evidence and usage reservations. The existing `free-usage-ledger.json` stores participating API usage across native, Desktop and ULTRA calls for both keys. Its historical filename is preserved. Standard usage does not consume free daily group counters. `OPENAI_WORKER_USAGE_DIR` selects the shared API-ledger directory independently of `OPENAI_ULTRA_STATE_DIR`; keep all participating interfaces pointed at the same intended files.

Monthly aggregates survive daily-detail pruning. Missing, partial or inconsistent API usage stays unknown with its reservation retained. Unknown prices are not zero and cannot pass applicable spending guards. Requests are conservatively quoted before sending, including continuation history and maximum output; no cache discount is assumed in advance. Settlement uses measured usage and the reported processing tier. Duplicate response IDs and logical request IDs cannot become a second charge in the local record or a licence to send the same ambiguous work again.

`OPENAI_WORKER_MONTHLY_ALLOWANCE_USD=88` remains informational. `OPENAI_WORKER_MONTHLY_LIMIT_USD` is the separate enforceable local estimate guard across both participating keys. Neither it nor a mission dollar ceiling is an authoritative OpenAI billing figure; other clients, provider pricing changes and already-incurred overruns require reconciliation. See [accounting and recovery](ULTRA_ACCOUNTING.md) for retention, migration and fault behavior.

## Use the local command interface

All commands below follow this prefix from the repository root:

```text
node plugins/openai-workers/ultra/cli.mjs
```

Use `--help` to inspect the installed command surface. JSON filenames are local files read by the CLI, not prompts granting the model permission.

| Arguments after the prefix | Actual operation |
|---|---|
| `init [PROFILE]` | Write a disabled owner preset. |
| `show` | Show paths and resolved policy. |
| `validate [policy.json]` | Validate current/candidate policy and print its hash; do not install a candidate. |
| `set FIELD JSON_VALUE` | Change an existing dotted owner field, validate and write it. |
| `project-add ABS_ROOT [B\|C] --surface codeCli\|desktopCode\|chat` | Add a selected root and read capability and set the capability ceiling of **only** the named surface (`--surface` is mandatory; no other surface changes); C also opts into private-stage editing. `chat` also records the root in `desktop.roots`. Does not enable ULTRA itself. |
| `start "TASK"` | Create a mission through the restricted public service; no API call occurs here. |
| `status [MISSION_ID]` | Show configuration or a mission's tree, fleets, pending work and evidence. |
| `recruit MISSION_ID proposal.json REQUEST_KEY` | Request a root child using an idempotency key. |
| `step MISSION_ID` | Perform one bounded runtime tick, including eligible supervisors/review stages; live calls need the separate owner opt-in. |
| `cancel MISSION_ID [NODE_ID]` | Cancel local work and descendants while retaining accepted output and uncertain usage. |
| `review MISSION_ID AUTHOR_ID source.json risk.json` | Start a workflow for a completed Core author with the supplied immutable snapshot. |
| `approve MISSION_ID REQUEST_ID` | Record an interactive user recruitment vote. |
| `approve-batch MISSION_ID request-ids.json` | Inspect and vote on a bounded array of existing pending request IDs; items are processed sequentially. |
| `approve-plan MISSION_ID bounded-plan.json` | Grant a bounded, expiring plan for future matching recruitment. |
| `escalate MISSION_ID REQUEST_ID changes.json` | Explicitly authorise re-evaluation of a request awaiting escalation. |
| `promote MISSION_ID NODE_ID promotion.json` | Grant an exact worker/purpose recruitment exception, bounded by root authority, uses and expiry. |
| `risk-override MISSION_ID NODE_ID override.json` | Record an expiring Core risk override and invalidate affected evidence. |
| `test-status MISSION_ID WORKFLOW_ID` | Read-only: the required-test gate, each test's state, the plan hash and the next step for the owner. |
| `plan-add MISSION_ID WORKFLOW_ID plan.json` | Register or extend the workflow's verification plan after confirmation (shows the plan hash before and after). |
| `waive-test MISSION_ID WORKFLOW_ID waiver.json` | Waive a non-executable required test with a rationale, bound to the source and plan hash (critical impact only if owner policy allows). |
| `record-test MISSION_ID WORKFLOW_ID evidence.json` | Record an actually observed, source-bound **owner-attested** result after owner confirmation; accepted only at the tiers in `review.ownerAttestedImpacts`. |
| `test-digest --root ABS_ROOT [--cwd REL] -- COMMAND...` | Read-only: print the digest a required test can pin for that exact command. |
| `run-test MISSION_ID WORKFLOW_ID TEST_ID --root ABS_ROOT [--cwd REL] [--timeout-ms N] [--max-output-bytes N] -- COMMAND...` | Run the owner-typed command and record executed evidence (see above). |
| `propose-action MISSION_ID NODE_ID action.json` | Record an exact proposed action; do not execute it. |
| `approve-action MISSION_ID ACTION_ID` | Record a separate user execution vote for the exact action. |

Approval and scoped-authority commands require a real interactive local terminal. They display the record and require `APPROVE <record-id>` exactly. There is no `--yes` flag; redirected input cannot impersonate an owner. A user vote does not substitute for an independently mandatory HELICOP vote.

### A small recruitment proposal

Save the following as `proposal.json` and use it with `recruit`. It contains the proposed worker and budget, not caller-assigned authority, parent identity or tool grants:

```json
{
  "worker": "luna",
  "role": "exploration",
  "task": "Read the supplied text and return three concrete edge cases. Do not execute or modify anything.",
  "mode": "SWARM",
  "budget": { "tokens": 40000, "usd": 4 },
  "risk": {
    "complexity": "low", "impact": "low", "verifiability": "high",
    "confidence": 0.95, "rationale": "Bounded analysis of supplied synthetic text.",
    "blastRadius": "local", "reversibility": "reversible"
  }
}
```

Use a stable `REQUEST_KEY` for the same proposal. Reusing it for changed work is rejected. A pending approval is not a running agent. After necessary approval, `step` executes admitted work; repeating `step` is an explicit bounded continuation, not a hidden unbounded background loop.

### Plan approvals and promotions

**A plan authorises future matching recruitment without examining each individual spawn.** It remains subject to mandatory supervisors, inherited tools, resource ceilings and execution gates. For example:

```json
{
  "parentId": "root",
  "workers": ["luna", "daily-terrafree"],
  "roles": ["exploration"],
  "maxInvocations": 3,
  "budget": { "tokens": 120000, "usd": 12 },
  "tools": [],
  "roots": [],
  "ttlMs": 900000
}
```

`approve-plan` supplies the explicit future-recruitment acknowledgement after the terminal confirmation. A later proposal references the returned `planId`. The broker checks exact parent, workers, roles, capability ceilings, aggregate remaining allocation and expiry before consuming the grant. Plans do not appoint supervisors or judges, and they do not waive HELICOP votes. This no-tool example is suitable for a think-only parent; a plan cannot silently narrow away capabilities that its eventual requests actually inherit.

A review-only promotion can be as narrow as:

```json
{
  "worker": "astra",
  "role": "reviewer",
  "relations": [],
  "reviewOnly": true,
  "uses": 1,
  "ttlMs": 900000
}
```

This does not grant ordinary higher-tier implementation recruitment. A default `reviewHigher` exception may already permit the review; promotions are for a specifically authorised additional exception. Uses are capped at 12 and expiry at one hour. Root policy must already permit the relevant authority, and mandatory approval still applies. Reviewer/judge roles cannot promote themselves into implementation recruiters.

### Scoped risk override

`override.json` supplies a complete structured `assessment`, a concrete `rationale` and a positive `ttlMs` no greater than 3,600,000:

```json
{
  "assessment": {
    "complexity": "low", "impact": "low", "verifiability": "high",
    "confidence": 1, "rationale": "The scoped allocation only constructs a pure plan from fixed synthetic input.",
    "blastRadius": "local", "reversibility": "reversible", "testsAvailable": true
  },
  "rationale": "Owner inspected the exact allocation and confirmed it has no deletion or execution capability; any later action requires its own risk assessment.",
  "ttlMs": 900000
}
```

Use this only when the replacement describes the actual scoped work. An override is recorded against one Core allocation, not a global permission to label destructive work safe. Existing reviews affected by the change are held for a fresh workflow.

### Separate action authority

Action kinds are `test`, `command`, `write`, `delete`, `merge`, `deploy` and `external`. Each requires its corresponding actual capability, and approval is bound to the full action hash, actor, policy, expiry and current source evidence. The default execution policy requires a user vote for consequential work. The limited automatic risk-based case is an explicitly granted isolated test with complete low-impact reversible evidence; it still needs a qualified executor.

An owner can require both human approval and a fresh Astra action judge:

```json
{
  "execution": {
    "defaultApproval": "risk-based",
    "consequentialAuthorities": ["user", "helicop-astra"],
    "combination": "AND",
    "requireFreshEvidence": true
  }
}
```

Other permitted configured authorities are `trusted-orchestrator` and `helicop-sol`. A model judge is freshly allocated to the actual action and supporting evidence. Prior code review does not make it an execution judge. Approval cannot turn `stage_write` into `delete` or add a missing tool. The current CLI deliberately has no general `execute`, `apply`, `merge` or `deploy` command; recording an approval does not perform those actions.

## Choose a host and permission profile

### Native CLI and Desktop Code

Protected native mode uses the actual mod hooks for spawn admission, effective model identity, model-step replacement and tool checks. The minimum preexecution-hook version is Claude Code 2.1.326, with required API presence checked separately. This is a prerequisite, not evidence that a particular installation passed validation.

The primary Claude orchestrator is also inside the mission boundary in protected mode. Governed native `Agent` recruitment, approved scoped reads, private stages and configured review/decision operations are available. Arbitrary shell, live native file mutation, unknown external tools, raw bridge access and untracked intermediary agents are denied. Native host deny/ask decisions still apply. When ULTRA is disabled, the original worker integration remains available with its existing native permission behavior.

Useful native commands are `/ultra`, `/openai-workers`, `/ultra supervise` and `/ultra review <native-author-id>`. `supervise` runs one shared bounded tick; `review` starts review of preserved completed work. Registered tools use `mcp__openai-workers__` prefixes. They provide scoped reads/stages, workflow creation, exact configured recruitment/action votes, and full-root scoped promotion, escalation and risk override. They cannot forge user or independent supervisor authority. See the exact table in [ULTRA_HOSTS.md](ULTRA_HOSTS.md#implemented-native-workflow).

The installed mod, host and bridge form the trusted channel, and the bridge authenticates it itself: every controller-only request carries an HMAC proof of the owner channel key, so reaching the bridge is not authority. The mod keeps the key and its private capability in its closure and also rejects every model-origin call to controller-only endpoints, as defence in depth. MCP metadata or a hidden tool name is not authentication; residual limitations are listed in [ULTRA_HOSTS.md](ULTRA_HOSTS.md#private-native-control-channel). Host hook failures have explicit refusal handlers, so an unavailable guard cannot silently fall back to an unrestricted path.

Desktop Code local sessions have their own bundled runtime; record its `/status` version and qualify it separately. The official Desktop documentation inspected for this implementation says Desktop Code WSL sessions do not support plugins. Standalone CLI inside WSL is a different environment and needs its own validation and credentials. Local Desktop plugins do not imply cloud-session availability. These distinctions and the inspected declarations are documented in [host qualification](ULTRA_HOSTS.md), with sources in the official [mods reference](https://code.claude.com/docs/en/plugins/mods/reference), [event reference](https://code.claude.com/docs/en/plugins/mods/events), [subagent guide](https://code.claude.com/docs/en/sub-agents) and [Desktop reference](https://code.claude.com/docs/en/desktop).

### Capability ceilings per surface

ULTRA has one policy engine and three independently configured project-access surfaces:

| Surface | Owner setting | Host fact used |
|---|---|---|
| Claude Code CLI (native mod) | `surfaces.codeCli` | the mod reports `terminal` from `$.session.surfaces()` |
| Claude Desktop Code, local session (native mod) | `surfaces.desktopCode` | the mod reports `desktop` |
| Claude Desktop Chat (public MCP extension) | `desktop` | not native; never reaches the native controller |

Each ceiling has `profile` A/B/C (same meanings as the Chat table below) and `enableExecutionBridge` (C requires `true`, as for Chat). **All default to A** (think-only), so enabling ULTRA never grants file tools by itself. A native Code worker's effective capability is the *intersection* of what the owner granted it (`permissions.tools`, `permissions.roots`, worker permissions, scoped promotions) and its surface's ceiling: a ceiling can only remove tools, never create a tool, root or permission. Consequences that are tested:

- Authorising a Code worker with `read_file`/`stage_write` and roots, and setting that Code surface to B/C, is enough; Desktop Chat may stay think-only.
- Enabling Chat B/C never adds anything for Code; enabling a Code ceiling never changes Chat or the other Code surface. The CLI and Desktop Code ceilings are independent too.
- The surface is resolved once at native initialisation from the mod's host facts and stored in the mission (`native.surface`). Anything unreported, unrecognised (for example `vscode`, `mobile`), malformed, or mixed (terminal and desktop together) resolves to `unknown`, which receives A. `ultra_native_diagnostics` reports the resolved surface, the host facts and every configured ceiling.
- A native mission's API-run nodes (reviewers etc.) use the same Code ceiling, not Chat's.
- Changing any ceiling changes the policy hash. An existing native session cannot be silently re-authorised under a new ceiling, and it cannot be re-opened under a different policy: the refusal says "Owner ULTRA policy changed"; start a new host session.
- **Tightening applies to an open native session at once; loosening never does.** On every authenticated request the bridge re-reads the owner policy and the controller holds the mission to the stricter of its frozen policy and the current one, field by field: surface ceilings (lowest profile, bridge flag only if both allow it), `permissions.tools`, `permissions.roots` (intersection), `permissions.recruit`/`reviewHigher`, `recruitment` mode flags, fleet allowances, mission budgets and request limits (`maxTokens`, `maxUsd`, `maxWallMs`, `requestsPerMinute`, `perKey`, `perModel`, jobs/outstanding/retries) and `desktop.*`. The stricter result is persisted once as an audited `native.policy_attenuated` event and is also applied to every allocation's tool/root grant, so tool lists, file boundaries, broker admission and API-request budgets all see it. It is one-way: raising the owner policy later does not lift a session that was held down (a new host session gets the new policy), and an attenuation can never enlarge the session beyond what it was opened with. `ultra_native_diagnostics` reports `policy.authorisedPolicyHash`, `effectivePolicyHash`, `currentOwnerPolicyHash` and the attenuation history. Setting `enabled: false` refuses every call except diagnostics/cancel; an unreadable or invalid policy file refuses every call (the session is never run from its frozen copy). **Not** attenuated mid-session, because they are identity and governance rules frozen at admission rather than capability ceilings: worker/model classification, authority profiles, HELICOP rules, risk thresholds, free-to-paid policy, execution authorities and review/test policy; edits to those take effect for a new host session.
- Scoped (project/worker/mission/stage) layers cannot raise a ceiling or enable a bridge flag without explicit owner authorisation.

**Upgrade note.** Earlier candidates used `desktop.profile` for native Code too. After this change that setting affects Chat only, so an owner who relied on it must opt Code in explicitly, for example `project-add C:/Projects/Synthetic B --surface codeCli` (or `set surfaces.codeCli.profile '"B"'`). Chat B/C does not need to be changed. `permissions.tools` and `permissions.roots` remain shared owner grants; a Chat-visible read still additionally requires the Chat profile and `desktop.roots`.

### Desktop Chat A, B and C

The public local MCP extension uses the same policy, broker, runtime, review and usage modules. It has a different, narrower host surface:

| Profile | Implemented access | How to enable |
|---|---|---|
| A — Think-only | Supplied task text and governed orchestration; no project filesystem tools. | Default. |
| B — Read-only | Bounded reads inside explicitly selected roots, with canonical-path and secret protections. | `project-add ABS_ROOT B --surface chat`, then deliberate policy/live opt-ins as applicable. |
| C — Private staged edits | B reads plus Core author/reworker private snapshots and source-bound patches. Live project remains unchanged. | `project-add ABS_ROOT C --surface chat`, which sets the separate bridge flag; still disabled until owner policy is enabled. |

`ultra_start`, `ultra_recruit`, `ultra_step`, `ultra_cancel`, `ultra_read_project`, `ultra_review` and `ultra_diagnostics` are public service operations. Public callers cannot supply their own parent identity, privileged permissions, transport, user vote or native-host authority. Worker recursion obtains its actual node identity internally. A public Chat mission cannot reuse a native mission's authority.

For example, this disabled owner fragment prepares one disposable Windows root for C while keeping Astra read-only:

```json
{
  "version": 1,
  "enabled": false,
  "permissions": { "tools": ["read_file", "stage_write"], "roots": ["C:/ULTRA/Synthetic"] },
  "desktop": { "profile": "C", "enableExecutionBridge": true, "roots": ["C:/ULTRA/Synthetic"] },
  "workers": {
    "astra": {
      "permissions": {
        "recruit": { "lower": false, "equal": false, "higher": false },
        "reviewHigher": false,
        "tools": ["read_file"],
        "roots": ["C:/ULTRA/Synthetic"]
      }
    }
  }
}
```

Use an actual selected root appropriate to the environment. Root selection is permission to send allowed source to the configured model service when live calls run. Known secret paths are excluded, but no filename-based boundary can identify every secret embedded in ordinary source text.

### Actual tool-boundary enforcement

[`PermissionBoundary`](../plugins/openai-workers/ultra/permissions.mjs) rejects traversal, absolute relative-path arguments, Windows alternate streams/device names, unsafe aliases, symlinks/junctions, hardlinked files and protected credential/control paths. Verified reads use bounded file descriptors and identity checks. Private stages copy only explicit file lists, keep original/updated hashes and reject stale optimistic writes. Independent stages avoid workers overwriting each other's live files.

C does not provide unrestricted shell or generated-code test execution. The `runApprovedTest` adapter boundary requires a pinned executable, fixed arguments, exact source/action approval and trusted isolation dependencies proving stage-only access, read-only host access, denied network, removed secrets and process-tree cleanup. The distribution supplies no general OS implementation of those dependencies; absent enforcement, execution is refused. A mock attestation in a unit test is not a qualified Windows sandbox.

MCPB configuration fields are not a sandbox. The existing two sensitive key fields and DPAPI fallback remain separate from source permissions. See [Desktop installation](DESKTOP.md), the official [MCPB manifest](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md) and [Desktop local MCP guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop). This boundary assumes an owner-controlled local state/staging directory; a hostile same-user process or malicious separate plugin is outside its isolation guarantee.

## Understand the shared architecture

The adapters do not implement competing authority systems. Host facts and caller proposals enter the same decision engine, and allocation/execution changes are persisted by the same broker and stores.

| Module under `plugins/openai-workers` | Executable responsibility |
|---|---|
| [`ultra/config.mjs`](../plugins/openai-workers/ultra/config.mjs) | Versioned presets, strict validation, scoped attenuation and stable policy hashing. |
| [`ultra/policy.mjs`](../plugins/openai-workers/ultra/policy.mjs), [`ultra/risk.mjs`](../plugins/openai-workers/ultra/risk.mjs) | Pure authority/recruitment decisions and structured risk controls. |
| [`ultra/broker.mjs`](../plugins/openai-workers/ultra/broker.mjs) | Durable parent-child graph, atomic admission, two fleets, approvals, promotions, revisions, waits, leases and recovery. |
| [`ultra/store.mjs`](../plugins/openai-workers/ultra/store.mjs) | Cross-process transactions, atomic snapshots, integrity checks and hash-linked decision events. |
| [`ultra/runtime.mjs`](../plugins/openai-workers/ultra/runtime.mjs) | Responses tool loop, recursive child requests, cooperative waits, automatic configured review stages and conservative pre-send checkpoints. |
| [`ultra/review.mjs`](../plugins/openai-workers/ultra/review.mjs) | Reviewer assignment, independent reports, Core rework, gap inspection, source/test freshness and convergence. |
| [`ultra/actions.mjs`](../plugins/openai-workers/ultra/actions.mjs) | Exact action proposals, independent authority votes and single-use consumption against actual capabilities. |
| [`ultra/permissions.mjs`](../plugins/openai-workers/ultra/permissions.mjs) | Actual scoped reads, private staged edits and the fail-closed qualified-executor interface. |
| [`ultra/service.mjs`](../plugins/openai-workers/ultra/service.mjs), [`ultra/cli.mjs`](../plugins/openai-workers/ultra/cli.mjs) | Owner policy loading, restricted public operations and interactive local authority. |
| [`ultra/owner-tests.mjs`](../plugins/openai-workers/ultra/owner-tests.mjs), [`scripts/ultra-test-runner.mjs`](../plugins/openai-workers/scripts/ultra-test-runner.mjs) | Owner routes for the required-test manifest (plan, waiver, attested and executed evidence) and the bounded executor; imported only by the owner CLI, and the executor is outside the Desktop bundle. |
| [`ultra/native-controller.mjs`](../plugins/openai-workers/ultra/native-controller.mjs), [`hooks/register.js`](../plugins/openai-workers/hooks/register.js) | Trusted host bindings, native hooks and protected model/tool dispatch. |
| [`bridge/server.mjs`](../plugins/openai-workers/bridge/server.mjs), [`bridge/desktop-server.mjs`](../plugins/openai-workers/bridge/desktop-server.mjs) | Native/shared and Desktop MCP facades using the same transport and control plane. |
| [`bridge/openai.mjs`](../plugins/openai-workers/bridge/openai.mjs), [`bridge/usage.mjs`](../plugins/openai-workers/bridge/usage.mjs) | Fixed key routing, API transport, request reservations, measured usage and durable cross-interface accounting. |

One runtime tick recovers expired leases, schedules eligible workflow/supervisory allocations, claims runnable agents and performs bounded model steps. Model tool calls are checked against the allocation's advertised tools and again at the actual boundary. Results and verified incurred usage are persisted before later checks can hold the work. Native and shared-runtime nodes use separate claim selectors while consuming the same mission resources.

## Inspect evidence and recover safely

### Answer “why was this agent allowed?”

Use `/openai-workers`, `/ultra`, Desktop `ultra_diagnostics` or local `status`. The diagnostics expose effective worker/reasoning settings, mode, identity trust, fleets, lineage, budgets/reservations, pending decisions, review state and blocked reasons. Follow a node's `requestId` to its stored proposal and evaluation trace; approvals identify authority, input/policy hashes, rationale, scope and expiry. Workflow records identify source hash, reviewer allocations, findings, tests and final judgement.

Every agent has a mission, recorded parent, role, worker, exact model, key route, processing tier, inherited permissions and resource allocation. Ordinary reviews, supervisors and reworkers are separately identifiable. A human can determine why the model was chosen, whether it used a review exception, who approved recruitment and what tools were actually granted. Preserved evidence includes useful intermediate results even when final acceptance fails.

### Holds are deliberate outcomes

| Condition | Implemented response |
|---|---|
| Required supervisor unavailable or denied | Remain pending/held or reject; no substitute automatic approval. |
| Known accepted response, interrupted polling | Requeue after lease recovery and poll that response ID; do not issue a new POST. |
| Interrupted sending with no conclusive response identity | Block with conservative reservation until explicit reconciliation. |
| Interrupted tool/action execution | Preserve the intent and evidence; do not automatically replay an uncertain side effect. |
| Missing/malformed usage, unknown price or provider model mismatch | Retain incurred/uncertain accounting and hold further work. |
| Cancelled mission or child | Stop further local work, preserve completed output and usage; cancellation is not evidence of zero provider charges. |
| Source or risk changed, override expired | Invalidate affected approval and require review against current evidence. |
| Recovered private stage | Reopen accepted work on read-only hold for inspection/patch export; a fresh allocation is needed for further mutation. |
| Corrupt state or unsafe lock ownership | Fail closed instead of resetting history or taking a live process's lock. |

The local CLI's `cancel` records broker cancellation. Public Chat cancellation additionally attempts cancellation of known polling responses; provider acceptance and billed usage still require reconciliation. Native restarted work is conservatively held, with accepted outputs and stage patches retained. The control plane does not promise universal exactly-once execution across an external API and local crashes.

Both stores use local cross-process locking and atomic writes. A dead local owner can be recovered; age alone does not steal a live lock. Use local per-user storage, not a network filesystem shared across machines. The execution event chain helps detect accidental/tampered state, but is not a cryptographic boundary against an attacker who already controls the owner's files.

Keep the ledger, pending requests, approvals and stage directories when diagnosing a hold. Poll a known response through its bound worker/key route. Do not change request IDs to resubmit ambiguous work, delete the ledger to free budget, hand-edit approvals or remove a lock without establishing that its owner is gone. There is no general “force resume” or accounting-reconciliation CLI that safely resolves arbitrary ambiguity. Uncertain cases need a trusted operator to reconcile provider/host evidence and authorise fresh bounded work where appropriate. The exact ledger migration and abandoned-recovery-lock procedure is in [ULTRA_ACCOUNTING.md](ULTRA_ACCOUNTING.md).

## Qualification and further reading

Run repository tests from the plugin directory, or use the named focused suites from the repository root:

```sh
npm --prefix plugins/openai-workers test
node --test plugins/openai-workers/tests/ultra-integration.test.mjs
node --test plugins/openai-workers/tests/ultra-permissions.test.mjs
node scripts/build-desktop.mjs --check
```

`build-desktop.mjs --check` compares the committed `.mcpb` with a deterministic source build. `node scripts/build-desktop.mjs` rebuilds it when intentionally updating the candidate. Package reproducibility and MCP protocol tests do not establish that the Desktop UI loaded or exercised that package.

Before live native acceptance, use the installed host's `claude plugin validate` and `claude plugin test` according to the official [mod authoring guide](https://code.claude.com/docs/en/plugins/mods/create), inspect its generated declarations and record the actual Code/Desktop versions. The published interfaces inspected for this implementation and their limitations are retained in [ULTRA_HOSTS.md](ULTRA_HOSTS.md). No installed host or live API qualification is implied by this guide.

Keep exact source SHA, clean/dirty state, OS/Node/host versions, test output and owner observations together. Source-matched Windows and Linux CI, deterministic offline PASS, actual Desktop UI acceptance and authorised live API tests are separate evidence categories. Leave candidate PRs in Draft/HOLD until their required owner gates are satisfied. Nothing in ULTRA's code-review state, evaluator or action-recording commands automatically merges or promotes a PR.

For more detail:

- [Owner acceptance and Windows evaluator](ULTRA_ACCEPTANCE.md) — One-command evaluation, scenarios A–F and report interpretation.
- [Policy reference](ULTRA_POLICY.md) — Validation, inheritance and deterministic authority rules.
- [Runtime and evidence](ULTRA_RUNTIME.md) — Executable control-plane behavior and recovery.
- [Accounting and recovery](ULTRA_ACCOUNTING.md) — Shared-key admission, monthly retention, unknown usage and migration.
- [Host interfaces and permissions](ULTRA_HOSTS.md) — Inspected native/MCP contracts and the exact execution boundary.
- [Existing installation](INSTALLATION.md), [Desktop integration](DESKTOP.md) and [worker configuration](CONFIGURATION.md) — Preserved setup, key storage and worker tuning.

# ULTRA owner acceptance

Run the offline evaluator first. It exercises the implemented broker, scheduler, recursive runtime, supervisors, review controller, execution gate, permission boundary and durable store with deterministic model responses. It does not call OpenAI, use credentials, enable ULTRA in your installation, install software, access an existing project, merge, deploy or delete user data.

A green offline result demonstrates the tested control-plane behavior. Actual Claude Code hooks, Windows Desktop UI, live OpenAI responses and a production operating-system execution sandbox require their own evidence. The evaluator labels these **NOT RUN**.

## Windows 11 quick start

Obtain the complete reviewed ULTRA candidate and extract it into a new directory. Keep its exact commit identity with the evaluation record. Node.js **20.11 or newer** is required; Git is optional for an extracted archive, but a Git checkout records its commit and working-tree state automatically.

Double-click:

```text
scripts\Run-ULTRA-Evaluator.cmd
```

Or run from PowerShell:

```powershell
& .\scripts\Run-ULTRA-Evaluator.cmd
```

The wrapper checks native Windows Node, runs six offline scenarios, prints the report location and asks short PASS/FAIL/NOT RUN questions. Press Enter for NOT RUN when you have not performed a manual check. Recording an observation does not authorise API expenditure or consequential execution.

For a repeatable noninteractive run with an explicit new report directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Evaluate-ULTRA.ps1 `
  -NonInteractive -OutputDirectory C:\Temp\ULTRA-Acceptance-01
```

For a Git checkout, add `-ExpectedSha` with the full 40-character candidate commit to refuse accidental testing of another revision:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Evaluate-ULTRA.ps1 `
  -NonInteractive -OutputDirectory C:\Temp\ULTRA-Acceptance-02 `
  -ExpectedSha FULL_40_CHARACTER_CANDIDATE_SHA
```

Replace the placeholder with the actual candidate SHA. Do not pass the placeholder itself. Use a new output directory for each run; previous acceptance records are never overwritten. Reports default to a uniquely named directory under your Windows temporary directory. Disposable source projects and private stages are cleaned after each scenario. The report remains available.

The launcher does not change the machine-wide PowerShell execution policy. Its `-ExecutionPolicy Bypass` applies only to the launched process running this reviewed local script.

## Linux and WSL

Use the same Node evaluator in the environment you intend to qualify:

```sh
node scripts/ultra-evaluate.mjs
```

An explicit destination and exact source check are available:

```sh
node scripts/ultra-evaluate.mjs --output /tmp/ultra-acceptance-01 --expect-sha FULL_40_CHARACTER_CANDIDATE_SHA
```

To isolate a failing scenario:

```sh
node scripts/ultra-evaluate.mjs --scenario B --output /tmp/ultra-recursion-01
```

WSL qualification does not establish native Windows or Desktop Code compatibility. Keep results labelled with their actual environment.

## The six scenarios

| Scenario | Actual exercised behavior | Expected result |
|---|---|---|
| A — Cheap author, strong validation | Luna produces a private cleanup-planner patch. Independent Astra and Sol reviewers find a consequential scope defect without seeing each other's conclusions. Sol reworks it; fresh Astra and Sol reviewers inspect the revised source. A fresh Luna examines omitted coverage and an Astra judge assesses it. A plan names the required fixture test; its synthetic executor-attested result binds to the revised source and plan hash. | Code approval is reached; a separate deletion request remains constrained by its execution gate and tool permissions. A staging capability cannot be substituted for deletion, and approval cannot create a missing deletion permission. Changing the source invalidates review evidence. No live file is changed. |
| B — Recursive mixed tiers | A real runtime loop asks the broker to recruit children. SWARM Sol delegates to Terra and Luna; REPLICATOR Sol requests a peer and invokes HELICOP-SOL; SKYNET Sol requests Astra with both mandatory supervisors. Parents cooperatively wait. | Children complete with recorded lineage, approvals and budgets. Restricted higher-tier implementation and mode laundering are rejected. |
| C — Model-dependent Claude authority | Trusted Opus and Fable use their own configurable profiles. Sonnet requires Sol consultation; Haiku defers restricted recruitment to Sol. An untrusted caller claiming Opus is separately tested. | Correct authority is applied without spawning any additional Claude model. The untrusted identity remains restricted. |
| D — Protected review capacity | All 12 Lite Core invocations are allocated, with four running Core workers and two running ordinary reviewers. A third ordinary reviewer cannot consume the reserved slot. The fixture owner explicitly preauthorises Sol peer review under Policy B; a substituted reviewer is rejected, and mandatory HELICOP-SOL runs in the protected slot. | Core saturation does not block independent review or mandatory supervision. A shared mission token ceiling still rejects excess reservations. |
| E — Permission profiles | A has no project-read tools. B reads a scoped fixture and rejects edits. Opt-in C produces a private stage patch through the same runtime boundary. Path traversal, live application and consequential execution are denied. | Profile-specific boundaries hold. C is qualified for private staging only; it does not demonstrate a safe general shell or live editing/testing sandbox. |
| F — Failure and recovery | A known accepted response is checkpointed, its worker lease expires, and a new broker/runtime resumes it by polling. An interrupted sending phase without a known response is recovered separately. | Known work resumes without another POST; ambiguous work stays blocked with conservative reservations. Accepted output remains preserved. |

The synthetic model backend does not decide the assertions. It emits ordinary Responses-style outputs and tool calls; the real implementation admits or denies them, writes its normal ledger, mediates tools, allocates fleets and advances reviews. Assertions inspect the resulting durable state and event chain.

The fixture's function tests only execute the evaluator's fixed, known pure-function source. They are not an operating-system sandbox and must not be repurposed to run arbitrary generated code.

## Reading the report

| File | Purpose |
|---|---|
| `summary.txt` | Human-readable PASS/FAIL result for every scenario and explicit untested host gates. |
| `report.json` | Complete scenario evidence, source commit where available, dirty-worktree flag, source fingerprint, environment and diagnostics. |
| `activity.jsonl` | Durable decision events for allocations, approvals, waits, review transitions, source changes and recovery. |
| `budgets.json` | Core/Review population and concurrency, synthetic token/dollar usage, outstanding reservations and remaining mission limits. |
| `owner-observations.json` | Optional Windows answers recorded after the run. A skipped check is NOT RUN. |

All token and dollar amounts inside the evaluator are fixture values used to exercise accounting. **Actual API requests and real API spend are zero.** They are neither provider invoices nor live performance measurements.

The source fingerprint identifies the tested source files even when the checkout is dirty or Git is unavailable. A dirty checkout is plainly labelled; do not describe it as qualification of a clean commit. For final acceptance, rerun after checking out the exact candidate SHA and confirming its clean state.

## Manual Windows and Desktop gates

After offline PASS, follow [Desktop installation](DESKTOP.md) and [host qualification](ULTRA_HOSTS.md) for the candidate's supported interfaces. Preserve the existing two-key setup and DPAPI storage. Never paste keys into prompts or acceptance reports.

Record each environment separately:

- Native Claude Code CLI on Windows.
- Claude Desktop Code in the supported local environment.
- WSL Code, if that is an intended environment.
- Claude Desktop Chat with the reproducibly built MCPB.

For Desktop Chat, verify ordinary think-only delegation first. Then explicitly select a disposable source root and verify read-only inspection plus an out-of-scope denial. Opt-in private staging can be evaluated without granting live execution. General editing/testing remains unavailable unless the installed trusted execution layer actually supplies the required protections.

Before any live API test, configure the intended model, key route, service tier, token/dollar limits and live-call authorisation. A successful offline test is not permission to spend credits. Live tests should retain exact source identity, requested and served model/tier, API usage, any denials, and the relevant mission/response IDs without storing credentials.

Do not mark actual Desktop UI or live API qualification PASS based on the offline fixture or a mocked MCP exchange.

## Failure handling

A scenario FAIL exits nonzero and records the error. Keep the report and leave the candidate on HOLD. Do not fix a policy rejection by weakening a guard or deleting the ledger. A setup failure exits with code 2; missing Node, an unexpected SHA or an incomplete candidate should be corrected before rerunning.

If an actual workflow stops, preserve its accepted results, source snapshots, approvals, reservations and ledger. Known response IDs can be reconciled by polling. An ambiguous request must not be retried automatically under another ID. See [accounting and recovery](ULTRA_ACCOUNTING.md).

A useful owner handoff contains the exact candidate SHA, `summary.txt`, `report.json`, `owner-observations.json` where applicable, and a brief description of any visible discrepancy. These files contain fixture source and operational metadata, not API keys.

## Automated integration suite

The reusable end-to-end suite runs the same A–F scenarios, exercises the execution store from six concurrent Node processes, verifies dead-owner recovery and rejects a tampered audit chain:

```sh
node --test plugins/openai-workers/tests/ultra-integration.test.mjs
```

Run the repository's complete test and package-validation workflows before proposing the stack for owner acceptance. Linux offline PASS does not substitute for source-matched Windows CI or physical Windows/Desktop testing.

# ULTRA-001 engineering handoff — Draft/HOLD

## Delivery decision

The candidate implements the shared recursive orchestration system and its deterministic qualification path. It remains **Draft/HOLD for owner acceptance**. ULTRA is disabled in all shipped profiles; live ULTRA API use and Desktop C each require separate opt-in. No merge, Ready promotion, deployment, destructive cleanup or live provider test was performed as part of implementation.

The usable implementation includes policy-governed recursion, model-dependent authority, two resource fleets, protected supervisory capacity, durable accounting and recovery, independent review/rework, scoped filesystem access, native Code adapters and Desktop Chat tools. **General command execution and applying staged patches to a live project are not provided by this distribution.** The execution boundary requires a separately qualified isolated executor; absent that executor it rejects the operation. This is a material limitation of the full C goal, not a completed capability inferred from its configuration.

Actual installed Claude Code validation, physical Windows 11/Desktop UI acceptance and live API qualification remain **NOT RUN**. Automated Windows CI is separate evidence and cannot substitute for these owner gates.

## Programme, stack and ancestry

Canonical programme: [issue #2](https://github.com/techrote/Chlaude-GPTopus/issues/2). The issue records the final exact candidate SHA, CI links and current owner gate status. Source-matched CI checks out the PR head directly and embeds that SHA in its offline reports.

| Order | Reviewable change | Published source identity |
|---|---|---|
| Existing integration | [Desktop PR #1](https://github.com/techrote/Chlaude-GPTopus/pull/1), preserved | `04f570d130eeed47f50c6353829f9bffccd33604` |
| 1 | [Policy foundation #3](https://github.com/techrote/Chlaude-GPTopus/pull/3) | `d09f3a6378aca7e522543d490eac5d56fe101143` |
| 2 | [Accounting hardening #4](https://github.com/techrote/Chlaude-GPTopus/pull/4) | `334cb67c4d6436bcd3d24761a0f7e6a3b87bf026` |
| 3 | [Recursive runtime and governance #5](https://github.com/techrote/Chlaude-GPTopus/pull/5) | `5ee6f0ccdd8c796b9a2c702285babce040d2e90e` |
| 4 | [Native/Desktop integration and owner qualification #6](https://github.com/techrote/Chlaude-GPTopus/pull/6), branch `ultra/004-integration` | Final PR head and exact CI evidence are recorded in issue #2. |

The programme was based on live `main` at `edd9392eae931ef19db82c84eb4d6d1167583fc4` and live PR #1 at the supplied verified head. Each ULTRA branch is stacked on its predecessor; no alternative copy of the Desktop implementation replaces #1. The runtime stage includes follow-up fixes found by actual Windows CI and independent source review. Its final tree is `a4e3716997fc288d50ca2b2de8e706827ee582f7`.

Recommended eventual merge order is **#1 → #3 → #4 → #5 → #6**, after the owner accepts the exact candidate. Retarget/rebase descendants deliberately if the chosen merge method rewrites ancestry. Rerun qualification after a rebase, conflict resolution, host API change or implementation change. Do not merge an intermediate stage as a declaration that the entire system is production accepted.

## What is operational

| Area | Demonstrated behavior | Evidence |
|---|---|---|
| Recruitment policy | SWARM/REPLICATOR/SKYNET/CUSTOM flags, explicit family/model classification, bounded inheritance, review-only escalation and scoped promotions | Policy suite, runtime scenario B, native recursion tests |
| Root authority | Separate Opus/Fable profiles; Sonnet consultation; Haiku deferral; unknown primary held; effective host model identity cannot be replaced by caller text | Policy, native and independently authored security/source tests |
| Supervisors | Real runtime-created Sol/Astra decision allocations, protected capacity, APPROVE/REJECT/MODIFY/ESCALATE, mandatory/veto combination rules, root authority and key-transition checks before paid invocation | Scenarios B/C/D and independent regression suites |
| Approval scope | Request/policy hashes, one-use votes, bounded revision, explicit escalation, batch decisions and conspicuous bounded future-plan authorisation | Broker, CLI, native exact-request tests and plan/replay regressions |
| Risk | Complexity, consequence and verification assessed independently; auditable scoped overrides with expiry; changing risk invalidates old in-flight reviews | Policy and architecture/source regressions |
| Review | Task-level trusted Policy B selection; actual HELICOP Policy C selector; blind or explicitly informed second opinion; Core-funded alternative reworker; fresh or explicitly resumed gap inspector; final judge | Scenario A, review controller and native workflow tests |
| Evidence | Immutable source/evidence identity, separate content hash, explicit coverage map, source-bound trusted tests, stale action/review rejection and bounded fresh adjudication after missing evidence arrives | Architecture and integration suites |
| Fleet scheduling | Lite Core 2/12/4 and Review 2/12/3, one protected supervisor slot, independently preserved depth, cooperative waits and shared mission ceilings | Scenarios B/D and cross-process tests |
| Accounting | Strict two-key routing, full-month aggregates despite day pruning, conservative unknown usage/prices, request reservations, response deduplication, midnight attribution and ambiguous-failure retention | Accounting and usage suites; shared bridge tests |
| Files | Actual A/B/C checks, canonical roots, traversal/secret/link rejection, descriptor verification, private staged writes, source-bound patches and conflict rejection | Real filesystem permission tests and scenario E |
| Consequential action | Distinct exact action, configured judge/human votes, immutable evidence, single-use consumption and actual capability recheck | Action, native and permission tests; scenario A rejection |
| Recovery | Known response resumes by poll; ambiguous sending/tool phases stay held; accepted output, stages and reservations persist | Scenario F, independent crash/cancel tests |
| Interfaces | Native supported hooks plus protected primary tools, public/private MCP separation, actual extracted MCPB service, readable local CLI/configuration workflow | Native, Desktop/protocol and source suites |

The implementation does not spend automatically merely because fleet capacity is available. Models are assigned independently to author, primary reviewer, reworker, second reviewer, gap inspector and judge roles. Per-worker API reasoning ranges remain enforced through the existing worker configuration; ULTRA is never sent as a new API reasoning-effort value.

## Qualification record

The frozen complete candidate passed **215/215 tests, with zero skips or failures**, on Linux Node v24.22.3. The architecture and security reviewers each independently reran all 215 tests after the Windows checkout and canonical-fixture corrections. The runtime, permission boundary and extension payload are unchanged by those portability corrections. It includes existing worker/effort/protocol/usage tests, accounting regressions, policy checks, recursive A–F integration scenarios, real filesystem and cross-process tests, native adapter tests and independently authored architecture/security/source regressions. Fault injection includes ambiguous network responses, cancellation, stale evidence, restart phases, concurrent admission, unknown cost and Windows sharing errors.

Independent regressions comprise 27 architecture, 31 security and 8 fresh source tests. The native adapter has 22 tests and the actual filesystem boundary has 13. The remaining suites cover the preserved integration, accounting, policy, A–F, protocol/packaging and Windows retry fault injection. These subset counts are included in the 215 total.

The final CI matrix targets **Node 20 and 22 on Linux and Windows**, builds the committed MCPB byte-for-byte, and validates its manifest with the official MCPB toolchain. Node 22 jobs also publish exact-source A–F reports. The Windows job executes the real PowerShell owner entry point noninteractively. The final exact run and counts are posted in issue #2; a green earlier commit is not qualification of a later changed head. The final runtime-stage head `5ee6f0ccdd8c796b9a2c702285babce040d2e90e` passed its four-job matrix in [run 44912725277](https://github.com/techrote/Chlaude-GPTopus/actions/runs/44912725277).

Actual Windows Node 20 CI exposed a delete-pending/share race while opening the execution ledger's exclusive lock. The correction retries only bounded Windows `EPERM`/`EACCES`/`EBUSY` file-operation failures. It retains `wx` exclusivity, nonce-checked release, dead-PID recovery and timeout failure. It never steals a live lock or treats access denial as successful acquisition. A corrected four-job run is recorded at [44912275905](https://github.com/techrote/Chlaude-GPTopus/actions/runs/44912275905); later core/source changes require their own final run.

The first final-integration CI run also caught a Windows-only package mismatch: Git converted newly added bundle inputs to CRLF because the old attributes covered only the legacy files. The corrected attributes preserve LF for all text while retaining the MCPB as binary. An independent regression exercises a real `core.autocrlf=true` Git checkout, reproduces the old omission and verifies the corrected checkout against the committed package. The extension payload itself is unchanged by this portability correction. Once packaging passed, Windows CI identified one test fixture that put the ledger under the runner's noncanonical temporary-directory alias. The successful-staging fixture now uses the canonical temporary directory, matching the existing permission fixtures. The strict path-alias denial remains unchanged; owner state-directory overrides must also use canonical paths.

Offline tests use synthetic provider responses and authority votes, with real production control-plane paths. **Real OpenAI API requests: zero. Real API spend: zero.** Synthetic token/dollar numbers are test inputs. They are not measured model performance or provider billing.

### Independent review

Three distinct review streams examined implementation they did not author:

- [Architecture review](ULTRA_ARCHITECTURE_REVIEW.md): independent of implementation, including the original policy foundation; adversarial regressions cover shared budgets, authority inheritance, review freshness, convergence, task assignments, risk overrides and execution evidence.
- [Security/source review](ULTRA_INDEPENDENT_REVIEW.md): reviewed broker/runtime/permissions/native/bridge code, excluding its own earlier foundation contribution. The architecture reviewer covers that foundation. Regressions cover forged principals, approval replay, provider substitution, key-transition laundering, cancellation, restart and host bypasses.
- [Fresh source/integration review](ULTRA_SOURCE_REVIEW.md): independent of all implementation; checked new native control operations, Desktop metadata and package boundary, redirected human approvals, supervisory bootstrap, shared retries and active risk propagation.

Reviewers reproduced defects, implementation fixes were made separately, and the independent regressions were rerun. Their reports retain exact file identities and explicitly limit their conclusions to inspected source and observed tests. Findings corrected include risk invalidation of in-flight reviews, revised reviewer assignment provenance, trusted test evidence reaching the final judge, restricted-root supervisor bootstrap, shared mission retry counting, current risk reaching native review, and the Windows lock portability issue. No automated source review claims to prove security against a hostile operating system or compromised same-user process.

## Default policy and controlled alternatives

| Control | Shipped default | Owner can configure |
|---|---|---|
| ULTRA | Disabled | Explicit enablement in owner policy |
| Recruitment | SWARM; review-higher exception enabled | REPLICATOR, SKYNET, CUSTOM flags; per-worker modes and root ceilings |
| Fleet | Core 2/12/4; Review 2/12/3; one protected Review slot | Independent fleet limits plus shared mission ceilings |
| Review | Policy B, Astra review/re-review, Sol rework/second opinion, fresh Luna gaps, Astra judge, three rounds | Task-level trusted B selection; Policy C; models, additional rounds and evidence/convergence controls |
| High/critical work | Two independent opinions and coverage-gap inspection | Impact classes and stronger owner requirements |
| Free-to-paid | B; approval above 16,000 tokens or $0.25 allocated estimate | A within explicit mission dollar ceiling; C always human approval |
| Consequential action | Risk-based gate, human authority | Eligible trusted primary or fresh Sol/Astra judge, with configured combinations |
| Chat access | A, think-only | B roots; separately enabled C private stages |
| Live provider use | Disabled for ULTRA | Local environment/extension opt-in after policy and budget review |

See the [operational guide](ULTRA.md) for validated JSON examples and the CLI. `OPENAI_ULTRA_CONFIG` selects an owner-controlled policy file, so projects/missions can use distinct profiles without trusting configuration found in untrusted project source. Existing environment/PowerShell worker model, tier and reasoning settings remain in force; policy allocations and transport settings must agree. Unknown models need explicit family classification, supported routing and known pricing before guarded execution can proceed.

The owner CLI shows exact proposals before interactive human approval. `record-test` records an observed test result and does not execute it. `risk-override` changes one allocated work classification for a bounded period and grants no tool or spending power. Plan approval explicitly authorises future bounded recruitment without inspecting each spawn; it cannot waive mandatory supervisors, tool boundaries or execution gates.

## Material limitations and residual risks

**Installed host validation remains required.** Official Claude Code declarations and documentation were inspected, but this environment has no installed `claude` executable or Desktop application. Native protected mode requires the documented hook surface (minimum 2.1.326), uses host identity, preserves native asks/denials and rejects unsupported/hosted arrangements. Desktop Code WSL currently lacks the required plugin support; standalone WSL CLI must be tested separately. See [host findings](ULTRA_HOSTS.md) for exact sources and declaration identity.

**Surface detection is documented but not host-qualified.** Native Code ceilings depend on the mod reading `$.session.surfaces()` (values `terminal`/`desktop` per the published declarations and documentation, inspected 2026-11-21 without an installed host). Neither the exact value reported by the installed Claude Code CLI or Desktop Code runtime, nor a Desktop Code session that also draws on a terminal, has been observed. Unreported or unrecognised values deliberately fall to the think-only ceiling, so a mismatch removes Code file tools rather than granting them; `/ultra` diagnostics show the resolved surface. Qualify both hosts before relying on B/C for Code. Surfaces attached after session start are not re-evaluated; VS Code and mobile are not qualified surfaces. `permissions.tools`/`permissions.roots` are still a single owner grant shared by all surfaces.

**C is private staging only.** No complete OS sandbox or live patch-application executor is shipped. Native protected mode also blocks arbitrary primary/worker shell, live file tools, unknown external tools, ungoverned Claude intermediaries and Code Mode REPL execution. Owners must qualify a bounded isolated executor separately before generated tests or consequential live operations can run through that boundary. The configured judge gate alone cannot make unavailable execution safe or possible.

**Local accounting is conservative, not provider billing.** It cannot see calls made outside this installation or other machines. Accepted upstream requests may exceed an estimate. Unknown pricing or missing usage holds relevant guarded admission, and ambiguous calls retain reservations. Full monthly estimates survive pruning of daily detail. The $88 monthly reference remains informational unless a separate enforceable local limit is configured. Do not manually zero a ledger to clear a hold.

**The trusted computing base is explicit.** The installed host/mod, bridge process, owner policy and operating-system account are trusted. Same-user malware, a malicious separately installed plugin or a hostile administrator is outside the boundary. Snapshot/event hashes detect corruption but are not signatures against an attacker who can rewrite the trusted storage and code. Root scopes and secret exclusions remain necessary when selecting a project.

**Risk and source meaning require evidence.** Structured risk is supplied by the assigning authority and is not an independent proof that the classification is true. Arbitrary public review snapshots are labelled as caller-supplied immutable content; native review starts from stored author output/private patch evidence. An unchanged hash proves identity, not correctness. Tests must represent observed results, and current high-severity findings must be explicitly resolved.

**Conservative recovery can require an operator.** Known provider response IDs can be polled without another POST. Ambiguous request/tool phases stay held, preserving work and accounting. There is no generic force-resume or unsafe ledger-reset command. An operator must reconcile provider/host evidence before authorising fresh work. Owner-controlled policy changes require a newly authorised mission on the public Chat surface rather than silently widening an existing one. On a native Code session a policy change can only tighten the open session (the stricter of the frozen and current owner policy applies at once and is never lifted); see "Capability ceilings per surface" in [ULTRA.md](ULTRA.md).

## Windows owner actions

Use a fresh checkout of the final integration branch or exact SHA from issue #2. Keep the existing installation unchanged during evaluation. With Node installed, the initial command is:

```powershell
& .\scripts\Run-ULTRA-Evaluator.cmd
```

For a source-pinned noninteractive run, use the real full SHA in place of the placeholder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Evaluate-ULTRA.ps1 `
  -NonInteractive -ExpectedSha FULL_CANDIDATE_SHA `
  -OutputDirectory C:\Temp\ULTRA-Owner-Acceptance-01
```

Review `summary.txt`, `report.json`, `activity.jsonl` and `budgets.json`; retain the optional PASS/FAIL/NOT RUN owner observations. These reports preserve source identity and distinguish offline evidence from actual Desktop/API testing.

Before production use, complete these owner gates:

1. Confirm the exact source, clean checkout and green final Linux/Windows CI; review all independent reports and accepted limitations.
2. Run the offline evaluator on physical Windows 11 and record the results. A hosted Windows Server CI runner does not establish this gate.
3. Validate the installed Claude Code plugin against its actual generated declarations and run supported host tests. Check local Desktop Code separately and record both application/runtime versions.
4. Install the candidate MCPB in Desktop Chat; verify A, then B on a disposable selected root, including out-of-scope and secret/link denials. Treat C as private staging only.
5. Set explicit mission budgets, key routes, model/tier/effort settings and approval authorities. Authorise a small live API smoke test only if desired, retaining real usage and served-model evidence.
6. Keep merge, deployment, deletion and live patch application behind their separate authority and qualified-executor gates. Decide whether the candidate's stated limitations meet the intended production use before changing any Draft/HOLD status.

A failed gate leaves the candidate on HOLD. Preserve evidence rather than weakening the policy to make a test pass. The canonical issue is the place to attach owner results and decide the eventual merge sequence.

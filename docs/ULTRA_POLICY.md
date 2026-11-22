# ULTRA policy foundation

ULTRA controls orchestration. It never sends `ultra` as an API reasoning effort. The six existing worker profiles, their reasoning ranges and their API-key routes remain separate from recruitment authority.

Project-access ceilings (`desktop` for Chat, `surfaces.codeCli`, `surfaces.desktopCode`) are separate, validated sections that default to A and are included in the policy hash; scoped layers may only lower them. See [Capability ceilings per surface](ULTRA.md#capability-ceilings-per-surface).

ULTRA is **disabled by default**. The JSON examples in [`config`](../config) are complete, editable owner configurations. `ultra-lite.json`, `ultra-balanced.json`, `ultra-research.json` and `ultra-critical.json` retain `enabled: false` until deliberately enabled. Increasing a fleet allowance does not launch additional agents.

## Policy resolution and validation

`ultra/config.mjs` provides `resolveConfig`, `validateConfig`, `profileConfig`, `migrateConfig` and `policyHash`. Configuration version 1 is the only supported version; unsupported versions fail before execution and the source file remains untouched. Missing optional settings are filled from defaults. Unknown fields, malformed values, prototype-related keys, ambiguous key routes and unclassified models fail validation.

A plain configuration object is **trusted owner configuration**, loaded by the local control plane. It must never be accepted from an agent's tool arguments. Additional project, worker, mission and stage layers may be supplied as `{scope, value, authorised}` wrappers. Without explicit owner authorisation they may tighten resource and permission ceilings but cannot rewrite model classifications, supervision rules or approval authority. Changes that would expand authority require a trusted owner configuration update or a separately audited broker promotion.

Every decision includes the canonical SHA-256 policy hash, schema version, exact model, role, key profile, permission allocation, risk assessment and an explanation trace. Object key ordering does not change the hash. Configuration changes do.

## Recruitment modes and inheritance

| Mode | Lower tier | Same tier | Higher tier |
|---|---|---|---|
| SWARM | Allowed | Denied | Denied |
| REPLICATOR | Allowed | Allowed | Denied |
| SKYNET | Allowed | Allowed | Allowed |
| CUSTOM | Independent flag | Independent flag | Independent flag |

Modes are presets over three independent flags. The defaults rank Astra above Sol above Luna above Terra. Exact model IDs are classified in `models`; worker profiles resolve to those IDs. Standard/Flex Sol share Sol rank and paid/daily Astra share Astra rank. Price, key and reasoning effort never change capability rank. An owner may add exact model classifications or explicit per-model rank exceptions. Unknown IDs receive no inferred authority.

Each child receives the intersection of the root ceiling, parent permissions, active mode and optional worker/mission scope. Requesting SKYNET from a SWARM descendant cannot expand that intersection. The tool list and project roots are independent of recruitment: an Astra reviewer may have read-only access while a Luna author receives a scoped edit grant.

`reviewHigher` is a separate exception. A SWARM Luna can ask for a higher-tier Astra review when enabled. That Astra allocation is read-only and cannot recruit implementation workers. Review follow-ups return to the workflow controller, which must allocate any modifying reworker from Core. This prevents turning review escalation into general higher-tier recruitment.

## Orchestrator identity and supervisors

The adapter supplies trusted host identity separately from the tool request. A caller-provided model name cannot establish Opus authority. Without verified identity, the restricted profile applies. A local owner may instead configure a specific identity with an authorising reference and expiry.

| Existing primary orchestrator | Default restricted-recruitment decision |
|---|---|
| Opus | Full authority within the mission ceiling |
| Fable | Equivalent initial authority, independently configurable |
| Sonnet | Sol consultation and configured final approval |
| Haiku | Sol makes the Sol/Astra recruitment decision |
| Unknown/unverified | Explicit user authority for Sol/Astra |

No additional Claude model call is needed for these rules. A trusted identity never grants access outside the root's permissions or budgets.

HELICOP rules can match mode; exact parent/child model and family; role/purpose; complexity, impact and verifiability; confidence; tool permissions; free/standard transition; estimated tokens/cost; population, concurrency and depth. The shipped rules require HELICOP-SOL for Sol→Sol and HELICOP-ASTRA for Sol→Astra. Their toggles are independent. Disabling a helicopter does not erase a separate required identity/risk/transition gate: an unavailable mandatory authority stops admission.

`combineApprovals` evaluates authenticated, request-bound decisions supplied by the broker. Mandatory and veto rejections prevail in every combination. AND and veto wait for all applicable responses; OR permits an eligible optional approval only after mandatory gates pass; prioritised authority uses the highest-priority optional gates; escalation returns a disagreement for explicit escalation. MODIFY returns a revised proposal for complete revalidation. No combination silently turns a missing decision into approval.

The policy function does not authenticate an approver or mint approval tokens. The durable approval engine binds identities, independent authorship, request hashes, source evidence, scope and expiry before using these pure decisions. Mandatory supervisor allocation is a narrowly bound broker operation for an existing pending gate, not a caller-selected privileged role.

## Risk, reviews and consequential actions

`assessRisk` treats complexity, failure impact and verifiability separately, with confidence and rationale. Destructive, external, persistent, deployment, security/privacy and irreversible effects raise effective impact; organisation/public blast radius requires critical controls. Unknown impact, weak verification or insufficient confidence requests further scrutiny.

A low-complexity cleanup script can therefore stay assigned to Luna while receiving independent senior review, two opinions, gap inspection, dry-run evidence and a separate execution approval. High impact does not automatically replace the author with a more expensive model.

The default review configuration selects policy B, three rounds, Astra primary/re-review, Sol rework/second opinion, and a fresh Luna coverage-gap inspector. High/critical impact receives two independent reviews and gap inspection. Policy C adds a supervisor gate to reviewer selection. The review controller implements these assignments and freshness/convergence checks; a configuration object alone is not evidence that a review ran.

Consequential execution defaults to explicit user authority. Recruitment, testing, code acceptance and execution remain separate gates. A valid review decision does not permit deletion, deployment or merge. An authorised risk override records the original assessment, replacement, authority, rationale and expiry.

## Required-test manifest

`review.requireTests` used to be satisfied by any non-empty set of passing results, so one unrelated smoke test could approve high-impact work. Acceptance now rests on an explicit, source-bound **verification plan**.

**What must be proven.** The effective required set is the owner-policy tests plus plan items, with no way to remove either through the workflow:

- `review.requiredTests` (owner configuration only; scoped layers cannot alter `review`): `[{ id, description?, impacts?, areas?, executable?, commandDigest? }]`. `impacts` selects the effective-impact tiers; `areas` (`security`, `privacy`, `destructive`, `external`, `deployment`, `persistence`) follow the trusted risk flags, never author text. `commandDigest` pins the exact command whose execution counts. `executable: false` marks a test that cannot be run safely.
- A workflow plan is registered at `start({ testPlan: { id?, entries }, principal })` or later with `addRequiredTests`. The library accepts the trusted local owner or a full trusted native orchestrator as principal, **but the only shipped production entry point is the owner CLI (`plan-add`, below): no native or MCP tool exposes plan registration, waiver or evidence recording**, so in a shipped installation a plan is the local owner's gesture. Review agents can only *request more* through a report's `requiredTests`; their requests are always executable, never change an existing id, and are recorded as `requirementsAdded/Ignored`.
- Removing or redefining a plan entry (`changeRequiredTests`) needs the trusted `local-user`, a reason, and cannot touch owner-policy entries. Every plan change revokes `code_approved`, stales actions that have not been consumed (`pending` or `approved`) and changes the plan hash. The same holds for new evidence, waivers, source changes, risk overrides and withdrawn approvals. An action that was already consumed (`executing`) keeps its state: the effect may already be running, so it can still `complete` and record its result, and the ledger keeps the source hash, plan hash and approval time it was consumed under (`executedUnder`). `ActionGate.complete` does not re-check the workflow; a later contradiction does not undo an effect that already happened, it only prevents new consumption.
- Work that demands tests (`assessment.controls.tests` with `requireTests`) but designates none is **held as `unplanned`** when its effective impact is in `review.testPlanRequiredImpacts` (default `high`, `critical`, `unknown`). Below those tiers the former rule survives, reported as `some-passing-evidence`: still contradiction-aware, never latest-wins. Setting `testPlanRequiredImpacts: []` is an explicit owner downgrade. A designated test is enforced even when `requireTests` is `false`; that flag only removes the *demand* for a plan.

**What counts as evidence.** A record must name a manifest id, the exact `sourceHash` and the current `planHash` (a digest of workflow id, plan id, source hash and every required entry). The controller derives its class; callers cannot assert it:

| Class | Principal | Requirement | Satisfies |
|---|---|---|---|
| `executed` | trusted `test-runner` | attestation `{ runnerId, commandDigest, exitCode, sourceHash, qualification: 'trusted-executor' }`; `passed` must equal `exitCode === 0`; a pinned `commandDigest` must match | every tier |
| `owner-attested` | trusted `local-user` (authority `user`) | a human record, no attestation | only tiers in `review.ownerAttestedImpacts` (default `low`, `medium`; never `high`/`critical`/`unknown` unless the owner adds them) |
| `unattested-runner` | trusted `test-runner` without attestation | none | only the legacy `some-passing-evidence` tier |

`w.source.tests` (author claims), review summaries and report text are never evidence. Evidence for another source, another plan hash, or recorded before the plan existed is ignored; unrelated ids are listed in `requiredTests.unrelated` and never count.

**Per-test state** (`workflow.requiredTests`): `satisfied`, `missing`, `failing`, `contradictory`, `waived`, plus aggregate `unplanned`/`some-passing-evidence`/`not-required`. A failure beside an eligible pass for the same test, source and plan is **contradictory** and blocks. Only a record with `supersedes: [ids]` and a `reason`, from an attested runner or the local owner, in a tier-eligible class, removes earlier records of the same test/source/plan; superseded records stay in the ledger. A held workflow names exactly what is missing, for example `missing [regression:junction]`. When evidence later completes the set the workflow takes one bounded re-adjudication from the shared mission retry budget. If that budget (or the workflow's own re-adjudication count) is exhausted the workflow stays held, but its reason now says so (`Required test evidence is satisfied but fresh adjudication cannot run: the retry limit is reached (mission N of M retries used ...)`) instead of a stale `missing [...]`; a later failing or contradictory record turns the reason back into a test diagnostic. The defined owner remedy is `ReviewController.restart(missionId, workflowId, { reason, source?, risk?, testPlan? }, principal)`: the trusted local owner supersedes the held workflow (status `superseded`; it accepts no further evidence, waiver, plan change or report) and an independent fresh review of the same source (or an owner-supplied replacement) starts in its place in one transaction. The successor has no evidence, no agent-added requirements and no re-adjudication count; owner-policy tests and the owner-registered plan entries carry over unless a new `testPlan` is given. A restart is an owner decision and does not draw on the exhausted retry budget; the new reviewers are bounded by the ordinary fleet, mission and spending limits, and unfinished review nodes of the superseded workflow are cancelled (incurred usage retained). There is no CLI or MCP entry point for `restart` in this layer; it is a controller API for the host that owns the workflow.

**Tests that cannot safely run.** An entry with `executable: false` is satisfied only by `waiveTest` from the trusted local owner with a rationale, bound to the source and plan hash (any later change voids it). Evidence cannot satisfy it. Critical-impact waivers are refused unless `review.allowCriticalWaivers` is true. The approval record (`workflow.approval`) carries the plan id/hash, each test's state and the full waiver records.

**Owner routes (shipped).** `ultra/cli.mjs` provides `test-status`, `plan-add`, `waive-test`, `record-test`, `test-digest` and `run-test` (see [ULTRA.md](ULTRA.md#getting-high--critical--and-unknown-impact-work-to-code-approval)). Each state change needs an interactive terminal, shows the exact record and its digest and binds the confirmation to the plan and source hash it displayed. `run-test` is the one place a `test-runner` principal is created: it executes the owner's typed argv in an approved root (no shell, minimal environment, timeout, output cap) and attests the command digest, exit code, runner id and source hash. `waive-test` is the only way to satisfy a non-executable test. `record-test` stays owner-attested.

Limitations. The controller **records and evaluates** attestations; the production executor is the owner CLI's `run-test` (not a sandbox, and unable to prove that the tree it runs in holds the reviewed snapshot), and the controller cannot authenticate the principal objects handed to it: executor identity and `commandDigest` are only as trustworthy as the host code that builds them. A runner must re-record under the new plan hash after a plan change (including a reviewer-requested addition), which may mean re-running tests. `ActionGate` still checks only `status === 'code_approved'` and the source hash; `approval.planHash` is available for a stricter check. Workflows started before this change have no stored plan, so owner-policy tests are derived on the fly and high-impact ones are held as `unplanned` until a plan is added. `scripts/ultra-evaluate.mjs` scenario A had encoded the old rule (one arbitrarily named test) and now registers a plan and a synthetic fixture attestation; it remains an offline fixture, not host qualification.

## Fleets and spending

Lite sets Core depth/invocations/concurrency to **2/12/4** and Review to **2/12/3**, reserving one Review slot for mandatory approvals. Depth counters for both fleets remain in every descendant's lineage. Moving between roles cannot reset an exhausted counter; modifying rework always consumes Core.

Mission ceilings apply across both fleets: `maxTokens`, `maxUsd`, `maxWallMs`, `maxOutstanding`, `maxJobs`, `maxRetries`, and `requestsPerMinute`. Optional `perKey` and `perModel` maps contain `{maxTokens, maxUsd, maxRequests}` limits; `null` leaves a limit unset. Counts and incurred usage belong to the durable broker and ledger, including active reservations. The policy evaluator checks structure and allocation semantics; it is not an atomic quota store.

Free-to-paid policy A requires a known estimate and an explicit mission dollar budget. B permits requests within configured token/cost thresholds and requires approval beyond them or when estimates are missing. C always requires user approval. Neither recruitment mode nor a supervisor may silently change the configured worker, service tier or key. The `$88/month` reference remains informational unless an explicit local spending ceiling is configured; local estimates are not OpenAI billing figures.

## Evidence and boundary

Run `node --test plugins/openai-workers/tests/ultra-policy.test.mjs` from the repository root. These deterministic tests exercise all modes and CUSTOM combinations, identity confusion, model aliases/classification, independent HELICOP conditions and vetoes, privilege laundering, review escalation, risk separation, root/path attenuation, depth and spending-transition policy. They do not claim successful live API calls, Claude Desktop UI qualification or filesystem race safety. Canonical paths, reparse points, command execution and approvals are enforced by the execution bridge and its separate tests.

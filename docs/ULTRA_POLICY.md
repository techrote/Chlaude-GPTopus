# ULTRA policy foundation

ULTRA controls orchestration. It never sends `ultra` as an API reasoning effort. The six existing worker profiles, their reasoning ranges and their API-key routes remain separate from recruitment authority.

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

## Fleets and spending

Lite sets Core depth/invocations/concurrency to **2/12/4** and Review to **2/12/3**, reserving one Review slot for mandatory approvals. Depth counters for both fleets remain in every descendant's lineage. Moving between roles cannot reset an exhausted counter; modifying rework always consumes Core.

Mission ceilings apply across both fleets: `maxTokens`, `maxUsd`, `maxWallMs`, `maxOutstanding`, `maxJobs`, `maxRetries`, and `requestsPerMinute`. Optional `perKey` and `perModel` maps contain `{maxTokens, maxUsd, maxRequests}` limits; `null` leaves a limit unset. Counts and incurred usage belong to the durable broker and ledger, including active reservations. The policy evaluator checks structure and allocation semantics; it is not an atomic quota store.

Free-to-paid policy A requires a known estimate and an explicit mission dollar budget. B permits requests within configured token/cost thresholds and requires approval beyond them or when estimates are missing. C always requires user approval. Neither recruitment mode nor a supervisor may silently change the configured worker, service tier or key. The `$88/month` reference remains informational unless an explicit local spending ceiling is configured; local estimates are not OpenAI billing figures.

## Evidence and boundary

Run `node --test plugins/openai-workers/tests/ultra-policy.test.mjs` from the repository root. These deterministic tests exercise all modes and CUSTOM combinations, identity confusion, model aliases/classification, independent HELICOP conditions and vetoes, privilege laundering, review escalation, risk separation, root/path attenuation, depth and spending-transition policy. They do not claim successful live API calls, Claude Desktop UI qualification or filesystem race safety. Canonical paths, reparse points, command execution and approvals are enforced by the execution bridge and its separate tests.

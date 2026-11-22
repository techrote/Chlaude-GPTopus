# ULTRA recursive runtime and offline qualification

This stage adds executable orchestration behind the opt-in policy foundation. It does not enable the existing plugin or Desktop extension automatically.

## Run the implementation without API credits

From the repository root:

```sh
node scripts/ultra-evaluate.mjs --output /tmp/ultra-owner-evaluation
node --test plugins/openai-workers/tests/ultra-integration.test.mjs plugins/openai-workers/tests/ultra-permissions.test.mjs
```

On native Windows, run `scripts\Run-ULTRA-Evaluator.cmd`. The [acceptance guide](ULTRA_ACCEPTANCE.md) describes the disposable projects, all six scenarios, source fingerprint, activity trace, budget report and separate physical-host acceptance questions.

## Implemented control plane

| Module under `plugins/openai-workers/ultra` | Executable responsibility |
|---|---|
| `store.mjs` | Cross-process lock, atomic durable snapshot, snapshot integrity checksum and hash-linked audit events. Dead owners can be recovered; a live lock is never stolen merely because it is old. |
| `broker.mjs` | Root/parent lineage, recursive recruitment, authenticated approvals, scoped promotions, risk overrides, bounded revisions/escalations, batch/plan approvals, two fleets, shared budgets, leases, waiting and recovery. |
| `runtime.mjs` | Responses-style API loop with the actual broker and permission boundary, worker key/model/tier binding, pre-POST admission, durable checkpoints, recursive child tools and cooperative scheduling. |
| `review.mjs` | Assigned reviewers, blind second opinions, specialist Core rework, fresh or explicitly reused gap inspection, source-bound evidence, convergence and independent adjudication. |
| `actions.mjs` | Exact proposed action identity, distinct authority votes, fresh code evidence and single-use execution permission. Approval does not add a missing tool capability. |
| `permissions.mjs` | Canonical root/file validation, secret/link protections, bounded reads, private staged patches and a separately attested execution-adapter boundary. |

The injected offline backend emits normal model outputs and tool calls. It does not bypass policy or decide whether a scenario passes. Assertions examine the resulting durable graph, approvals, reservations, files and review states. A live transport must be explicitly authorised, and its verified provider usage is committed even if it exceeds a local estimate.

Core and Review have independent depth, lifetime invocation and concurrency allowances. A waiting parent releases its running slot. Ordinary reviews cannot consume the reserved supervisory slot. Both fleets still share mission token, dollar, time, request and job ceilings. Approval reviewers cannot recruit more approval reviewers.

## Evidence, changes and recovery

Review source identity covers the complete immutable source/evidence snapshot; a separate content hash detects unchanged implementation and oscillation. Reports cannot overwrite trusted node/role/source provenance. Trusted tests are recorded separately from author-declared tests and sent to the final judge. Acceptance requires every test in the source-bound required-test manifest (owner policy plus trusted plan, see [ULTRA_POLICY.md](ULTRA_POLICY.md#required-test-manifest)) to be satisfied by current executed or tier-permitted owner-attested evidence, or explicitly waived by the owner. Missing-test holds can receive a bounded fresh adjudication after valid evidence arrives.

A revised controller request keeps its originating key route and exact review role/source/task. Its workflow assignment is rebound in the same admission transaction, preserving predecessor history. An authorised risk override records original and replacement assessments, scope, rationale, principal and expiry; it invalidates prior workflow evidence without expanding tools or budgets.

Known accepted provider responses may resume by polling. A crashed sending or tool-execution phase without conclusive evidence remains held. Accepted results, patches and uncertain usage are retained. No recovery path assumes that a lost network reply meant zero spend or no execution.

## Limits of this stage

These are model-independent deterministic tests plus real local filesystem/process tests. They do not establish actual Claude Code or Desktop UI acceptance, provider latency/reliability, physical Windows owner approval, or safe arbitrary command execution. Profile C creates private staged patches; the distribution does not supply a general operating-system sandbox or automatic live-project patch application. The host adapters and owner configuration workflow are delivered in the following Draft/HOLD stage.

# ULTRA-001 independent security and source review

## Scope and independence

This review was performed by an agent that did **not** implement the durable store, recruitment broker, review controller, action gates, runtime, permission boundary, native controller, or public service reviewed here. The reviewer **did implement the policy foundation** (`config.mjs`, `policy.mjs`, `risk.mjs`) and therefore does not claim independent approval of those modules. A separate architecture reviewer covers that foundation.

The review concentrates on actual admission, execution, provenance, accounting, cancellation and recovery behaviour. It is not a style review. Regression tests are in `plugins/openai-workers/tests/ultra-independent.test.mjs`; they call the real broker/controllers, use temporary filesystem fixtures where relevant, and use explicitly offline provider doubles. No live API request, user project modification or consequential external execution was performed.

## Qualification status

**Final frozen-source gate: 214/214 tests pass, including all 31 regressions independently authored for this review; no open concrete security/source finding remains within the reviewed scope.** The tests were developed from concrete source findings, with regression failures recorded during implementation and corrected before the passing checkpoints. Actual native hook registration, private/public MCP routing and the declared host event shapes have been inspected. Passing deterministic tests qualifies the stated local behaviour; it does not certify the installed host, a live API call or an operating-system sandbox.

The exact frozen file identities and reproduction commands are recorded below. The integration baseline is Desktop PR #1 at `04f570d130eeed47f50c6353829f9bffccd33604`; the independently excluded policy foundation was committed as `638471aaf8ebd61f6c3bc213dc8e98164b053d64`. Accounting hardening was committed separately as `91f789927f93445558efdff01b905c4615311b4a`.

## Findings and resolutions

| ID | Original defect | Resolution verified by the independent regression |
|---|---|---|
| IR-01 | A trusted native orchestrator could name a HELICOP or human authority and satisfy a different authority's gate. | Principal source is bound to the permitted authority; native orchestration cannot impersonate independent/human approval. |
| IR-02 | Approval revalidation checked only for outright rejection, allowing newly applicable mandatory rules to be omitted. | The latest requirements are combined with still-valid decisions before allocation. |
| IR-03 | Undefined optional event properties were hashed before JSON removed them, corrupting the durable audit chain. | Canonical persistence and audit hashing agree for omitted object fields and null array entries. |
| IR-04 | Model-supplied review reports could overwrite trusted reviewer identity and role, permitting a single reviewer to masquerade as two opinions. | Reports cannot replace provenance fields; independent roles and distinct allocations are checked. |
| IR-05 | Workflow creation ignored configured review assignments and inferred consequence only from the raw impact string. | Owner review settings and effective risk controls apply; destructive low-complexity work retains a cheap author while receiving stronger verification. |
| IR-06 | Workflow arguments could disable required second opinions/gap inspection or downgrade the author's admitted risk. | Required controls cannot be removed by workflow arguments, and the admitted author risk supplies a minimum control floor. |
| IR-07 | Identical source text with changed test evidence retained the same review identity. | Source/evidence identity includes the verification snapshot, invalidating stale approval when it changes. |
| IR-08 | Repeated revisions of the same rejected request created unbounded sibling proposals while each retained a low revision count. | Revised predecessor consumption and bounded revision controls prevent sibling retry bypass. |
| IR-09 | An execution approval could still be consumed after mission cancellation. | Current mission/agent state is checked when consuming the exact action-bound grant. |
| IR-10 | A completed-before-wait race or cancellation of a waited-for child stranded its parent. | Waiting-parent readiness is refreshed for already-terminal and cancelled children. |
| IR-11 | Known API usage above an allocation was lost when the overrun stopped execution. | Verified incurred usage is retained even when the worker is blocked; diagnostics include it. |
| IR-12 | Cancellation during an API await did not revoke the stale snapshot used for subsequent filesystem tools. | The execution lease and active allocation are checked before tool effects. |
| IR-13 | A crash after a completed polled response's first tool effect could replay its calls on restart. | The runtime durably enters a non-replayable tool phase before effects and preserves per-call outputs. |
| IR-14 | Paid HELICOP bootstrap could spend standard-key credits before a required free-to-paid human gate. | The supervisory paid invocation itself receives a persistent spending-authority requirement. |
| IR-15 | Default C runtime pointed at a durable per-agent stage base that had never been created; injected evaluator boundaries masked the failure. | The private canonical stage base is created safely; the regression exercises the real runtime without a boundary factory. |
| IR-16 | Public Chat calls could supply a trusted native mission ID and reuse its root authority. | Public operations are bound to the persisted Chat surface and cannot borrow native mission authority. |
| IR-17 | Native provider overrun accounting was rolled back by an exception inside the transaction. | Known native usage survives stopping and remains included in shared mission accounting. |
| IR-18 | Native model steps omitted the per-key API request count enforced by the shared runtime. | Native requests enforce the same configured request ceiling before another provider call. |
| IR-19 | Native tool intent used a stale allocation snapshot after cancellation. | Current native lease/state is revalidated before the tool can execute. |
| IR-20 | Enabled Chat governance retained an ungoverned legacy worker path, and hiding private native tools alone was insufficient. | Direct MCP calls to legacy ask/poll/cancel are rejected while ULTRA is enabled; the public facade rejects private native names even when called without discovery. |
| IR-21 | Two concurrent native steps could each reserve against the same remaining allocation. | Atomic admission rejects a second unsettled step and checks cumulative allocation before another provider call. |
| IR-22 | Failure of the first host environment read left the adapter in legacy mode. | Bootstrap is unknown until a successful explicit read; managed workers remain held after initialization failure. |
| IR-23 | Native file access omitted the owner policy and state paths protected by Chat. | The native controller receives configured owner policy/state paths from the actual bridge and excludes private stage subtrees. The regression invokes the real native dispatch route and rejects the control-file read. |
| IR-24 | `/ultra supervise` could send external requests after host organization data restrictions changed, although worker sends checked them. | The owner command now reads current host data rules and holds supervisory work unless the host reports a known empty restriction list. |
| IR-25 | Shared runtime accepted a completed result identifying an unapproved provider model. | Model substitution stops execution after incurred usage is persisted, matching the native controller's protection. |
| IR-26 | A primary model retaining arbitrary shell access could launch another control bridge, or recruit an unrestricted Claude intermediary, to evade native authority checks. | Explicitly enabled native ULTRA applies the protected allowlist to the primary as well as workers. Direct shell/live-file tools, unrelated MCP tools and unclassified child types are denied. Independently tested with the actual hooks and native controller under a trusted Haiku host identity. Disabled legacy mode retains its previous tool set. |
| IR-27 | The declared host contract excludes Code Mode's own model tools from wildcard tool hooks; the original registration therefore did not guard `REPL`. | Exact `REPL` call, check and execution denials carry failure handlers. The independent registration regression verifies the declared contract; it does not claim live Code Mode qualification. The declaration also prevents removing these entrypoints using `tool.list`. |
| IR-28 | Native root recruitment used the configured model alias despite a different pinned effective parent model. | The pinned effective root model governs recruitment; the mod records the main step's model and root spawn's effective parent model, and the controller retains that attestation across descendant admissions. The regression requires Sol supervision for effective Haiku even when the configured label remains Opus. |

Additional source observations led to improvements in the new-file tool schema (`expected_sha256` permits explicit null), workflow-bound reviewer selection, protected critical-judge allocation, and protection of owner policy/control paths. The final recheck includes those integrations and the limits stated below.

## Final requalification of later changes

The final review inspected the later broker, review, action, store, native and CLI changes without modifying their implementation. The original 31 independent regressions remain intact and passing. The complete `npm test` run passed **214/214**, with **zero skipped, cancelled or failed tests**, on Linux with Node **v24.22.3**. It includes 27 tests from the separate architecture reviewer, seven from the fresh source reviewer, 22 native-adapter tests, 13 permission-boundary tests, the six offline acceptance scenarios, multi-process accounting and extracted-package checks. These are source-matched local results; this reviewer did not execute Windows or Desktop UI acceptance.

The recheck verified:

- Native risk overrides, promotions and escalation use a fixed, server-derived orchestrator principal. Effective model identity and the root policy remain binding. A caller cannot choose a human or HELICOP principal.
- An approved native recruitment reference retains its exact parent, worker, task and allocation. A replacement prompt or replay cannot turn it into different work. Task-level Policy B selection is recorded by trusted assignment; a descendant cannot replace it or bypass mandatory mission Policy C.
- Risk revisions invalidate in-flight review acceptance and linked action approvals. Expiring overrides cannot keep a weaker classification alive at execution. Native review startup uses the currently authorised risk assessment. New trusted test evidence requires bounded fresh adjudication where necessary.
- Revised and escalated workflow requests retain their source, role, controller binding, reviewer policy and spending origin. Recruitment revision, escalation and evidence re-adjudication consume one shared mission retry counter.
- The durable store verifies the complete snapshot as well as the event hash chain. The snapshot checksum detects corruption; it is not a keyed authenticity proof against a hostile same-user process. Windows sharing-error retries remain bounded and never reinterpret a failed exclusive open as lock ownership or steal a live process's lock.
- Native cancellation revokes local authority before remote cancellation and retains any verified usage returned by the remote cancellation response. Unverified usage remains conservatively reserved.
- Enabled Desktop discovery accurately describes A/B/C source access and uses private, immediately expiring metadata. Disabled legacy discovery retains its original public text-only contract.

The recheck reproduced one final still-open test supplied by the fresh source reviewer: Policy A allowed a paid supervisor for a free-key origin without a mission spending ceiling. The correction now requires the authorised ceiling before that invocation; the exact regression passed in the final full suite. The additional unknown-root supervisor gate was also checked: explicit user authority is required before invoking restricted Sol supervision, and that permission does not replace Sol's independent decision. See the separate [architecture review](ULTRA_ARCHITECTURE_REVIEW.md) and [fresh source review](ULTRA_SOURCE_REVIEW.md) for their independently owned findings and evidence.

## Permission-boundary assessment

The provided local bridge API enforces project-root and relative-path scope, canonical file identity, bounded UTF-8 reads, symlink/junction rejection, hardlink rejection, credential/control-path exclusions, staged ownership and optimistic edit hashes. It does not rely on model instructions for these checks.

Profile C edits private snapshots and returns reviewable patches. It does not apply those patches to the live project. General shell commands, deployment, merge and destructive live-project execution are unavailable through this boundary. Test execution requires separately installed trusted isolation/approval callbacks; injected test doubles do not prove an operating-system sandbox works.

The private-stage threat model excludes a hostile same-user process that can mutate the protected state/staging directories independently. This is a local tool boundary, not a substitute for an operating-system sandbox. Secret data embedded in ordinary allowed source text cannot be identified reliably by a filename policy; users still choose the source scope supplied to the API.

## Remaining qualification boundaries

- Installed Claude Code static validation and actual native/Desktop UI execution require the owner's supported host; those applications were not available in the implementation container.
- Live API routing, model availability and provider billing remain distinct from deterministic offline protocol evidence.
- Native model identity depends on supported host-pinned facts and fail-closed mediation of private control tools. Public MCP metadata or a caller-provided model name is not attestation.
- Code Mode is outside live qualification. Its known `REPL` entrypoint requires an exact denial; modes introducing other special entrypoints need separate host qualification before use.
- Policy schema, configurable assignments and test fixtures are not accepted as evidence that a corresponding live workflow has executed.
- The separate architecture review covers policy foundation semantics; this report does not self-approve its author's policy code.

### Native control-channel trust

The private native controller trusts its stdio facade together with host hook mediation. The installed hooks deny every model-origin private MCP call, including calls from the primary orchestrator. Protected native mode restricts the primary to classified recruitment, scoped source reads when authorised, diagnostics, workflow assignment and decisions explicitly assigned to its verified authority. It rejects arbitrary shell/live-file tools, unrelated MCP tools and unclassified Claude intermediaries. Scoped OpenAI workers likewise receive no general shell or live-project editing tool. These actors therefore cannot open an alternative control process through their granted capabilities.

This remains a host-enforced local capability boundary. A separately running hostile process under the same user, another trusted plugin that ignores these controls, or a host that fails to load/enforce the guards is outside that guarantee. A local stdio caller's model string is not cryptographic host attestation. The installed host must be qualified before enabling protected native mode. The CLI's terminal requirement and typed approval phrase prevent accidental redirected approvals; they are not operating-system proof of a human gesture against a process that already controls that terminal.

### Reachable native workflow controls

The native admission and recursive `Agent` path, supervisor execution, scoped project tools and diagnostics have executable adapters. The primary has a scoped workflow-start tool, and the owner has a native review command. They start the actual shared review controller for a completed, bound native author; the native adapter test demonstrates subsequent independent review progression through the real runtime. The public Chat workflow endpoint continues to refuse native mission identities.

Review provenance distinguishes the preserved native author result from an explicitly supplied immutable source snapshot. Approval binds those exact bytes and evidence, not an unverified claim about the live working tree. General patch application, real command execution and deployment still require their separate qualified execution boundary and approval. Deterministic native event harness coverage does not establish live Desktop/CLI UI acceptance scenario A.

## Final source snapshot

Captured after the implementation freeze at **2026-11-21T14:16:37+00:00**. The parent checkout commit was `46d9ecee435f37b2c1eb8e52da22d85093064852`, tree `a4e3716997fc288d50ca2b2de8e706827ee582f7`. The reviewed integration files include the then-uncommitted Stage 4 implementation; the exact Git blob identities below bind this review to file bytes independently of the later integration commit. The programme's final engineering report records the full commit ancestry and staged PR heads.

| Independently inspected file | Git blob SHA-1 |
|---|---|
| `plugins/openai-workers/ultra/store.mjs` | `eeafcb685613a3bd10749ffee301ca85c5de6a24` |
| `plugins/openai-workers/ultra/broker.mjs` | `2a622166c8bf9faf15832be9f60a115c56b3b075` |
| `plugins/openai-workers/ultra/review.mjs` | `43026e2696baa4617a899df47277e417001e1e90` |
| `plugins/openai-workers/ultra/actions.mjs` | `0e99a30e5f76846556c738ecd4ae0d4414acbda5` |
| `plugins/openai-workers/ultra/permissions.mjs` | `17052182d784f3746900650b28a94adeaea5f196` |
| `plugins/openai-workers/ultra/runtime.mjs` | `fb18954633658e113c65d320b6a8cc199a52713d` |
| `plugins/openai-workers/ultra/native-controller.mjs` | `7c0b3f8c781eae90853861e0bd4e17bfc3210d04` |
| `plugins/openai-workers/ultra/service.mjs` | `f81b9e82bfc25d97c02f539d62e082df02507d33` |
| `plugins/openai-workers/ultra/cli.mjs` | `ebdfb348d52745ef05017d1bb136b3fedf582aba` |
| `plugins/openai-workers/hooks/register.js` | `0674d997b6b64b6e981a4476fabb04ec2a14065c` |
| `plugins/openai-workers/hooks/step.js` | `17367b06e353e367bdc2f8597da4ce9e38f8de7e` |
| `plugins/openai-workers/hooks/tools.js` | `f0bedfc2f9061d7fd866c2f71491fd99f6d675d1` |
| `plugins/openai-workers/hooks/ultra.js` | `215a37a8215b1aa06be1ffc6ece89a9c7e93e8d2` |
| `plugins/openai-workers/bridge/server.mjs` | `adc4cd02759a8401a5e6682ec881f585fc8df435` |
| `plugins/openai-workers/bridge/desktop-server.mjs` | `668055fdf426ff8fefaea0beb8903c37bdc4c47e` |
| `scripts/build-desktop.mjs` | `18496b97a382ad5cdbdcee5e51d97908ce1bc72b` |
| `plugins/openai-workers/tests/ultra-independent.test.mjs` | `2c287aa8e9b2ceb37aebfdbc0eb1823ac72a50fc` |

The rebuilt `dist/Chlaude-GPTopus-Desktop.mcpb` at this checkpoint has SHA-256 `7b4c660e5929400a01a7d04f4caa7c9e52f704f566a74d29f993a07701aa5e75`. The full suite verified deterministic packaging and exercised the actual governed service from the extracted package; this does not establish Desktop UI acceptance.

The official host declaration used for the API-contract checks was `mods/types/claude-code.d.ts` from `anthropics/claude-code`, Git blob `85729df6231501d7554d8a05fc530badcfff83d9`. The installed runtime's declarations and validator remain the authority for owner acceptance; see [host interface evidence](ULTRA_HOSTS.md).

Reproduction commands from the repository root:

```sh
node --test plugins/openai-workers/tests/ultra-independent.test.mjs
node --test plugins/openai-workers/tests/ultra-native.test.mjs plugins/openai-workers/tests/ultra-permissions.test.mjs
npm --prefix plugins/openai-workers test
```

The frozen-source full run passed **214/214** on Linux/Node v24.22.3, including **31/31 independent security regressions**, **27/27 separate architecture regressions**, **7/7 fresh source regressions**, and **35/35 native/permission tests**. The native and permission tests were authored by the adapter implementer and are corroborating execution evidence, not an additional independent review. No tests were skipped in the final run.

A later edit to a listed module does not automatically inherit this review. Compare `git hash-object <path>`, inspect relevant changes, and rerun the affected tests. Policy foundation files are intentionally absent from the independently inspected table; their separate architecture review is required. No production default was enabled, no real API request was sent, and this review author neither committed nor merged implementation changes.

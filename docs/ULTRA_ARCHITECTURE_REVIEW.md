# ULTRA-001 independent architecture review

## Scope and independence

This review was performed by an agent that authored **none of the ULTRA implementation**. The reviewer added only `plugins/openai-workers/tests/ultra-architecture.test.mjs` and this report. Implementation corrections were made by other agents and were rechecked against executable regressions.

The review covers the policy/configuration/risk foundation independently, then follows its decisions through the durable broker, scheduler, approval and review controllers, action gates, runtime, public service and native integration. It concentrates on inherited authority, allocation and spending boundaries, independent evidence, immutable action identity, review convergence and capability enforcement. The separate security review in `ULTRA_INDEPENDENT_REVIEW.md` covers additional transport, file, cancellation and crash paths; its author correctly excludes their own policy implementation from their independence claim.

All regression scenarios use temporary synthetic state and explicitly offline provider doubles. The tests call the real policy, store, broker, runtime and workflow code. No live API credit, live user-project edit, external action or production deployment was authorized or performed by this review.

## Qualification checkpoint of the reviewed snapshot

**Scope of the figures in this document.** Every test count, file hash, bundle hash and CI run quoted here describes the frozen tree that was reviewed at the time. It predates the owner-key native channel, the per-surface capability ceilings, the required-test manifest and the later review rounds, and therefore does **not** qualify the current head. The figures are kept as the historical record of that review and are not restated per commit; derive the current ones as described in the [qualification record](ULTRA_HANDOFF.md#qualification-record).

The independent architecture suite contains **27 tests, all passing**. The final post-portability integration run passed **215/215 tests**, with zero failures, skips or cancellations, on Linux with Node **v24.22.3**. Every finding listed below has been corrected and its behavior rechecked; no confirmed finding from this review remains open within the reviewed scope. The exact source hashes and remaining qualification boundaries are recorded below.

Run from the repository root:

```sh
node --test plugins/openai-workers/tests/ultra-architecture.test.mjs
```

The reviewed integration ancestry starts with Desktop PR #1 at `04f570d130eeed47f50c6353829f9bffccd33604`. Policy and accounting were subsequently committed separately; the final report and source manifest, rather than an earlier working-tree test result, must identify the exact candidate being accepted.

## Findings and correction evidence

| ID | Priority | Finding | Verified correction or current status |
|---|---|---|---|
| AR-01 | P1 | An already allocated worker could send a new API request after the mission wall-clock limit or after another worker's incurred overrun exhausted the shared spending ceiling. | Shared mission admission is rechecked atomically at each new provider POST. Independent deadline and peer-overrun regressions pass; read-only reconciliation of already incurred requests remains possible. |
| AR-02 | P2 | A parent's permissive recruitment mode overrode a narrower per-worker default. | Explicit overrides and worker defaults now select the child's mode before inherited ceilings attenuate its permissions. The Luna SWARM under Sol SKYNET regression passes. |
| AR-03 | P1 | One passing smoke test was sufficient to hide a known failing required test on the same reviewed source. | Acceptance considers the latest result for each named test on the current source and requires all recorded results to pass. The passing-smoke/failing-protected-files regression now holds acceptance. |
| AR-04 | P1 | A caller could consume an approved deletion while naming an unrelated capability it possessed, such as `read_file`. | Each actual action kind is bound to its required capability before approval consumption. The read-only worker's attempted deletion remains denied despite an approval record. |
| AR-05 | P1 | Controller-mediated paid review recruitment used the root as parent and lost the original free-key author's spending provenance. | Reviewers, selectors, reworkers and final action judges retain the originating allocation for free-to-paid policy. Policy C still requires explicit user authority. A separate revision test confirms that revised controller requests preserve this origin. |
| AR-06 | P1 | An author could omit `reviewerSelection: C` and avoid the configured supervisor-selection requirement on ordinary recursive review recruitment. | The stored mission/author policy supplies the requirement; untrusted request metadata cannot remove it. The omitted-field regression remains pending for HELICOP selection. |
| AR-07 | P1 | Haiku, Sonnet or an unverified orchestrator could recruit Luna in SKYNET and have Luna recruit Sol without the original orchestrator's approval gate. | Restricted orchestrator-family requirements now remain binding through every generation. The independent regression covers Haiku, Sonnet and unverified identities. |
| AR-08 | P2 | Changing evidence metadata without changing code counted as implementation progress, and metadata could conceal an A→B→A code oscillation. | Review/evidence freshness retains its full immutable hash; convergence separately compares implementation content hashes. Both metadata-only adversarial regressions pass. |
| AR-09 | P2 | Several validated review controls did not alter workflow behavior. | Independent tests now exercise configured repeated-defect and no-progress thresholds, sequential informed second opinion, and original-author conversation reuse under a new restricted Review allocation. |
| AR-10 | P2 | `execution.defaultApproval` accepted two values without changing actual test approval behavior. | A configured low-impact, reversible, isolated test with the granted capability can be preauthorized in risk-based mode. Always mode retains its approval gate. General commands remain pending in both modes. The independent test checks these branches; it does not establish a production test sandbox. |
| AR-11 | P2 | Protected HELICOP allocation omitted the exact configured processing tier and silently recorded an unspecified tier. | The protected allocation now retains the configured service tier. The regression configures Sol to Flex, appoints HELICOP-SOL and verifies `serviceTier: flex`. |
| AR-12 | P2 | When the same supervisor provided both advisory consultation and a mandatory gate, a required MODIFY verdict left the already-voted request stuck pending. | The combined MODIFY verdict now produces an actionable `modify` state. The independent regression confirms no child is allocated from the modification itself. |
| AR-13 | P2 | A revised or escalated review allocation lost its original workflow assignment; its completed report was rejected as unassigned. | The successor is rebound atomically to the original assignment while exact role, source evidence and task scope remain binding. The regression revises a paid review from a free-key author, obtains the still-required owner approval and successfully submits the successor's completed report. |
| AR-14 | P2 | Trusted tests were stored without reaching the final judge's task. A missing-test hold also lacked a bounded recovery path when evidence arrived later. | Actual judge tasks now receive trusted current-source test evidence separately from source-declared claims. New passing evidence can request a fresh judge generation within the retry ceiling. The independent tests reject the obsolete judge, invalidate pending actions after failed evidence and enforce the retry limit. |
| AR-15 | P1 | After a new higher-risk classification, an in-flight review could revive a held workflow created before any override and retain its weaker original controls. | Every workflow binds an author risk revision, including revision zero. A classification change invalidates that binding, so late old reports remain unusable. Expiring overrides are also rechecked before assignment, acceptance and action consumption. |

The review did not require higher-tier authors merely because a task was consequential. Risk consequences raise scrutiny and execution gates independently of author complexity. The permission boundary and workflow tests preserve that separation.

## Additional inspected behavior

**Author-context reuse remains restricted.** When the owner explicitly disables a fresh gap inspector, the controller creates a new Review allocation and continues the original author's verified provider conversation. The regression observes the actual `previous_response_id` sent by the runtime. The reused conversation receives no implementation tools, is charged to Review, and its successful gap inspection still requires senior adjudication. It is not counted as an independent senior sign-off.

**Second-opinion input follows the selected policy.** The default blind path constructs independent review tasks without peer conclusions. The optional informed path waits for the primary report, then includes that report explicitly. The configuration therefore changes the actual task and scheduling, rather than only a label.

**Plan approval cannot replace an independent supervisor.** Independent tests grant a bounded future owner plan to an otherwise restricted mission, then verify that an applicable HELICOP veto still rejects recruitment. Concurrent requests cannot both spend the same remaining plan budget, a repeated idempotency key does not consume another allowance, and expired plans cannot admit new work. The actual CLI displays the future-recruitment warning and requires an interactive exact confirmation. Batch decisions remain individually bound to their immutable requests.

**Advisory consultation is an explicit owner choice.** With `authority.profiles.sonnet.final: false`, recruitment still waits for the consultation and a separate authenticated orchestrator decision. The original advisory rejection remains in the ledger even when that configured final authority approves. A separate mandatory requirement from the same supervisor retains its veto; the advisory setting does not silently weaken it. Fresh execution evidence is enforced as an invariant and disabling it is explicitly rejected during configuration validation.

**Task-level reviewer selection is pinned before implementation.** A trusted root can choose a permitted Policy B reviewer for the author allocation; the actual review controller uses that stored choice. A descendant or unverified caller cannot replace it, and a mandatory mission-level Policy C cannot be downgraded through the task assignment. The independent regression verifies all three denials and observes the selected Sol reviewer allocation.

**Risk overrides are operational, scoped and expiring.** The durable broker accepts an exact Core allocation, replacement classification, rationale, expiry and authenticated owner/full-orchestrator principal. It records original and replacement assessments, invalidates affected reviews/actions and leaves permissions, resources and incurred usage unchanged. The independent regression demonstrates a high-to-low override expiring before execution: the previously approved action is refused and a fresh workflow again receives the original high-impact second-opinion/gap controls.

**Persisted authority is covered by integrity checks.** In addition to the event hash chain, a state checksum covers the stored snapshot. A regression alters only a worker's tool permissions while leaving audit events intact and verifies that loading fails closed. This detects corrupted or mismatched snapshots; it is not a signature defending against a hostile same-user process capable of rewriting both state and checksum.

**Protected capacity is an allocation rule.** Core and Review are separate durable pools; reworkers belong to Core. Protected supervisory capacity cannot be obtained merely by labelling a modifying worker a reviewer. Shared token/dollar ceilings still apply to both pools and to later API steps of already admitted nodes.

**Processing uncertainty is retained.** Missing API usage is not verified zero. The legacy guarded-worker route now rejects unknown-price quotes, and the legacy native response path holds unverified usage or price before returned tool calls execute. These checks complement the shared ledger's conservative reservation and reconciliation behavior; local dollar estimates are not OpenAI invoices.

**Host catch semantics were checked against the real declaration.** The official Claude Code declaration's `CatchHandler`/`Caught` contract says a catch-handler `next(e)` after `next.called` returns the previous downstream result without running the underlying operation again. The initial suspicion that this supported fallback replayed a spawn was therefore cleared. The native regression harness separately exercises post-spawn binding failure using these actual replay-safe semantics. The byte-matched declaration is the upstream Git blob `85729df6231501d7554d8a05fc530badcfff83d9`, SHA-256 `233dc1b7b3bd0f2fee1b0793371ae164a3987c46f3805d2c899827c29d728e3e`, from [Anthropic's official Claude Code mod declarations](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts).

**The primary native model is inside protected mode.** When ULTRA is explicitly enabled, native root tools are restricted as well as worker tools. Otherwise a primary model could launch a separate bridge through arbitrary shell execution and forge its own local bootstrap. The inspected integration blocks that path, ungoverned Claude intermediaries and Code Mode's separately matched REPL entry point, while preserving native host denial checks. The normal production profile remains opt-in; the new path's installed-host qualification is still required below.

**Final independent source-review corrections were inspected.** A separate reviewer identified an unverified-root supervisory bootstrap, nonaggregate mission retries, stale risk passed by native review startup, conditional Desktop discovery metadata and a missing free-to-paid policy A budget gate for protected supervision. The final source now requires the applicable root/user and spending gates before allocating that supervisor, consumes one shared mission retry counter across the relevant recovery paths, and starts native reviews against the active authorized classification. The seven governance/discovery regressions from that separate source review pass in both full-suite checkpoints; its eighth checkout regression is covered in the portability addendum below. These are separately authored findings, not additions to this reviewer's AR-01–AR-15 findings.

**The Windows store retry preserves lock ownership.** After a real Windows CI delete-pending race, the store gained bounded retries for Windows-only `EPERM`, `EACCES` and `EBUSY` at exact filesystem operations. Exclusive `wx` acquisition remains exclusive; `EEXIST` still follows the ownership/dead-process path, and release verifies its nonce before each unlink attempt. Non-Windows permission failures remain immediate. This reviewer inspected the correction and its deterministic fault-injection tests; this inspection does not itself attest a physical Windows or Desktop session.

## Qualification boundaries and required owner evidence

- **Native host and Desktop UI:** deterministic hook/controller execution and primary-source API validation do not prove the owner's installed Claude Code or Desktop build loads the mod correctly. Source-matched CLI/Code-tab and Chat-tab acceptance remains required on the actual supported host.
- **Windows:** the Windows evaluator and CI definition can be inspected and exercised offline where available; actual Windows 11/DPAPI/Desktop acceptance must be recorded separately. Linux execution does not attest Windows junction, host-session or UI behavior.
- **Live provider:** exact model availability, the participating key programme, live API continuation and real billing have not been qualified by this offline review.
- **Profile C:** the provided boundary edits private snapshots and returns source-bound patches. It does not install a general shell, a live-project patch application transaction or an operating-system test sandbox. Those operations remain unavailable unless a separately qualified trusted executor supplies the required isolation and action approval.
- **Trust boundary:** owner configuration, the mediated native mod and local bridge/state directories belong to the trusted control plane. Filename protections cannot detect secrets embedded in otherwise permitted source text. A hostile same-user process with direct state-directory access is outside the provided file boundary's isolation guarantee.
- **Recovery:** ambiguous provider requests or side effects are held for reconciliation. Preserving evidence and conservative reservations is safer than automatically replaying an operation whose outcome is unknown; a held mission is not a falsely successful resumed mission.

Draft/HOLD remains the appropriate delivery state until the required CI and owner acceptance are recorded. Offline source qualification is complete for the snapshot below. This review grants no merge, deployment, production enablement or consequential execution approval.

## Post-snapshot finding TR-01: private native transport (PR #6 review, P1)

This finding arrived after the reviewed snapshot below and is **not covered by its
test count, source manifest or bundle hash**; those describe the earlier tree and
must be regenerated by the next qualification run (this change alters bundled
bridge/controller/hook sources and adds tests and a script).

| ID | Priority | Finding | Verified correction or current status |
|---|---|---|---|
| TR-01 | P1 | The Code-side stdio bridge dispatched any `ultra_native_*` `tools/call` and itself supplied `trustedHostChannel: true`. A bare call could open a session with a fabricated Opus/Fable identity, obtain a capability and orchestrator authority, drive recruitment/promotion/risk-override root tools, and re-init a live session id to rotate its capability (hijack/denial of service). Tool-name hiding and the mod's by-name deny are not on the transport; connection identity cannot tell the mod from a model call, another mod or a second process. | **Confirmed reachable and reproduced** against the real stdio server: seven raw-transport regressions failed on the unfixed source (init accepted, capability issued, `admit`/`promote`/`diagnostics` accepted, live session's capability rotated by a bare init and by a second server process, captured request and bare capability replayed, public `ultra_*` names answered on the Code bridge). **Corrected:** every private request is authenticated with an owner-provisioned key (HMAC over the whole request, process epoch, single-use nonce, clock window), failing closed and uniformly; the controller accepts only the verifier's single-use token; sessions are bound to epoch and key and cannot be rotated without proof of the current capability or, after a restart, the owner key. The Desktop facade was **not** reachable before or after (exact-match dispatch plus a prefix reject); its prefix check now also normalises spellings. See [the host trust model](ULTRA_HOSTS.md#private-native-control-channel) for the design and its limits. |

New regressions are in `plugins/openai-workers/tests/ultra-transport.test.mjs`:
raw stdio against `bridge/server.mjs` and `bridge/desktop-server.mjs`, the real
mod hook module routed to a real server process, controller semantics with real
ledgers, restart, rotation, replay, tampering, uniform refusal, fail-closed key
states, provisioning and signer/verifier agreement. The existing native
hook/controller suites now reach the controller through the production
authenticator instead of asserting trust with a flag. Mutation checks (removing
the MAC compare, epoch, replay, token-brand, reopen-proof, epoch-binding and
tools/call-restriction lines one at a time) were each caught by at least one
test; they are an authoring aid, not part of the suite.

**Not resolved:** other installed mods or same-user processes that can read the
owner key file can authenticate; a model that a host permits to read that file
could too; no installed Claude Code or Desktop host was exercised, so the mod-VM
signing path and the assumptions about unlisted-tool calls remain unqualified
(see the host document's residual limitations). Draft/HOLD remains the correct
delivery state.

## Windows checkout portability addendum

A subsequent Windows CI package check exposed incomplete line-ending coverage: the earlier `.gitattributes` rules pinned only the original manifest, bridge modules and credential helper. Newly packaged ULTRA modules, the portable hook and package metadata could therefore be checked out as CRLF under `core.autocrlf=true`, even though the committed MCPB contained LF source bytes. This invalidated the deterministic source/package comparison without changing the application logic.

The correction replaces the narrow text-file list with `* text=auto eol=lf` and retains `dist/*.mcpb -text`. This reviewer inspected the exact change, confirmed that all tracked text already had LF bytes in the index and working tree, checked the effective attributes for the omitted bundle inputs and Windows evaluator entry points, and verified that the binary bundle and all runtime bytes remained unchanged. The broader rule also protects newly added source/evaluator inputs from silently acquiring platform-dependent fingerprints.

The separately authored regression `source: real Git autocrlf checkout preserves source fingerprints and the reproducible Desktop bundle` uses a disposable Git repository/index and two actual `checkout-index` exports with `core.autocrlf=true` and `core.eol=crlf`. The exact old rules are its negative control: the test observes real CRLF source, an unchanged binary MCPB and a failing invocation of the actual bundle builder. With the current rules, every evaluator-relevant source file and the MCPB match their original bytes, and the same builder succeeds. The regression modifies only its disposable test directory.

Windows CI subsequently exposed a separate setup error in the existing successful-C regression: its project root already used a canonical temporary directory, but its ledger used the raw Windows `TEMP` spelling, which can be an 8.3 alias. The security reviewer corrected that shared fixture to create its ledger below `realpath(tmpdir())`. This reviewer inspected the change and reran qualification after it was frozen. The runtime and permission boundary are unchanged; canonical-path, alias and junction checks remain binding. The owner documentation now explicitly requires canonical state-directory spelling, including when environment-provided default paths are aliases. A `PATH_ALIAS` hold must be resolved through the owner-selected path.

After inspecting that test, this reviewer independently reran the entire suite: **215/215 PASS**, including **27 architecture regressions** and **8 source-review regressions**, with zero failures, skips or cancellations. The reproducible-bundle check also passed. The checkout test demonstrates Git's actual conversion behavior locally; supported Windows CI and Windows 11/Desktop owner acceptance remain separately recorded evidence. No new architecture finding arose from this portability correction.

## Final reviewed source snapshot

The final local qualification ran the following commands from the repository root:

```sh
node --test --test-reporter=tap plugins/openai-workers/tests/*.test.mjs
node scripts/build-desktop.mjs --check
```

The final post-portability test run completed **215/215 PASS**, **0 FAIL**, **0 skipped**, **0 cancelled**, in **7.833 seconds** on Linux, Node **v24.22.3**. The bundle reproduction check passed. The suite includes all 27 architecture regressions and all eight separately authored source-review regressions. The earlier **214/214 PASS** run in **6.975 seconds** remains a valid preceding checkpoint; the new checkout regression accounts for the increase. This is deterministic source qualification, not live provider or installed-host acceptance.

The reviewed core-stage tree is `a4e3716997fc288d50ca2b2de8e706827ee582f7`, corresponding to the programme's published Stage 3 head `5ee6f0ccdd8c796b9a2c702285babce040d2e90e`. The initial final integration head was `cd583986f10efb64c3e94883f0267d8a077de0db`. The programme published the attributes-only corrective commit `0628b9fe9de448ce817b0c73757a3902b7daad42`, tree `7bbe589055cfc65851d080bc79c9c6aff202e533`, on that head; the final checkout regression and review-report follow-up are identified by the file manifest below. The handoff report records their delivery commit and PR ancestry. The original Desktop integration remains the ancestor `04f570d130eeed47f50c6353829f9bffccd33604`.

All 47 file hashes in this manifest stayed unchanged across the final post-portability test run. Relative to the preceding 46-file snapshot, the changed files are the separately authored source-review test and the canonical temporary-path correction in the independent security-test fixture; `.gitattributes` is newly included in the fingerprint. Runtime, packaging, evaluator and binary bundle bytes are unchanged. The local test run does not claim to have executed GitHub Actions. Documentation and generated temporary test logs are excluded from the source fingerprint so completing review reports cannot alter the reviewed implementation identity.

The manifest contains **47 files**. Its aggregate SHA-256 is **`022df90f012dcfe85c3bebcf24913fd5c6043924f418f4a2875c4439edaed394`**. To reproduce that aggregate, sort the rows by repository-relative path, represent each as an object with the keys `path` and `sha256`, and encode the resulting JSON array as UTF-8 with sorted object keys and compact separators, without a trailing newline.

The independently reproduced `dist/Chlaude-GPTopus-Desktop.mcpb` has SHA-256 **`7b4c660e5929400a01a7d04f4caa7c9e52f704f566a74d29f993a07701aa5e75`**.

| Repository-relative source path | SHA-256 |
|---|---|
| `.claude-plugin/marketplace.json` | `0ef45add1934aed94bb2e65ed03d0628b332750ba6963921b2f29d09c0df2ecf` |
| `.gitattributes` | `88e0e17dcefccb73a96070ea5d9ee90425c98008fc0783ce962ae1230e951f98` |
| `.github/workflows/test.yml` | `88d07185831c3f08f817ff2532ccb82444af134c6ec531d57cc1a479557675dd` |
| `desktop-extension/manifest.json` | `8b42eb18e03784bc642601da22c4193859ebdbad724a0d99261b5f2cac073844` |
| `plugins/openai-workers/.claude-plugin/plugin.json` | `438b0a83e8ec0d6a8f87d59b4ffd9ad5c50a8d0b8683656f191dfa9cd595eae8` |
| `plugins/openai-workers/bridge/desktop-server.mjs` | `36ff360b79a4e0a845184efdfd1b8ff71ddcc8e2b5e76cd3b37b11edff632fc3` |
| `plugins/openai-workers/bridge/openai.mjs` | `fe86fdf9f7cd9160ec6b3e7849c12b0cbd984ce79a6982de0ba04cd7b9350782` |
| `plugins/openai-workers/bridge/server.mjs` | `4543af5b7a75cf8c5c371488899b5f2fa7b1170cb920e3423d072ec9b89edfa1` |
| `plugins/openai-workers/bridge/usage.mjs` | `1e7d5884caf21338818cb49d2bc89114f9b12fe478ffaaab6ef66dc887d5f762` |
| `plugins/openai-workers/bridge/workers.mjs` | `49a1bcbf9637c791616b4c56a0709873c321af62f611c08702610be7d3e6ee8d` |
| `plugins/openai-workers/hooks/register.js` | `21f5929a32d0416a11ea1d5999fb5cc7b74c41212edc51a0bff82f664678dcb2` |
| `plugins/openai-workers/hooks/step.js` | `61af301898ac20733573154aac9bce538fd9840401e1af477b503120851f81e3` |
| `plugins/openai-workers/hooks/tools.js` | `2bc7275e8ae88006a168d617d29755a37da8bda8c4edf0fb81f23d2795fd1cec` |
| `plugins/openai-workers/hooks/ultra.js` | `ef954e49c182ab0169cd72ee9cf880621b686491d4a6a13802e2a2a5c2f3b457` |
| `plugins/openai-workers/package.json` | `a008a1c5e7f8533097f2b34d2664f1d4b16750fef8e3e9c11c4fef1032e6b51c` |
| `plugins/openai-workers/scripts/set-ultra-policy.ps1` | `c0d051dca96f049e988dd55e05c80fda09276fa023649fab2b89749b90adb241` |
| `plugins/openai-workers/tests/accounting.test.mjs` | `ca46fa8ab79f018d9e599ddff499b5cda47d4256f086db51e32bfcd02ff65ac3` |
| `plugins/openai-workers/tests/core.test.mjs` | `439b6dcb33e265dee8f73b2fcc78100d865eae7bc5ad30652a4b65a80cc185a2` |
| `plugins/openai-workers/tests/desktop.test.mjs` | `57813ae9b12c44a8c93e01a2f751a25d72182407f7643efd47892f4fdd2a86b8` |
| `plugins/openai-workers/tests/effort.test.mjs` | `d69d5b40e55d2b14d28c24edc17d5a4343e5bc522e119c464354efce3233e0c4` |
| `plugins/openai-workers/tests/ultra-architecture.test.mjs` | `d983e1887b571c65669f992762e997a50e6ce912dcdbd48b5ecfdddaa4013f87` |
| `plugins/openai-workers/tests/ultra-desktop.test.mjs` | `21bb1f22c30b2c36462183b07b8d719412025e7018b3a757b93e211ef3eec32a` |
| `plugins/openai-workers/tests/ultra-independent.test.mjs` | `c933ecca4f96c961d2639d734199491fe1b10417db41107bf16b49f88247ea54` |
| `plugins/openai-workers/tests/ultra-integration.test.mjs` | `8c268b769352f3a09dd55d6afc9c097443691bc0cc0ceb079404f35582a0152d` |
| `plugins/openai-workers/tests/ultra-native.test.mjs` | `61500c3c551c8e02be3c51fc7584f2ecef2d6b6cc8bfa968b43f2f21f52b2c6b` |
| `plugins/openai-workers/tests/ultra-permissions.test.mjs` | `2dc7b6bdede21a0cd62b5931f3d9645f2081c3dae60a77757a891888ce8bd61d` |
| `plugins/openai-workers/tests/ultra-policy.test.mjs` | `762d82897c307e4544d1f05c8e86f223f8452207b79ea8343710061f867c4265` |
| `plugins/openai-workers/tests/ultra-source.test.mjs` | `0c340ef82df1a72d3ca4f52c969b2ad7c6b80d4f896e2e027b44c1681d78c0b6` |
| `plugins/openai-workers/tests/ultra-windows.test.mjs` | `c234f086d6c965eb6474708143116c4208dae30d2d825a7dc4b53b03157bb36c` |
| `plugins/openai-workers/tests/usage.test.mjs` | `44f5c0edbf5fdffc8b421aabcbceeaff2c2bfcbd515fc15640e1fba23f8d47c8` |
| `plugins/openai-workers/ultra/actions.mjs` | `12256db0d2f5e2d43f720b9419d68f4d86d3603129de34c74e534099f32e9125` |
| `plugins/openai-workers/ultra/broker.mjs` | `a1ada0de7291d1af82fd4b12caf1f536cadbfea34f768b83b830b93c1fce975d` |
| `plugins/openai-workers/ultra/cli.mjs` | `a6df8f7da4efbad70b80056ec88d0149913370bf6758de92e089319b5cb4a504` |
| `plugins/openai-workers/ultra/config.mjs` | `aa3230cc43894a42c83d1002591df7cab365a8d314928df91ea5b9867f62f073` |
| `plugins/openai-workers/ultra/native-controller.mjs` | `16862847aba7b1e49e5339a6f2fcf9803e385f6525bf07fc44b59997ac8229c2` |
| `plugins/openai-workers/ultra/permissions.mjs` | `51e68a406b0b18d6f6c7f27ae011adc290a473962bbe7263d8743401a4b82876` |
| `plugins/openai-workers/ultra/policy-api.mjs` | `2e5c48e4bf49a9b1519543cedc3e245d934ce9cb912c0bd70c189c8ca9c734a8` |
| `plugins/openai-workers/ultra/policy.mjs` | `421aa7d1a5f819108212c5505feb0e90bb14b34896c9f7baf5ab42f08ca6f2f9` |
| `plugins/openai-workers/ultra/review.mjs` | `b389c8daa2b1c094cfb9a15a8f08001133265502a3ee57e56e9b2717971372f0` |
| `plugins/openai-workers/ultra/risk.mjs` | `9b986571adc1d7f1a34328caf426dc12742c2e91ec8347fe7f1b366afa274cbd` |
| `plugins/openai-workers/ultra/runtime.mjs` | `78c2105b2de90c79994d2ee58926509699425aa6ea0dd472f2b9d40dba07fe85` |
| `plugins/openai-workers/ultra/service.mjs` | `fefaa75fc6edf3202b096a67e8839ae1a8978c27a1a23531a8642fe3bb4371e6` |
| `plugins/openai-workers/ultra/store.mjs` | `29315280591f7351d2327b16953e601d20a182b9ee90b5611e2b537c113946ed` |
| `scripts/Evaluate-ULTRA.ps1` | `2168ea160f4b7371d713ceddbea4e0a2d0674f1a879aee0c57bf5ce38d63259e` |
| `scripts/Run-ULTRA-Evaluator.cmd` | `0ef8d2715447b24f272eed2263c9740d79476d96d87c8be8ac12aaa2ffaab61e` |
| `scripts/build-desktop.mjs` | `b9bff138c76fe3e0e62fda3d5ea0567904c5189000454126392877c002a2d57e` |
| `scripts/ultra-evaluate.mjs` | `8315773262cc0d36f35804ad5807a36a890aff77490c8528772fbd3d680f26bb` |

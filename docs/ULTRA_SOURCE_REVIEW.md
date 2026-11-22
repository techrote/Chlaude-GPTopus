# ULTRA independent source and integration review

## Scope and independence

This final source review was performed by a fresh reviewer that authored **none of the ULTRA implementation**. The reviewer inspected the native controller and host hooks, root decision/promotion/escalation paths, public Desktop facade, owner CLI, shared broker integration, package construction and qualification wording. The reviewer changed only this report and `plugins/openai-workers/tests/ultra-source.test.mjs`; the implementation corrections were made by the implementation owner.

The review complements the [architecture review](ULTRA_ARCHITECTURE_REVIEW.md) and [security/source regression review](ULTRA_INDEPENDENT_REVIEW.md). It is a focused source review with independent executable regressions, not a formal proof or installed-host acceptance certificate.

**Scope of the figures in this review.** Every test count, file hash, bundle hash and CI run quoted here describes the frozen tree that was reviewed at the time. It predates the owner-key native channel, the per-surface capability ceilings, the required-test manifest and the later review rounds, and therefore does **not** qualify the current head. The figures are kept as the historical record of that review and are not restated per commit; derive the current ones as described in the [qualification record](ULTRA_HANDOFF.md#qualification-record).

**Final checkpoint (at the frozen tree reviewed here): 8/8 independent source regressions PASS; deterministic MCPB source match PASS. No unresolved finding in this reviewed scope remains at this checkpoint.** The six findings below were reported with their source locations and, where applicable, failing reproductions before the implementation owner corrected them.

## Findings and verified corrections

| Finding | Observed defect | Verified result |
|---|---|---|
| SR-01 — Discovery accuracy | Modern Desktop discovery always advertised text-only access and publicly cached that description for one hour, including enabled B/C policies. Actual tools already supported governed source access. | Discovery now describes the enabled profile and uses private, zero-TTL metadata. Disabled legacy discovery retains its original text and public cache behavior. Discovery invokes no provider. |
| SR-02 — Restricted supervisory bootstrap | An unknown primary could request uncertain Luna work, thereby obtain a HELICOP-SOL requirement, and have the broker allocate Sol without the user authority required for that restricted family. | The broker adds an explicit prerequisite with the proposed supervisory model, key route, tier and budget. No supervisor is allocated before that authority is supplied. A user vote then permits the narrow Sol allocation while the original request still waits for Sol's independent decision. Intended trusted Sonnet/Haiku consultation remains a separately configured relationship. |
| SR-03 — Shared retry accounting | `mission.maxRetries` was applied separately to each revised request and each re-adjudication generation. Two requests each consumed the full nominal mission limit. | A durable mission retry counter is now shared by revised proposals, explicit escalations and evidence-driven re-adjudication. The regression sets the mission ceiling to one and verifies that a second independent request cannot consume another retry. Separate per-request revision and review-round limits remain binding. |
| SR-04 — Current native risk | Native review startup passed the original recruitment risk into the shared controller, overriding a subsequently authorised current classification. A high-to-low owner override appeared in diagnostics but a fresh native workflow still used the stale high classification. | Native review startup now lets the shared controller inherit the active author assessment. The regression performs a real scoped owner override and starts the actual native workflow; it observes the replacement assessment and its bound override identity. Shared expiry/freshness checks remain responsible for invalidation. |
| SR-05 — Policy A supervisory spend | A free-origin request could recruit a paid supervisor under free-to-paid policy A despite an absent mission dollar budget. Ordinary recruitment already rejected this configuration, but the specialised supervisory path only handled B/C thresholds. | The supervisory path now enforces A's explicit mission spending ceiling before allocating the paid worker. The regression rejects the unbudgeted case and positively admits the same bounded supervision in a separately authorised budgeted mission. |
| SR-06 — Windows checkout determinism | The original narrow Git attributes forced LF only for legacy bundle inputs. With `core.autocrlf=true`, newly packaged ULTRA modules, the portable hook and package metadata became CRLF, so the deterministic builder correctly rejected the committed bundle. | Repository-wide `text=auto eol=lf`, retaining the explicit binary MCPB exception, preserves both package inputs and evaluator source fingerprints. A real Git checkout regression reproduces failure under the exact old rules and passes under the replacement rules without changing the builder or packaged implementation. |

The additional tests verify two boundaries without requiring implementation changes:

- Redirecting `APPROVE <request-id>` into the CLI does not manufacture a human vote. The command exits unsuccessfully, leaves the request pending and writes no approval.
- Binding an already admitted native request preserves the original task bytes, role, parent and single allocation. A replacement prompt does not replace the approved work; a different parent and a repeated consumption are rejected.

## Verification

From the repository root:

```sh
node --test plugins/openai-workers/tests/ultra-source.test.mjs
node scripts/build-desktop.mjs --check
git diff --check
```

All three commands passed at the final checkpoint. The source suite contains eight tests, with zero failures, skipped tests or provider calls. Its fixtures use the real broker, native controller, owner CLI subprocess and Desktop protocol handler. Supplied trusted host identities and authority votes are explicitly synthetic; the tests do not pretend that a caller string is real host attestation.

The review also inspected the retained official Claude Code declaration snapshot at Git blob `85729df6231501d7554d8a05fc530badcfff83d9`, particularly pinned parent-model identity, `tool.run`, command origin, data restrictions and Code Mode hook behavior. The installed runtime's declarations and validator remain the acceptance authority. See [host interface evidence](ULTRA_HOSTS.md).

The broader Windows/Linux matrix, full combined test count and published integration SHA belong in the [engineering handoff](ULTRA_HANDOFF.md). This report does not turn an earlier local run into evidence for a later source revision.

## Windows checkout qualification addendum

The first published integration candidate was `cd583986f10efb64c3e94883f0267d8a077de0db`. Its [CI run 44913374389](https://github.com/techrote/Chlaude-GPTopus/actions/runs/44913374389) exposed the Windows source/package mismatch before the test step. The implementation owner changed only `.gitattributes` for the portability correction and published that correction as `0628b9fe9de448ce817b0c73757a3902b7daad42`. The independent reviewer did not change the package builder or implementation.

The new regression creates a disposable Git index containing the actual reviewed source and committed bundle, then performs real `checkout-index` exports under `core.autocrlf=true` and `core.eol=crlf`. Its negative control uses the exact previous attributes, observes actual CRLF bytes in an ULTRA module, verifies that the binary MCPB remains intact, and observes the expected package-mismatch error from the actual builder. Its positive control installs the current attributes, compares every evaluator-relevant tracked source input and the MCPB byte-for-byte with the reviewed originals, and successfully runs `build-desktop.mjs --check` in the exported checkout.

This tests checkout transformation rather than only inspecting attribute text or simulating line-ending changes. It covers JavaScript, JSON, PowerShell, CMD and workflow inputs used in source provenance. The bundle SHA-256 is unchanged by the correction. The independent source suite is **8/8 PASS**, package source comparison is **PASS**, and `git diff --check` is **PASS** at this checkpoint. The real Windows matrix result for the final published source belongs in the handoff; the Linux-hosted checkout regression does not replace that matrix or physical Windows owner acceptance.

## Qualification boundary

The installed native host, mod, bridge and owner-controlled configuration form the trusted control plane. Public Desktop callers cannot use a model-name argument to enter that plane. Native root decisions use server-derived principals and exact request/action identities; they cannot impersonate a user or an independent HELICOP vote. The primary model and workers remain restricted by the actual native tool guard as well as their broker allocations.

The CLI terminal requirement prevents accidental piped approval. It is not operating-system proof of a human gesture against a hostile process that already controls the user's terminal. The native tool restrictions prevent governed actors from using shell/live-file tools to start another controller or rewrite policy; they do not isolate an unrelated hostile same-user process or separately trusted malicious plugin.

Profile A remains think-only, B permits explicitly scoped reads, and C permits separately enabled private staged changes. No general operating-system execution sandbox, arbitrary generated-code test runner or automatic live-project patch application is supplied. The corresponding absent capability fails closed. The documentation explicitly labels this limit.

This review ran no live OpenAI requests, spent no API credits, performed no merge/deployment, and did not qualify an installed Claude Code runtime, Claude Desktop UI or physical Windows 11 owner session. Those acceptance gates remain **HOLD / NOT RUN** until separately exercised against the final candidate. A reproducible package or passing protocol fixture does not establish those outcomes.

## Reviewed source identities

Captured at **2026-11-21 14:27:55 UTC**. The local integration HEAD was `cd583986f10efb64c3e94883f0267d8a077de0db`, with the independently checked checkout correction from published commit `0628b9fe9de448ce817b0c73757a3902b7daad42` applied. The new regression and this report awaited their final qualification commit. The published stage-3 ancestor is `5ee6f0ccdd8c796b9a2c702285babce040d2e90e`, tree `a4e3716997fc288d50ca2b2de8e706827ee582f7`. The exact SHA-256 byte identities below identify the reviewed source independently of its eventual commit metadata.

Paths beginning with `ultra/`, `hooks/`, `bridge/`, `tests/` or `package.json` are relative to `plugins/openai-workers/`. Other paths are repository-relative. Any change to a listed file requires a source-matched recheck before reusing this review's result.

| File | SHA-256 |
|---|---|
| `.gitattributes` | `88e0e17dcefccb73a96070ea5d9ee90425c98008fc0783ce962ae1230e951f98` |
| `ultra/config.mjs` | `aa3230cc43894a42c83d1002591df7cab365a8d314928df91ea5b9867f62f073` |
| `ultra/policy.mjs` | `421aa7d1a5f819108212c5505feb0e90bb14b34896c9f7baf5ab42f08ca6f2f9` |
| `ultra/risk.mjs` | `9b986571adc1d7f1a34328caf426dc12742c2e91ec8347fe7f1b366afa274cbd` |
| `ultra/store.mjs` | `29315280591f7351d2327b16953e601d20a182b9ee90b5611e2b537c113946ed` |
| `ultra/broker.mjs` | `a1ada0de7291d1af82fd4b12caf1f536cadbfea34f768b83b830b93c1fce975d` |
| `ultra/review.mjs` | `b389c8daa2b1c094cfb9a15a8f08001133265502a3ee57e56e9b2717971372f0` |
| `ultra/actions.mjs` | `12256db0d2f5e2d43f720b9419d68f4d86d3603129de34c74e534099f32e9125` |
| `ultra/runtime.mjs` | `78c2105b2de90c79994d2ee58926509699425aa6ea0dd472f2b9d40dba07fe85` |
| `ultra/service.mjs` | `fefaa75fc6edf3202b096a67e8839ae1a8978c27a1a23531a8642fe3bb4371e6` |
| `ultra/native-controller.mjs` | `16862847aba7b1e49e5339a6f2fcf9803e385f6525bf07fc44b59997ac8229c2` |
| `ultra/cli.mjs` | `a6df8f7da4efbad70b80056ec88d0149913370bf6758de92e089319b5cb4a504` |
| `ultra/permissions.mjs` | `51e68a406b0b18d6f6c7f27ae011adc290a473962bbe7263d8743401a4b82876` |
| `hooks/register.js` | `21f5929a32d0416a11ea1d5999fb5cc7b74c41212edc51a0bff82f664678dcb2` |
| `hooks/ultra.js` | `ef954e49c182ab0169cd72ee9cf880621b686491d4a6a13802e2a2a5c2f3b457` |
| `hooks/step.js` | `61af301898ac20733573154aac9bce538fd9840401e1af477b503120851f81e3` |
| `hooks/tools.js` | `2bc7275e8ae88006a168d617d29755a37da8bda8c4edf0fb81f23d2795fd1cec` |
| `bridge/server.mjs` | `4543af5b7a75cf8c5c371488899b5f2fa7b1170cb920e3423d072ec9b89edfa1` |
| `bridge/desktop-server.mjs` | `36ff360b79a4e0a845184efdfd1b8ff71ddcc8e2b5e76cd3b37b11edff632fc3` |
| `scripts/build-desktop.mjs` | `b9bff138c76fe3e0e62fda3d5ea0567904c5189000454126392877c002a2d57e` |
| `desktop-extension/manifest.json` | `8b42eb18e03784bc642601da22c4193859ebdbad724a0d99261b5f2cac073844` |
| `package.json` | `a008a1c5e7f8533097f2b34d2664f1d4b16750fef8e3e9c11c4fef1032e6b51c` |
| `dist/Chlaude-GPTopus-Desktop.mcpb` | `7b4c660e5929400a01a7d04f4caa7c9e52f704f566a74d29f993a07701aa5e75` |
| `tests/ultra-source.test.mjs` | `0c340ef82df1a72d3ca4f52c969b2ad7c6b80d4f896e2e027b44c1681d78c0b6` |

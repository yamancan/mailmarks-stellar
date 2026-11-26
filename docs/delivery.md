# Delivery

How each deliverable of the scope (docs/scope.md, from the statement of work, "SOW" below) is met, and where to
check it. Written 21 Nov 2026. The contracts were deployed to testnet on 20 Nov 2026 (UTC).
[Deployment records](deployments/README.md)

## Deliverable 1: circuit and local prover

| SOW asks for | Where | Status |
|---|---|---|
| MIT license | `LICENSE`; `contracts/groth16-verifier` stays Apache-2.0 (README) | Done |
| One template, one sender | docs/template.md; `circuits/release_approval.circom`, sender `mintmarks@trionlabs.dev`; `circuits/test/deployed.test.js` | Done |
| DKIM verified in the circuit | docs/circuit.md, rule 1 (zk-email `EmailVerifier` 6.3.4, RSA-2048 only) | Done |
| Exact signed From | docs/circuit.md, rules 3–4; From tests in `circuits/test/release_approval.test.js` | Done |
| Signed Subject parsed | docs/circuit.md, rule 5 (prefix: Deviations) | Done |
| Fields bound to public inputs, SHA-256 as two range-checked 128-bit limbs | docs/template.md, "Public inputs"; docs/public-input-vectors.json; `every_public_input_is_bound_by_the_proof` (contracts) | Done |
| Nullifier from the canonical signature, re-randomized proofs included | docs/template.md; `circuits/test/groth16.test.js` (two proofs, one nullifier); `replay_is_rejected` (contracts) | Done |
| Tests reject bad signatures, wrong senders, malformed or altered fields | `npm test --prefix circuits`: 40 tests with the DEV key (without it, 39 pass and the Groth16 test is skipped), listed in docs/circuit.md, "Tests" | Done |
| CLI, offline | `npm run prove --prefix prover`; docs/prover.md; network-off test in `prover/test/prove.test.js` | Done |
| Docker image, networking disabled | `Dockerfile`; docs/docker.md, "Final delivery image": `sha256:9bfaaaf4…1aa78`, run on the owner's email with `--network none` | Done |
| No email upload; only the proof and public inputs leave | docs/approval-proof.md; the page refuses `.eml` files (`web/e2e/page.spec.ts`) | Done |
| Dockerfile and image digest public | `Dockerfile` and the digest (docs/docker.md) are in the repo; the image itself on request | Done; image not published (Deviations) |
| Linux benchmark | docs/circuit.md, "Linux: linux/amd64 under Rosetta" | Done, emulated (Deviations) |
| Hermez ptau, one phase-2 contribution, transcript, `zkey verify` | docs/setup.md, "The delivery key"; docs/toolchain.md | Done |
| Dependency versions | docs/toolchain.md | Done |
| Trust model | README; docs/template.md, "Data flow and trust model" | Done |
| Real DKIM-signed message, DNS key documented | docs/dkim-key.md (key pinned 21 Nov); the owner's email proved offline (docs/docker.md) | Done |
| Public artifact and its hash | `reference/hello-release-0.1.0.mjs`, `reference/SHA256SUMS`: in the repo | Done |
| Sample proof of the reference approval | `docs/fixtures/approval-proof.json`: the real proof from the owner's email (public data only); it verifies with the delivery key and is the proof the evidence run submits | Done |

## Deliverable 2: Soroban contracts

| SOW asks for | Where | Status |
|---|---|---|
| Groth16 verification with SDF's verifier | `contracts/groth16-verifier` (unchanged copy, NOTICE); `sdf_verifier_accepts_the_circom_proof` | Done |
| Fixed-key DKIM registry on OpenZeppelin's module | `contracts/dkim-registry`; `dkim_registry_has_no_set_or_revoke_entry_point` | Done |
| Approval registry fixes the verifying key and verifier address, records only on `true` | `contracts/approval-registry/src/lib.rs`; docs/deploy.md | Done |
| `is_approved` read by a consumer contract | `contracts/consumer`; `valid_approval_is_recorded_and_readable_by_a_consumer` | Done |
| One sender, project and key hash fixed at deployment | `contracts/deploy/delivery.json`; docs/deploy.md; the deployed registry's storage (docs/deployments/README.md); sender in the circuit | Done |
| DKIM key with dated DNS evidence | docs/dkim-key.md | Done |
| No admin, key-update, revoke or upgrade powers | the registry exposes only `submit` and `is_approved` besides its constructor | Done |
| Wallet's `require_auth` | `submit` in `lib.rs`; `missing_wallet_authorization_is_rejected` | Done |
| Persistent storage, TTL and restoration | docs/contract-storage.md; `archived_entries_after_ttl` | Done |
| Typed errors, resource profiling | `Error` in `lib.rs`; docs/contract-storage.md (`wasm_submit_resources`) | Done |
| Six rejection tests; no rejection creates a record | `contracts/approval-registry/tests/registry.rs`: `replay_is_rejected` (with a re-randomized proof), `wrong_project_is_rejected`, `wrong_artifact_is_rejected`, `wrong_wallet_is_rejected`, `unregistered_key_is_rejected`, `tampered_proof_is_rejected` (false return and malformed proof); each checks no new entry | Done |
| Tests passing on GitHub | [Contract test runs](https://github.com/yamancan/mailmarks-stellar/actions/workflows/contracts.yml) | [Local test results](evidence/contract-tests/cargo-test.txt) |
| Stellar Expert links: final contracts | docs/deployments/README.md (four contracts, eight transactions) | Done |
| Stellar Expert links: one valid approval, five rejections | docs/evidence/README.md: wrong project #3, unregistered key #5, wrong artifact #8, tampered proof #8, replay #6; the valid approval `179c5f49…6f22a2` | Done |

## Deliverable 3: submission page and delivery

| SOW asks for | Where | Status |
|---|---|---|
| Static page, runnable from the repo | `web/`; `npm run preview --prefix web` | Done |
| Loads only the local proof; no backend, no email upload | web/README.md; e2e tests in `web/e2e/` | Done |
| Stellar Wallets Kit | `web/src/wallet.ts` (2.8.0) | Done |
| Shows project, artifact hash and approval status | `web/src/view.ts`; state `28-approved` in `web/e2e/states.spec.ts` | Done |
| README walkthrough with screenshots | README, "From nothing to a recorded approval" (screenshots from the page's test harness); transaction links in README, "Evidence" | Done |
| Reference approval sent through a real DKIM provider and recorded from the page | The owner's email from `mintmarks@trionlabs.dev`, Google Workspace DKIM (docs/dkim-key.md), proved on the Mac (`docs/fixtures/approval-proof.json`) and recorded from the page with the owner's wallet on 21 Nov: docs/evidence/valid/; `release_allowed` true through the consumer: docs/evidence/testnet-check.txt | Done |
| Clean Linux machine, full README flow on the final deployment | docs/setup.md, "Run on the final deployment with the owner's email": a new linux/amd64 container with the delivered tree: install, offline proof of the owner's email (public signals equal to the recorded proof's) and `is_approved` true from the container; the page step (record) was done on the Mac, docs/evidence/valid/ | Deviation: clean machine without the page step |
| One valid approval and five rejected transactions with Stellar Expert links | docs/evidence/ (records written by `web/scripts/evidence.ts`): the valid approval from the page, four rejections and the replay (#6), each with its Stellar Expert link, RPC and Horizon records and screenshot | Done |

## Deviations from the SOW

**Subject prefix `emailmark`.** The SOW writes the Subject with another prefix; by the owner's decision of 21 Nov
it starts with `emailmark`. Fields, binding and checks are unchanged. docs/scope.md;
docs/template.md.

**Fixed-position byte checks, not zk-regex.** The early plan parsed From and Subject with zk-regex. The circuit
instead checks the exact bytes at offsets it verifies itself (decided 19 Nov): the two regexes alone came
to about 2.3 M constraints, and they do not count matches or reject a second address, so those checks were needed
anyway. DKIM still comes from zk-email's `EmailVerifier`. docs/circuit.md, "Why
explicit byte checks instead of zk-regex".

**960-byte header buffer.** The circuit takes at most 951 signed header bytes. If the owner's real header is longer,
the buffer, the key and the approval registry are made again. docs/circuit.md, "Open"; docs/setup.md.

**Public copy; image and delivery proving files on request.** The public repository is one commit made from the
delivered tree; the development history stays private. The Dockerfile, the image digest (`sha256:9bfaaaf4…1aa78`,
docs/docker.md) and the reference artifact with its hash (`reference/`) are in it. The image and the delivery
proving files (the zkey is 456 MB) are not published: the image goes to no registry, and both are available on
request, the image as a `docker save` file. So the path anyone can follow from the repository alone is the DEV key
with a test-key email (README); the delivery itself is shown by the recorded deployment (docs/deployments/) and
docs/evidence/.

**Clean machine without the page step.** In a new, empty linux/amd64 container on the final deployment
(docs/setup.md, "Run on the final deployment with the owner's email"), the install, the offline proof of the owner's
real email and `is_approved` read from the chain were done. The page and wallet step was not done from the clean
machine: the approval email's nullifier is already used, so a second record needs a second approval email, and none
was asked for (decided 21 Nov). The page step was done on the owner's Mac: the valid approval
`179c5f49…6f22a2`, docs/evidence/valid/.

**Built and measured on a Mac.** By the owner's decision of 20 Nov the project runs on an Apple M4 Pro. The delivery
image is linux/amd64 built under Rosetta, and the Linux figures and the clean-machine rehearsal come from linux/amd64
containers on that Mac, so they are emulated times. docs/docker.md; docs/circuit.md; docs/setup.md.

**New measurements.** All measurements in this repository are new; the earlier prototype is not part of it. For the
current DEV test circuit, `groth16 prove` took 17.1 s with a 7.4 GB peak natively on the Mac, and 19–21 s emulated.
docs/circuit.md.

**One contribution; the secret deleted, not wiped.** The proving key has one phase-2 contribution on the Hermez
ptau, as the SOW says. Its secret lived only in the snarkjs process's memory and was never written to disk; that
memory was released, not overwritten. Testnet only: a public ceremony and an audit come before mainnet.
docs/setup.md, "The delivery key".

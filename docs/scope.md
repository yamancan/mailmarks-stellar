# Scope

The technical scope this repository delivers, from the project's statement of work (SOW). How each item is met, the
evidence and every deviation: [delivery.md](delivery.md). The Subject prefix is the one change to the template itself:
the SOW writes `APPROVE RELEASE`, the delivered template uses `emailmark` (delivery.md, "Deviations from the SOW";
template.md).

## Problem and objective

A developer who receives a release approval by email needs a way to present it to a Soroban contract. This work
supplies a local proving workflow and a reusable approval record bound to a public software artifact's hash. Proof
generation runs offline on the submitter's own computer. The submission page never receives or stores the email.
Public inputs are limited to the wallet, project ID, artifact hash, DKIM key hash and nullifier. It reuses SDF's
Stellar-compatible BN254 Groth16 verifier example and OpenZeppelin's DKIM registry. A Soroban contract records the
approval against the release's artifact hash, making it verifiable by other contracts. The approver does not need a
wallet.

Objective: a user can prove a release-approval email locally and record approval of the specified artifact on
Stellar testnet, with the open-source prover, Soroban contracts and submission page, demonstrated with real
DKIM-signed messages.

## Deliverable 1: circuit and local prover

Circuit and local prover (MIT): a CLI and Docker image for one release-approval email template and one configured
sender. The circuit verifies DKIM, checks the exact signed From address and parses the signed Subject
(`<prefix> <project_id> <artifact_sha256> <wallet>`). These values are bound to the public inputs; the SHA-256
digest uses two range-checked 128-bit limbs. A nullifier derived from the canonically encoded signature prevents email
reuse, including re-randomized proofs. Circuit tests reject invalid signatures, wrong senders and malformed or altered
approval fields.

- **Local proving.** The CLI and Docker tool run offline on the submitter's own computer, with Docker networking
  disabled. No email or email headers are uploaded to the website, the developer or a proving service. Only the proof
  and the public inputs listed above leave the computer. The Dockerfile and image digest are public. The new circuit
  is benchmarked on Linux.
- **Trust model.** The configured sender and DKIM provider are trusted to issue the approval. The record proves that
  the signed message approves the specified artifact; it does not assess software quality or execute publication. The
  sender, the provider and anyone who holds the email can link it to the public record. Wallet authorization and the signed wallet
  field prevent use by another address.
- **Testnet setup.** Published Hermez powers-of-tau parameters are reused, and the circuit-specific Groth16 key is
  made with one phase-2 contribution. Security relies on the contributor securely deleting the setup secrets. A public
  multi-party ceremony and an independent audit are required before mainnet and are outside this testnet-only work.
- **Toolchain.** Circom 2.2.3, @zk-email/circuits 6.3.4, snarkjs and published Hermez powers-of-tau parameters sized
  to the measured constraint count. Dependency versions, the setup transcript and the snarkjs `zkey verify` result
  are published.

## Deliverable 2: Soroban contracts

Soroban contracts (Rust): proof verification, a fixed-key DKIM registry and an approval registry. The registry fixes
the verifying key and the address of a deployment of SDF's Groth16 verifier example, and records approval only when
verification returns true. The DKIM registry uses OpenZeppelin's module. Other contracts can query
`is_approved(project_id, artifact_hash)`; an integration test demonstrates that call from a consumer contract.

- **Configuration.** One sender, project ID and DKIM key hash are fixed at deployment. The sender check is constrained
  in the circuit; the DKIM key is documented with dated DNS evidence. There are no admin approval, key-update, revoke
  or upgrade powers; fixes require a new deployment.
- Submission requires the signed wallet's Soroban `require_auth` authorization.
- Approval records and nullifiers use persistent storage with a documented TTL and restoration strategy.
- Typed errors, resource profiling and six contract tests: `replay_is_rejected` (including a re-randomized proof),
  `wrong_project_is_rejected`, `wrong_artifact_is_rejected`, `wrong_wallet_is_rejected`,
  `unregistered_key_is_rejected` and `tampered_proof_is_rejected` (both false returns and malformed-proof errors).
  No rejected submission creates an approval record.

## Deliverable 3: submission page and delivery

A static submission page, also runnable from the repo. The user loads only the locally generated proof and public
inputs, connects through Stellar Wallets Kit and signs to record the approval. The page displays the project ID,
artifact hash and verified approval status. It has no backend or email upload. A reference software artifact is
published, and its approval is sent through a real DKIM-signing email provider. A clean Linux machine runs the full
flow from the README on the final testnet deployment. Evidence includes one valid approval and five rejected
transactions (replay, wrong project, wrong artifact, unregistered key and tampered proof) with Stellar Expert links.

## Out of scope

Hosted or third-party proving. In-browser proving: the supported workflow is the local CLI and Docker image. A
multi-party ceremony, an independent audit and mainnet deployment. Other senders, providers or email templates;
unrestricted natural-language approval parsing. Third-party pilots and production integrations. Automated software
publication, upgrades, payments or wallet recovery. Anonymous activity or concealed approval records: the public inputs
and the recorded approval are visible on-chain. Revocation, ongoing DKIM key rotation and production release-management
features.

## Evidence asked for

| Deliverable | Evidence |
|---|---|
| 1 | Public MIT repo: circuit, tests, public artifact and its hash, template specification, public-input schema, benchmarks, setup transcript, trust model, CLI, Docker image digest and sample proof. The sample proof verifies the reference artifact's approval; the prover runs offline and the raw email stays on the local machine. |
| 2 | Stellar Expert links to the final contracts, one valid approval and five rejection cases; the six rejection tests and the consumer-call test passing on GitHub. |
| 3 | Submission page and README walkthrough with screenshots and transaction links: a complete local-proof-to-on-chain-approval walkthrough using a real DKIM-signed message. |

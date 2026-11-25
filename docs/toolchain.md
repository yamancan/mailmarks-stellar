# Toolchain — verified at source, 18–20 Nov 2026

Every pin below was read from the upstream registry, release page or live network on 18 Nov 2026; statements marked
20 Nov were checked on that day.
"SOW" is the statement of work; its technical scope is [scope.md](scope.md).

| Component | SOW says | Source says (18 Nov 2026) | Pin |
|---|---|---|---|
| circom | 2.2.3 | iden3/circom latest release v2.2.3 (2025-10-27) | `v2.2.3` |
| @zk-email/circuits | 6.3.4 | npm `latest` = 6.3.4; only 6.4.x alphas newer. Depends on circomlib ^2.0.5, @zk-email/zk-regex-circom 2.3.2 | `6.3.4` exact |
| @zk-email/zk-regex-circom | — | 2.3.2 ships `from_addr_regex.circom`, `subject_all_regex.circom` | `2.3.2` (transitive) |
| @zk-email/helpers | — | 6.4.2 (npm latest); its package.json takes snarkjs from a GitHub fork | `6.4.2` exact; `overrides` pins snarkjs `0.7.6` from npm. `poseidonLarge(x, 9, 242)` equals circuits 6.3.4's `PoseidonLarge(121, 17)`: checked in `circuits/test/poseidon.test.js` |
| Node.js | — | delivery rehearsal used v24.21.0 | `24.22.3` ([security release](https://nodejs.org/en/blog/release/v24.22.3), checked 25 Nov). `.nvmrc`, package engines and the Docker base image use this pin. |
| Rust | — | build host rustc/cargo 1.99.1; targets installed: x86_64 host, wasm32-unknown-unknown | `1.99.1` and target `wasm32v1-none`, both in `rust-toolchain.toml`: rustup installs them on the first cargo run in the repo (checked 19 Nov) |
| circomlib, circomlibjs, circom_tester | — | resolved in `circuits/package-lock.json`: circomlib 2.0.5 (from @zk-email/circuits' ^2.0.5), circomlibjs 0.1.7 (from @zk-email/helpers), circom_tester 0.0.24 | `2.0.5`, `0.1.7`, `0.0.24` (lock file); circom_tester exact in `circuits/package.json` |
| snarkjs | unpinned | npm and GitHub latest 0.7.6 | `0.7.6` exact |
| Powers of tau | Hermez, sized to constraints | Old Hermez S3 and `storage.googleapis.com/zkevm/ptau` URLs return **403**. The snarkjs README now links `https://circom.info/powersOfTau28_hez_final_NN.ptau` (21, 22 return 200). Verify with `snarkjs powersoftau verify` and the README's blake2b hash. **20 Nov (Mac):** `powersOfTau28_hez_final_20.ptau` from circom.info, 1,208,042,648 bytes, blake2b matches the snarkjs 0.7.6 README (`89a66eb5…2bf1a27b`), `powersoftau verify` passed | `circom.info` mirror, **2^20** (886,751 constraints, docs/circuit.md) |
| SDF Groth16 verifier | "Stellar-compatible BN254 example" | `stellar/soroban-examples/groth16_verifier/contracts/bn254_verifier` exists (added 2026-08-26 #396, sdk 28 since #420). `verify_proof(vk, proof, Vec<Bn254Fr>) -> Result<bool, Groth16Error>`, VK passed per call. **Not audited**: the example's README says it "has not undergone security auditing" and "is not safe for use in production". Its README says the BN254 contract is exercised with **Gnark** fixtures only; circom fixtures exist only for BLS12-381. SDF publishes no circom BN254 fixture. Our DEV fixture (`contracts/approval-registry/tests/fixtures/circom-dev.json`, 20 Nov) is this project's first circom fixture, and it verifies | copy at commit `01a9a33dfd`, unchanged |
| BN254 point encoding | — | soroban-sdk: G1 64 B `X‖Y` big-endian; G2 128 B with Fp2 as `c1‖c0` (Ethereum order). snarkjs JSON gives `[c0, c1]` → must swap for G2 | converter `g2Hex` in `shared/approval-proof.js`; test `g2_in_snarkjs_order_is_rejected` |
| OZ DKIM registry | "OpenZeppelin's module" | `OpenZeppelin/stellar-contracts` v0.8.0 (2026-10-20) `packages/zk-email` (`stellar-zk-email`), `dkim_registry`: `is_key_hash_valid(domain_hash, key_hash)`, plus set/revoke functions. README: "under development… not published on crates.io" (crates.io confirms absent) | git dep, tag `v0.8.0` |
| OZ zkEmail support | tracked in #902 | Issue #902 "ZK Email" open (2026-09-18), no PR; was "Q4 2026 roadmap (Phase 8)". On 3 Nov 2026 a maintainer commented "Feature has been deprioritised." (issue comment; still open, checked 20 Nov) | not used |
| soroban-sdk | — | crates.io 29.0.1; v30.0.0-rc.1 for protocol 30. SDF example and OZ v0.8.0 both use **28** | `28` (matches both) |
| Stellar protocol | — | testnet **30** (core 30.0.0, RPC 30.0.1); mainnet 29 | testnet only |
| BN254 / Poseidon host fns | — | `env.crypto().bn254()` (g1_add, g1_mul, pairing_check) and `poseidon_permutation`/`poseidon2_permutation` in sdk 28/29. Contracts need no on-chain Poseidon: the DKIM key hash is a public input compared with the registry | — |
| BN254 MSM (CAP-80) | — | CAP-80 "Host functions for efficient ZK BN254 use cases", Final, protocol 26: `bn254_g1_msm`; soroban-sdk 28 has `bn254().g1_msm`. Deliberately **not** used: the SOW asks for the SDF example's verifier, and the copy stays unchanged (it does 7 `g1_mul` + 7 `g1_add`). The measured submit (34.2 M instructions, docs/contract-storage.md) is far below the limit. Later work: an MSM verifier would cut the instructions | not used |
| Network limits | — | `stellar network settings` (20 Nov 2026), testnet and mainnet alike: `tx_max_instructions` 400,000,000, `tx_memory_limit` 41,943,040, `max_entry_ttl` 3,110,400. `min_persistent_ttl`: testnet 120,960, mainnet 2,073,600 | — |
| stellar-cli | — | v30.0.1 (2026-11-03); sdk 28 needs ≥ 25.2.0. Installed and checked on the Mac 20 Nov: `stellar 30.0.1 (f2a7b74175c3)`, `stellar contract build` builds all four contracts | `30.0.1` |
| Stellar Wallets Kit | — | `@creit.tech/stellar-wallets-kit` 2.8.0 (npm + GitHub, 2026-10-28) | `2.8.0` |
| @stellar/stellar-sdk | — | 17.4.0 | `17.4.0` |

## Notes on the scope

- **Measurements.** All measurements in this repository are new; the earlier prototype is not part of it.
- **"SDF's BN254 example" with circom.** The BN254 contract has no circom/snarkjs fixture upstream; our tests supply the first one (G2 byte order above is the known pitfall).
- **OZ DKIM module.** The trait exposes set and revoke. The scope's "no key-update or revoke powers" means the registry writes keys only in its constructor and our contract exposes no set/revoke entry points.

## Build host

**Since 20 Nov 2026 (owner's decision): the Mac** (Apple M4 Pro, 14 cores, 24 GB). circom 2.2.3, stellar-cli 30.0.1 and
Docker Desktop 4.87.0 are installed there; the Rust target `wasm32v1-none` comes from `rust-toolchain.toml`. Linux
figures come from a linux/amd64 container on it, under Rosetta (docs/docker.md).

**Until 20 Nov: a Linux build server** with 8 cores and 23 GB RAM (about 14 GB free), where circom 2.2.3,
stellar-cli 30.0.1 and Docker were not installed.

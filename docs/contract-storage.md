# Contract storage, archival and cost

## One `submit`, built WASM and a real circom proof (local test host)

Measured 20 Nov 2026 with `cd contracts && cargo test -p approval-registry --test circom -- --ignored --nocapture` (test
`wasm_submit_resources`), after `stellar contract build` (stellar-cli 30.0.1).
- **Setup:** the four contracts run as their built WASM. The proof is the DEV circom/snarkjs fixture
  (`tests/fixtures/circom-dev.json`). The ledger uses the live testnet TTL settings.
- **Measured again** with the fixtures of the later DEV keys (20 Nov: after the canonical-padding change, then for
  the 960-byte header buffer; 21 Nov: for the `emailmark` prefix): the same figures and WASM hashes as below each
  time.
- **What this is:** a measurement in the local test host, not on testnet. The testnet deployment of 21 Nov
  (docs/deployments/) did not measure it again.

| Resource | Value | Live limit (`stellar network settings`, 20 Nov) |
|---|---|---|
| CPU instructions | 34,209,909 | 400,000,000 per transaction (8.6 % used) |
| Memory | 2,737,984 bytes | 41,943,040 per transaction (6.5 % used) |
| Entries written | 3: nullifier, approval and the test host's mocked-auth nonce (temporary) | |
| Bytes written | 488 | 132,096 |
| Event size | 260 bytes | |
| Fee (SDK fee snapshot, below) | 13,547,008 stroops (about 1.35 XLM) | |

**Where the fee goes.**
- 12,365,080 stroops are rent for extending the two new persistent entries to the maximum TTL.
- 1,142,542 stroops are rent for a temporary entry: the test host's mocked-auth nonce. A wallet that is the
  transaction source does not need one.
- The rest (instructions, entries, bytes, event) is about 39,000 stroops.

**The real flow.**
- **Entries:** the page makes the wallet the transaction source, so there is no nonce entry, and `submit` writes 2
  entries (nullifier and approval).
- **Fee:** about 12.4 million stroops (13,547,008 minus the nonce's 1,142,542 rent). This is derived from the numbers
  above, not measured separately. The 488 bytes written above include the nonce entry.
- **Registry instance:** not written. Right after deployment its TTL is at the maximum, above the
  `maximum − 1 day` threshold of `submit`'s `extend_ttl`, so nothing is extended.

**Which fee rates.** soroban-sdk 28's `cost_estimate().fee()` uses a 10 Jul 2026 mainnet fee snapshot with its own
rent rate. These are SDK estimates, not testnet figures.

**TTLs.** The live `max_entry_ttl` is 3,110,400 ledgers (about 180 days at 5 s) on both testnet and mainnet.
`min_persistent_ttl` is 120,960 on testnet and 2,073,600 on mainnet. Earlier figures in this file used the test
host's default maximum of 6,312,000, which doubled the rent (25,087,487 stroops in the native estimate); they are
replaced by the ones above.

**Built WASM** (stellar-cli 30.0.1, `opt-level = "z"`, 20 Nov 2026):

| Contract | Bytes | SHA-256 |
|---|---|---|
| `approval_registry.wasm` | 8,445 | `2694d478417ef4142af8a644121a0c484876b2773298c55a5eb79cff1cdc9058` |
| `groth16_verifier.wasm` (SDF copy) | 3,788 | `df541da68d667e57bcc235ffa6ea30ab800b24d32b92c5cf87781eb85084d87a` |
| `dkim_registry.wasm` | 2,629 | `53c56bba17b7c1487ef74cb29e8db5643490e3e73dbe08fb875b24c92732c565` |
| `consumer.wasm` | 944 | `c8a638b204398a9acf61ea7dd6ca785f1e50899356c8b15d6abd002e2f87210a` |

**Not used:** the CAP-80 `g1_msm` host function (docs/toolchain.md). The verifier copy stays as SDF wrote it.

Rent is most of the fee. The approval and the nullifier are extended to the network maximum on write, so a release
stays approved for that whole period with no further rent. After it, the entries are archived, and the next
transaction that touches them pays to restore them (below).

## What can be archived, and the fallback

Persistent and instance entries are archived when their TTL runs out. Since protocol 23 (CAP-66) a transaction that
touches an archived persistent entry restores it automatically **only** when the entry is in its read-write footprint;
transaction simulation adds it and the fee pays for it. If that does not happen (old client, hand-built footprint),
the manual fallback is `stellar contract restore` for the item, then retry.

| Item | Where | TTL on write | Manual fallback |
|---|---|---|---|
| Approval record (`Approval(artifact_hash)`) | registry, persistent | network maximum | `stellar contract restore --id <registry> --key-xdr <key> --durability persistent` |
| Nullifier (`Nullifier(nullifier)`) | registry, persistent | network maximum | same, with the nullifier key |
| Registry config + verifying key | registry, instance | maximum at deploy; each `submit` extends it back to the maximum when it has fallen below maximum − 1 day | `stellar contract restore --id <registry>` (instance) |
| DKIM key entry | DKIM registry, persistent | maximum at deploy; afterwards OZ's `is_key_hash_valid` extends it on read only when it is below 29 days, and then to 30 days (stellar-contracts v0.8.0 `dkim_registry/mod.rs:219-222`, `storage.rs:50`) | `stellar contract restore --id <dkim-registry> --key-xdr <key> --durability persistent` |
| DKIM registry instance | DKIM registry, instance | maximum at deploy | `stellar contract restore --id <dkim-registry>` |
| Verifier instance | verifier, instance | network default | `stellar contract restore --id <verifier>` |
| Consumer instance (registry address) | consumer, instance | network default, never extended | `stellar contract restore --id <consumer>` |
| WASM code of `approval_registry` and `dkim_registry` | code entries | maximum: `instance().extend_ttl` extends the contract code together with the instance | `stellar contract restore --wasm-hash <hash>` |
| WASM code of `groth16_verifier` and `consumer` | code entries | network default | `stellar contract restore --wasm-hash <hash>` |

**Where this stands (21 Nov 2026).** The TTL and restoration strategy is the one documented here, and
`archived_entries_after_ttl` shows it in the test host (below). The contracts are deployed on testnet
(docs/deployments/), but nothing there has expired, and the restore commands above have not been run on testnet.
`stellar contract restore --help` (stellar-cli 30.0.1) lists `--id`, `--key-xdr`, `--durability` and `--wasm-hash`.

## Observed in the native test host

`archived_entries_after_ttl` records an approval, moves the ledger past the maximum TTL (so every entry, including
the consumer's instance, has expired), then reads and replays. It asserts exactly:

- the consumer's `release_allowed` (the cross-contract path) returns `true`;
- the registry's `is_approved` returns `true`;
- replay is rejected with `NullifierUsed`, nothing written, no event;
- the approval entry's TTL is now below the maximum (restored with the minimum TTL, not re-extended).
- Reason: the test host (soroban-env-host 28.0.2, `storage.rs` `handle_maybe_expired_entry`) treats an expired
  persistent entry the way simulation does: it adds it to the read-write footprint and restores it with the minimum
  TTL. An archived approval therefore never reads as "not approved", and an archived nullifier never lets a replay
  through.
- This is the test host's behaviour, not a testnet observation; no testnet archival is claimed (above).

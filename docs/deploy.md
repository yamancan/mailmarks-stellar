# Deploying the delivery contracts (testnet)

**Deployed on 21 Nov 2026** with the owner's approval, by the script below, once: addresses, transactions and checks
in [deployments/README.md](deployments/README.md).

## What is deployed, and with what

`contracts/deploy/delivery.json` holds every constructor value. `node circuits/scripts/delivery-config.js` writes it
from two files and nothing else:
- `circuits/build/delivery/release_approval_vk.json`, the delivery verifying key (docs/setup.md, "The delivery key");
  the config keeps its SHA-256 (`vkSha256`) and the key in soroban bytes (G2 points c1‖c0, `shared/approval-proof.js`);
- `prover/keys/trionlabs.dev-google.json`, the pinned DKIM key (docs/dkim-key.md): its key hash, and the SHA-256 of
  its domain `trionlabs.dev`.

| Order | Contract | Constructor |
|---|---|---|
| 1 | `contracts/groth16-verifier` (SDF's verifier, unchanged) | none |
| 2 | `contracts/dkim-registry` | `domain_hash` = SHA-256(`trionlabs.dev`), `public_key_hash` = the pinned key's hash |
| 3 | `contracts/approval-registry` | `verifier` (1), `dkim_registry` (2), `vk` (the delivery key, 8 IC points), `project_id` `mailmarks`, `domain_hash` |
| 4 | `contracts/consumer` | `registry` (3) |

`cargo test --manifest-path contracts/Cargo.toml` checks the config (`tests/circom.rs`, "delivery"): its key hash
is the pinned record's, its domain hash is SHA-256(`trionlabs.dev`), the four contracts construct with it, the DKIM
registry then holds the key, and the delivery verifying key refuses the DEV proof.

## How

```sh
bash scripts/deploy-testnet.sh <stellar identity with test XLM>
```

The script builds the contracts (`stellar contract build`, stellar-cli 30.0.1), deploys them in the order above with
the values from `contracts/deploy/delivery.json`, checks `is_key_hash_valid` on the DKIM registry, and writes
`docs/deployments/testnet.json` (the page's deployment, with the four contract addresses). It stops if that file
exists already. The `vk` argument is the config's `vk` object as JSON, field names as in the contract's
`VerificationKey` and bytes as hex; the deployed registry's storage shows it was read as intended.

After it: the evidence run (web/scripts/evidence.ts) with the owner's real proof, then the `is_approved` check through
the consumer (README, Evidence).

## When something changes

- **A new delivery key** (the real header over 951 bytes): running `delivery-setup.sh` again as it is would make
  another key for the same 960-byte buffer. The buffer grows first (docs/circuit.md, Open: 1536 bytes and a 2^21 ptau,
  which also changes the script's ptau and `MAX_HEADER` in `prover/src/inputs.js`); then `delivery-setup.sh` and
  `delivery-config.js` run again and a new approval registry is deployed, since its verifying key is fixed at
  construction (docs/setup.md, "Made again if the real header is too long").
- **A new DKIM key** (docs/dkim-key.md, "When the key changes"): a new DKIM registry with the new key hash, and a new
  approval registry pointing at it.

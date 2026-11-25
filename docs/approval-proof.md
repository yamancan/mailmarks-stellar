# approval-proof.json

The one file that leaves the prover machine (docs/template.md, data flow step 3). The prover writes it with
`buildApprovalProof` and the submission page reads it with `parseApprovalProof`, both from `shared/approval-proof.js`,
so writer and reader run the same checks. Example (not a real proof): `docs/fixtures/approval-proof.sample.json`.

## Shape

```json
{
  "version": 1,
  "network": "testnet",
  "note": "optional free text",
  "fields": { "projectId": "mailmarks", "artifactSha256": "<64 lowercase hex>", "wallet": "G..." },
  "publicSignals": ["<7 decimal strings>"],
  "proof": { "a": ["x", "y"], "b": [["x.c0", "x.c1"], ["y.c0", "y.c1"]], "c": ["x", "y"] },
  "soroban": { "a": "<128 hex>", "b": "<256 hex>", "c": "<128 hex>", "dkimKeyHash": "<64 hex>", "nullifier": "<64 hex>" }
}
```

| Key | Meaning |
|---|---|
| `version` | `1`. Any other value is refused. |
| `network` | `"testnet"`. Any other value is refused. |
| `note` | Optional string, ignored by the checks (the sample says it is not a real proof). |
| `fields` | The three Subject fields, same grammar as docs/template.md (project `[a-z0-9][a-z0-9-]{0,30}`, lowercase SHA-256 hex, a valid `G...` account strkey). |
| `publicSignals` | The snarkjs `public.json` values in template order: wallet part 1, wallet part 2, project, artifact high, artifact low, DKIM key hash, nullifier. Canonical decimals (no sign, no leading zero), each below the BN254 scalar order r. |
| `proof` | The snarkjs Groth16 proof as affine decimals (`pi_a`, `pi_b`, `pi_c` without the `z` coordinate). G2 coordinates are `[c0, c1]`, as snarkjs writes them. Every coordinate is below the BN254 base field modulus p. |
| `soroban` | The same proof in soroban-sdk 28 BN254 bytes, lowercase hex: each Fp 32 bytes big-endian, G1 = X‖Y (64 bytes), G2 = X‖Y with each Fp2 written **c1‖c0** (128 bytes). `dkimKeyHash` and `nullifier` are signals 5 and 6 as 32-byte big-endian hex, the registry's `BytesN<32>` arguments. |

## What the reader refuses

Each with a plain message (tests: `shared/test/approval-proof.test.js`):

- not JSON, larger than 64 KB, not an object, a missing or unexpected key, a value of the wrong type or length;
- another version or network;
- fields that break the grammar;
- a signal at or above r, or a coordinate at or above p;
- signals 0–4 that differ from the encoding of `fields` (`shared/encode.js`);
- `soroban.dkimKeyHash` / `soroban.nullifier` that differ from signals 5–6;
- `soroban.a`, `b`, `c` that differ from the bytes derived from `proof` (G2 in the wrong Fp2 order included).

Not checked here: that the points are on the curve and that the proof verifies. The contract's verifier decides that
(a bad point gives `MalformedProof`, a wrong proof `InvalidProof`), and the page learns it from the simulation before
asking for a signature.

## Contract arguments

`toSorobanArgs(file)` returns the registry `submit` arguments as plain strings: `wallet`, `projectId`,
`artifactHash` (hex), `dkimKeyHash` (hex), `nullifier` (hex), `proof: { a, b, c }` (hex). The page turns them into
ScVals with its own stellar-sdk; the shared module never builds XDR.

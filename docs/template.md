# Release-approval template and public inputs

Frozen. The circuit (`circuits/`), the shared encoder (`shared/encode.js`, used by the prover and the page) and the Soroban contracts must all
produce exactly these values; `docs/public-input-vectors.json` holds the shared test vectors.

## The approval email

- **Sender:** one configured address, compiled into the circuit as a constant (not a public input). The deployed sender
  is `mintmarks@trionlabs.dev` (`circuits/release_approval.circom`; the name "mintmarks" is deliberate, it lives only in
  this address). Circuit tests also use `approver@mailmarks.test`, signed by a throwaway RSA-2048 key per test run.
  The signed From is exactly one mailbox: `addr`, `<addr>` or `Name <addr>`, where the name is plain ASCII letters,
  digits, spaces and `. ' _ - "` (quotes in pairs). Gmail writes `Name <addr>`, and the space counts, so the visible
  name is at most 63 bytes. Set the Gmail "Send mail as" name this way; any other byte (an accented or encoded name
  included) is refused (docs/circuit.md).
- **Provider:** a DKIM signer using `rsa-sha256`, an RSA-2048 key with exponent 65537 (the circuit's fixed exponent),
  relaxed header canonicalization (`c=relaxed/...`; the circuit matches lowercase header names) and an explicit `h=`
  tag listing `from` and `subject`. The real provider was checked against these on the owner's email (docs/dkim-key.md).
- **Subject** (one line after relaxed header canonicalization; providers may fold it):

  ```
  emailmark <project_id> <artifact_sha256> <wallet>
  ```

  The prefix is `emailmark` in lowercase and one space, compared byte for byte: `Emailmark` or `EMAILMARK` is
  rejected. It is the owner's decision of 21 Nov 2026, a deviation from the SOW's wording
  (docs/scope.md; docs/delivery.md, Deviations); the fields and their checks are unchanged.

  | Field | Rule |
  |---|---|
  | `project_id` | `[a-z0-9][a-z0-9-]{0,30}` (1–31 ASCII bytes) |
  | `artifact_sha256` | 64 lowercase hex characters, SHA-256 of the artifact file |
  | `wallet` | a valid Stellar account strkey (`G…`, 56 characters): the only address allowed to submit |

  Exactly one space between fields, nothing before or after. Anything else is rejected (`parseSubject`).
- **Body:** ignored (the circuit checks the header signature only; the body hash is not verified).

### Reference approval

| Field | Value |
|---|---|
| project_id | `mailmarks` |
| artifact | `reference/hello-release-0.1.0.mjs`, sha256 `bd043655bf8a1a2e2c1a9d21f1892b8cb6dc04b9d84e52fa2b986917e02a41ac` (`reference/SHA256SUMS`) |
| wallet of the delivered approval | `GAUDWHLQ4JXEM6UZUMIBWSPKXHU4F5J6MBEMIHT4NZBDV4FOXBPYFNAG` (the owner's testnet account; the real proof: `docs/fixtures/approval-proof.json`) |
| example wallet | `GA4TZT44MM6G4JHK4AFSHGDMXSHW3XJLLOEWCSBPA7LCPUT6FYXEX2KN` (testnet only; used by the sample proof `docs/fixtures/approval-proof.sample.json` and `docs/public-input-vectors.json`) |

Subject of the delivered approval, as the owner sent it:

```
emailmark mailmarks bd043655bf8a1a2e2c1a9d21f1892b8cb6dc04b9d84e52fa2b986917e02a41ac GAUDWHLQ4JXEM6UZUMIBWSPKXHU4F5J6MBEMIHT4NZBDV4FOXBPYFNAG
```

## Public inputs

Seven BN254 scalar-field elements, in this order (the snarkjs `public.json` order):

| # | Name | Encoding |
|---|---|---|
| 0 | `wallet_0` | wallet characters 0–30 |
| 1 | `wallet_1` | wallet characters 31–55 |
| 2 | `project_id` | project_id characters |
| 3 | `artifact_hi` | sha256 bytes 0–15 as a big-endian 128-bit integer |
| 4 | `artifact_lo` | sha256 bytes 16–31 as a big-endian 128-bit integer |
| 5 | `dkim_key_hash` | zk-email `PoseidonLarge(121, 17)` of the RSA modulus (same as `EmailVerifier.pubkeyHash`) |
| 6 | `nullifier` | `PoseidonLarge(121, 17)` of the RSA signature; the circuit enforces `signature < modulus` |

**ASCII packing (0–2):** the characters as bytes, right-padded with zero bytes to 31 bytes, read as a big-endian
integer. Contract side: `[0x00] ‖ bytes ‖ zero padding` is a 32-byte big-endian `Bn254Fr`. All characters are
printable ASCII, so padding is unambiguous and every value is below 2^248.

**Wallet canonicality:** the limbs are the strkey characters as written in the Subject; the circuit does not check
the strkey's CRC. The contract never takes limbs from the caller: it rebuilds them from the `Address` it authorizes
(`require_auth`), whose strkey is canonical, so a mistyped or non-canonical wallet can never match a submitter.

**Artifact limbs (3–4):** the circuit range-checks each limb to 128 bits.

**DKIM registry key:** `dkim_key_hash` as 32 big-endian bytes (`BytesN<32>`); the OpenZeppelin registry's
`domain_hash` is SHA-256 of the lowercase signing domain (fixed at deployment, not a public input).

**Shared vectors:** `docs/public-input-vectors.json` (computed independently in Python) is checked by the prover
tests and must be checked by the contract tests.

## Header and signature rules

- The raw header must contain exactly one `From` and one `Subject` (counted by parsed header name, so `Subject :`
  counts too). The signature's `h=` must list both, and the signed header buffer must contain exactly one `from:` and
  one `subject:` line (oversigning, a name repeated in `h=` for a single header, is allowed). Otherwise the prover
  refuses the email; the circuit enforces the buffer rule.
- Eligible signature: `d=` the configured domain, verified with the pinned key record, and the provider rules above.
  The prover tries every signature for that domain and uses the first eligible one.
- One nullifier per signature: `PoseidonLarge(121, 17)` over the RSA-range-checked signature limbs, with
  `signature < modulus` enforced, so every proof of one email (including re-randomized proofs) has the same nullifier.
  A re-sent message (new Date or Message-ID) gets a new signature, so a new nullifier; RSA PKCS#1 v1.5 is
  deterministic, so the same signed bytes always give the same signature. The provider is trusted (below).

## Data flow and trust model

1. The approver sends the email; nothing else is asked of them (no wallet).
2. The submitter saves the raw `.eml` on their own machine and runs the prover there, offline. The DKIM key comes
   from a local pinned record, not from DNS. The `.eml` is never committed, uploaded or logged.
3. Only one file, `approval-proof.json` (the Groth16 proof, the 7 public signals and their Soroban encoding; format in
   docs/approval-proof.md), leaves the machine; the submission page loads it and the wallet named in the Subject signs
   the transaction (`require_auth`).
4. The contract checks the public inputs against its own arguments and fixed configuration, verifies the proof,
   rejects a used nullifier, and records the approval for `(project_id, artifact_hash)`.

Trusted: the configured sender and the DKIM provider (they can issue approvals). They, and anyone who holds the email,
can link it to the public record: the nullifier is derived from its signature. The record proves that the signed email approves this artifact; it says nothing about software
quality. The proving key comes from one phase-2 contribution on Hermez powers of tau: acceptable for testnet only.

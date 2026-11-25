# Release-approval circuit

`circuits/approval.circom` holds the template `ReleaseApproval(maxHeadersLength, maxNameLength, senderLength, sender)`.
`circuits/release_approval.circom` instantiates it for the deployed sender `mintmarks@trionlabs.dev`;
`circuits/test/release_approval_test.circom` uses the test sender `approver@mailmarks.test` with the same sizes.
Both use `maxHeadersLength = 960` (15 SHA-256 blocks, at most 951 signed bytes) and `maxNameLength = 64`. Template, fields and public inputs: [template.md](template.md).

## What a proof shows

1. **DKIM signature.** zk-email `EmailVerifier` 6.3.4 checks RSA (e = 65537) and SHA-256 over the canonicalized signed
   header buffer only (`ignoreBodyHashCheck = 1`: no body hash). `RSAVerifier65537` range-checks the 17 signature limbs
   to 121 bits and enforces `signature < modulus`. The key is exactly 2048 bits: the top limb (modulus bits 1936–2056)
   is below 2^112 and has bit 111 (modulus bit 2047) set, so the modulus lies in [2^2047, 2^2048).
   - **`d=` is not read.** The circuit does not parse the signature's `d=` tag. The domain is bound by the
     registry's `dkim_key_hash` and by the sender constant; the real key, pinned on 21 Nov, is Google Workspace's custom
     DKIM key of trionlabs.dev (`d=trionlabs.dev`, selector `google`): docs/dkim-key.md says what was checked.
2. **Signed length.** The private `headerLength` is where the signed bytes end, and everything after it is the
   canonical SHA-256 padding:
   - the byte at `headerLength` is `0x80`;
   - every byte between it and the length field is zero;
   - the length field (the last 8 bytes of the padded buffer) equals `8 × headerLength`;
   - `emailHeaderLength` is the shortest padded length: the first multiple of 64 that holds `headerLength + 9`
     bytes (`headerLength + 9 ≤ emailHeaderLength ≤ headerLength + 72`; zk-email's `Sha256General` already makes it
     a multiple of 64).

   Every line checked below must end by `headerLength`; the fold check may read the 0x80 marker at `headerLength`,
   never the zero padding.
3. **One From, one Subject.** Exactly one line starts with `from:` and exactly one with `subject:`.
   - **Counting:** letter case is ignored, so `From:`, `FROM:` and `subject:` all count, and the total for each name
     must be 1. A line start is byte 0 of the buffer or the byte after a CRLF, so an `x-subject:` line does not count.
   - **The line used** must be lowercase (`from:` / `subject:`), as relaxed canonicalization writes it.
   - **No fold:** the byte after each line's CRLF is not SP or HTAB, so a folded continuation line cannot carry a hidden
     mailbox list or a Subject tail.
4. **From value.** It is exactly one of `sender`, `<sender>` or `NAME<sender>`, followed by CRLF.
   - **NAME:** 1–64 bytes. Each byte is an ASCII letter, a digit, space, `.`, `'`, `_`, `-` or `"`, and the `"`
     come in pairs. Every other byte is rejected: other ASCII punctuation, control characters and every byte ≥ 0x80
     (accented or UTF-8 names). After relaxed canonicalization the space before `<` belongs to NAME. Gmail writes
     `Name Surname <addr>`, so the visible name can be at most 63 bytes there. A plain quoted name such as
     `"Release Approver"` passes.
   - **What this rules out:** a second address, a mailbox list, a comment (`(Unclosed`), an unclosed quote
     (`"Unclosed <addr>`, where the address would sit inside the quoted string) and an RFC 2047 encoded word
     (`=?US-ASCII?Q?a=40b?=`) cannot hide in the name. A quoted name with a comma (`"Doe, John"`) is rejected too. The
     sender's display name must be plain ASCII from this set; docs/template.md says so.
   - **Address:** matches the sender constant byte for byte, case included.
5. **Subject value.** It is exactly `emailmark <project_id> <artifact_sha256> <wallet>` followed by CRLF.
   - **Prefix:** the 10 bytes `emailmark ` (the `PREFIX` array, the same bytes as `SUBJECT_PREFIX` in
     shared/encode.js), byte for byte, so `Emailmark` and `EMAILMARK` are rejected. Owner's decision, 21 Nov 2026
     (docs/delivery.md, Deviations).
   - **project_id:** `[a-z0-9][a-z0-9-]{0,30}`.
   - **artifact_sha256:** 64 lowercase hex characters.
   - **wallet:** `G` followed by 55 characters from `[A-Z2-7]`. The strkey CRC is not checked: the contract rebuilds
     the limbs from its own `Address` (see template.md).
   - Exactly one space between fields, nothing after the wallet.
6. **Public signals.** These are the circuit's outputs, in this order: wallet_0, wallet_1, project_id, artifact_hi,
   artifact_lo, dkim_key_hash, nullifier. There are no public inputs, so the snarkjs `public.json` keeps this order.
   - **Text fields:** ASCII packing as in template.md.
   - **Artifact limbs:** each limb is also range-checked to 128 bits.
   - **dkim_key_hash:** `EmailVerifier.pubkeyHash`.
   - **nullifier:** `PoseidonLarge(121, 17)` over the same range-checked signature limbs.

The positions are private inputs, and the circuit checks each one itself:

| Input | What it is |
|---|---|
| `headerLength` | where the signed bytes end |
| `fromIndex`, `subjectIndex` | where the From and Subject lines start |
| `fromNameLength`, `fromAngle` | the length of NAME, and whether the address is in angle brackets |
| `projectLength` | the length of project_id |

If any of them is wrong, no witness exists (tests: "wrong offsets").

**Canonicalization.** Letter case is handled in the circuit: a capitalized duplicate `From:` or `Subject:` is
counted, and the line used must be lowercase.

The `name + space + :` form (`Subject :`) is not handled in the circuit. It only appears under `c=simple`, because
relaxed canonicalization removes the space. The circuit therefore relies on relaxed canonicalization:
- **The prover** checks that the signature's `c=` is `relaxed/...` (`prover/src/dkim.js`).
- **The provider** that signs is the trusted party (template.md).

The circuit does not parse `c=` from the DKIM signature line itself. The tag can only be located there by parsing the
whole tag list, because `c=`-like text also appears inside other tags (`z=` carries copied header text).

**Signed-length argument.** The RSA check fixes the SHA-256 state after the padded buffer. The signer hashed the
signed bytes with the standard padding, so a buffer with other padding, or one that claims another length, gives the
same state only through a SHA-256 collision. That already made `headerLength` the real signed length. Since 20 Nov
the circuit also enforces the padding itself (zeros between 0x80 and the length field, the shortest length), so the
padded buffer is a function of the signed bytes and this no longer rests on the collision argument alone. It was added
before the delivery key was made (decided after a review of the circuit).

## Why explicit byte checks instead of zk-regex

The early plan said the circuit would be built on zk-regex `from_addr` and `subject_all`. That was dropped on
19 Nov, for two reasons.

**Size.** Measured with circom 2.2.3 on a Mac M4 Pro, for a 1024-byte buffer:

| Part | Non-linear constraints | Linear constraints |
|---|---|---|
| `SubjectAllRegex(1024)` | 373,003 | 256,259 |
| `FromAddrRegex(1024)` | 972,489 | 694,967 |
| `EmailVerifier(1024, …)`, header only | 704,052 | 38,298 |

All three together come to about 3.0 M constraints, which needs ptau 2^22. That was a memory risk on the Linux build server used then (23 GB).

**They do not enforce the rules above.**
- A regex's `out` means "at least one match"; it does not count matches.
- `SelectRegexReveal` assumes a single match.
- `from_addr` accepts `a@x, b <sender>`, because its display-name part is `[^\r\n]+<`.
- The address regex matches anywhere in the value.

Those checks would have been needed on top of the regexes anyway. The explicit checks above enforce the rules directly
and cost about 184 k constraints on top of `EmailVerifier`.

## Measurements (Mac M4 Pro, 14 cores, 24 GB)

Linux time and memory: [the linux/amd64 table below](#linux-linuxamd64-under-rosetta-on-the-mac-20-nov-2026).

| What | Value |
|---|---|
| Constraints (`snarkjs r1cs info`), deployed circuit | **886,751** (799,327 non-linear + 87,424 linear) |
| Constraints, DEV test circuit (`approver@mailmarks.test`) | 886,750 (one linear constraint fewer) |
| Wires / private inputs / outputs (deployed) | 877,466 / 1001 / 7 |
| Compile `--r1cs --wasm` (test circuit, in `dev-setup.sh`) | 16–24 s, peak memory 4.6–5.4 GB (`/usr/bin/time -l`; replaces the earlier "about 35 s, 3 GB") |
| Witness (wasm, via circom_tester) | about 3 s per email |
| `npm test --prefix circuits` | 225–364 s (three compiles + 40 tests, two DEV-key proofs included; 364 s on 21 Nov) |

**Powers of tau.** The snarkjs Groth16 setup (`zkey_new.js`) uses a domain of
`2^(floor(log2(constraints + public inputs + outputs)) + 1)`. Here that is
`2^(floor(log2(886,751 + 0 + 7)) + 1) = 2^20 = 1,048,576`. snarkjs moves to 2^21 once constraints + 7 reach 2^20, so at most 1,048,568 constraints fit: 161,817 to spare. The case-insensitive
count adds about 47 k constraints. With the earlier 1024-byte buffer the circuit had 926,744 constraints, and 931,695
with the canonical SHA padding check (+4,951); the 960-byte buffer brings it to 886,799, and the 10-byte `emailmark `
prefix (21 Nov; 16 bytes before) to 886,751. The file is `powersOfTau28_hez_final_20.ptau`. It was downloaded
on the Mac on 20 Nov, its blake2b matches the snarkjs README and `powersoftau verify` passed (toolchain.md, and the
DEV key below). The delivery key uses the same file, on the Mac. `test/deployed.test.js` compiles the deployed circuit and
checks that its constraint count equals the number above and stays below 2^20 - 7.

## DEV proving key and proof (Mac M4 Pro, 24 GB, 20 Nov 2026)

This key is for development only. It is made for the **test** circuit (`approver@mailmarks.test`) with one phase-2
contribution. It is not the delivery key, made on the Mac on 21 Nov by `circuits/scripts/delivery-setup.sh` (docs/setup.md).

**Scripts:**
- `bash circuits/scripts/dev-setup.sh` downloads the ptau if missing, checks its blake2b against the snarkjs README,
  runs `powersoftau verify` only with `FULL_VERIFY=1` (the blake2b match identifies the file already verified
  in full, table below), compiles, runs `groth16 setup` and one `zkey contribute`, then `zkey verify`. It
  writes every file to `circuits/build/dev/` (git-ignored) and the times to `build/dev/times.txt`.
- `node circuits/scripts/dev-fixture.js` signs a test-key email and computes the witness. It then proves,
  checks the proof with `groth16 verify`, and writes `contracts/approval-registry/tests/fixtures/circom-dev.json`:
  the verifying key in soroban bytes plus an `approval-proof.json` built by `shared/approval-proof.js`.

The key was made three times on 20 Nov: first for the 1024-byte buffer, again after the canonical-padding check, and
again for the 960-byte buffer. It was made a fourth time on 21 Nov for the `emailmark ` prefix. The table gives the
current key (test circuit, 960-byte buffer, `emailmark `, 886,750 constraints) and, in the last three columns, the
960-byte key of 20 Nov (886,798), the key made after the padding check (1024-byte buffer, 931,694) and the first one.

| Step | Current key: time | Peak memory | 960-byte key (20 Nov) | After the padding check | First key |
|---|---|---|---|---|---|
| `powersoftau verify` (2^20) | 2,423 s | 8.3 GB | 1,578 s, 8.4 GB | 1,574 s, 7.8 GB | 2,459 s, 7.8 GB |
| `circom` compile (test circuit) | 24 s | 5.3 GB | 19 s, 4.6 GB | 16 s, 5.4 GB | — |
| `groth16 setup` | 99 s | 5.5 GB | 109 s, 4.6 GB | 70 s, 6.5 GB | 102 s, 4.8 GB |
| `zkey contribute` (one) | 64 s | 0.6 GB | 67 s, 0.5 GB | 44 s, 0.6 GB | 75 s, 0.7 GB |
| `zkey verify` | 123 s | 5.6 GB | 135 s, 5.3 GB | 85 s, 5.5 GB | 95 s, 5.9 GB |
| Witness (wasm) | 2.5 s | — | 2.5 s | 1.7 s | 1.7 s |
| `groth16 prove` (snarkjs, JS) | 17.1 s | 7.4 GB (whole node process) | 17.6 s, 5.8 GB | 10.2 s, 8.0 GB | 11–12 s, 4.8–6.9 GB (two runs) |

The times vary by run on the same Mac: the 960-byte key's steps ran slower than the earlier ones although its circuit
is smaller, while other work kept the load average near 8. During the current key's `powersoftau verify` the circuit
tests ran for the first 5 minutes and the load average reached 18. They are not a benchmark. Linux figures: next section.

The resulting proof verifies with snarkjs, with the SDF BN254 verifier copy and through the registry's `submit`
(`contracts/approval-registry/tests/circom.rs`).

## Linux: linux/amd64 under Rosetta on the Mac (20 Nov 2026)

**Mac M4 Pro, with Rosetta emulating linux/amd64; this can be slower than native x86 hardware.** Docker Desktop
4.87.0, its VM with 8 CPUs and 7.7 GiB. The base image for that run was `node:24.21.0-bookworm-slim@sha256:d6aa754f…f87b20`.
Inside, `uname -m` is `x86_64`, Node is `v24.21.0` `x64`, and the CPU reads `VirtualApple`. The DEV test
circuit of 20 Nov (886,798 constraints, the SOW's 16-byte prefix) and its key; this step-by-step table was not run
again for the `emailmark ` circuit (48 fewer constraints), whose whole-prover runs are listed below.
Each step was a separate snarkjs 0.7.6 CLI process (`npm ci` inside the container) under `/usr/bin/time -v`:

| Step | Wall time | Peak memory (max RSS) |
|---|---|---|
| Witness (`snarkjs wtns calculate`) | 4.6 s | 0.42 GiB |
| `groth16 prove` | 20.9 s | 5.24 GiB |
| `groth16 verify` | 2.4 s | 0.23 GiB |
| `groth16 setup` (2^20 ptau) | 236 s | 4.78 GiB |
| `zkey verify` (of that setup's key) | 275 s | 6.60 GiB |

`powersoftau verify` was not run there: it takes 26–40 minutes natively on the Mac.

The whole prover, in the same emulated linux/amd64 setup:
- 20 Nov, `npm run prove` in the clean container ([setup.md](setup.md)): 25.9 s (witness 3.7 s, proving 21.4 s);
- 20 Nov, the image with `--network none` ([docker.md](docker.md)): 24.6 s (witness 3.4 s, proving 20.4 s);
- 21 Nov, the `emailmark` image (DEV key): 24.2 s (witness 3.4 s, proving 20.0 s);
- 21 Nov, the interim image (docker.md): 23.5 s with the DEV key (proving 19.1 s) and 23.4 s with the delivery key on
  a test-key email (proving 19.0 s).

## Tests

`circuits/test/` covers the following:

- **Accepted, through the prover's own DKIM check:**
  - From first and Subject first in the signed buffer (offset 0), each with `checkConstraints` on the full witness
    and outputs equal to `shared/encode.js` + `dkimKeyHash` + `nullifierOf`;
  - five From forms: Gmail `Name Surname <addr>`, quoted name, `<addr>`, bare address, and a name using every allowed
    punctuation mark; two quoted parts (`"Release" "Approver" <addr>`);
  - a Subject folded like Gmail (`approvalEmail` with `fold: true`);
  - both vectors in public-input-vectors.json.
- **Accepted at the limits:**
  - a 951-byte signed header, with From past byte 500, Subject past byte 600 and Subject as the last line before DKIM-Signature;
  - a 64-byte name;
  - a 31-byte project;
  - an `x-subject:` line next to the real Subject.
- **Deployed circuit** (`test/deployed.test.js`):
  - `release_approval.circom` compiles;
  - its sender bytes decode to template.md's sender, and its constraint count matches this document;
  - a test-key email from exactly `mintmarks@trionlabs.dev` is accepted;
  - `mintmarks@trionlabs.dew` (same length, last byte different) and `mintmarks@trionlabs.de` are rejected at the
    address check.
- **Rejected** (each test checks the circuit line that fails):
  - bad signature (flipped bit, another key, project, artifact or wallet bytes changed after signing);
  - 1024-, 2047- and 2049-bit keys;
  - capitalized header names on the line used;
  - a second From or Subject in another letter case (`Subject:`, `SUBJECT:`, `From:`, `fRoM:`);
  - wrong sender (five spellings, case included);
  - From mailbox lists (four);
  - a second address in the display name (three);
  - names with an RFC 2047 word, a comment, a comma, `:`, `;`, `\` or a byte ≥ 0x80 (`André` in Latin-1 and in UTF-8);
  - headers whose names only start with `from`/`subject` (`fromage:`, `subject-x:`) are not counted (accepted);
  - an unclosed quote in the name (three);
  - a second `<addr>` or a second `>` after the angled address;
  - a display name over 64 bytes;
  - folded continuation lines after From (two) and after Subject;
  - trailing junk after From and after Subject;
  - duplicate From or Subject; unsigned From or Subject;
  - an `x-subject:` look-alike;
  - wrong values of each position input;
  - project with a leading hyphen, an uppercase letter, an underscore, empty or 32 bytes;
  - artifact in uppercase, 63 or 65 characters;
  - wallet not starting with `G`, with a non-base32 character, 55 or 57 characters;
  - a wrong prefix: `Emailmark`, `EMAILMARK`, `eMailmark`, `emailmarks`, the SOW's earlier prefix, `Re:`; a
    second space after the prefix (an empty project).
- **SHA padding** (each signed over exactly the blocks given, so only the padding check can refuse it):
  - the canonical padding signed this way gives the DKIM signature and is accepted;
  - a non-zero byte right after the 0x80 and right before the length field is rejected;
  - an extra block of zeros before the length field is rejected;
  - the longest padding: an 888-byte signed header (888 + 9 = 897, padded to 960, 63 zero bytes) is accepted, and
    setting its last zero byte (index 951) is rejected.
- **Header limit:** 951 signed bytes fill the 960-byte buffer and are accepted; 952 bytes cannot be padded inside it
  (0x80 and seven zeros fill it, with no room for the length field) and are rejected at
  `headerLength + 9 ≤ emailHeaderLength`. The prover refuses 952 bytes with a plain message before that
  (prover/test/prove.test.js).
- **Nullifier:**
  - the nullifier equals the prover's `nullifierOf` (Poseidon of the signature);
  - `signature + modulus` is rejected, and so is a non-canonical limb split;
  - two Groth16 proofs of one email with the DEV key (`test/groth16.test.js`): different proof bytes, both verify,
    the same seven public signals, so the same nullifier. The test also checks that the circuit declares its
    outputs in docs/template.md's order and that the values are the encoder's. It is skipped, with the reason, when
    the DEV key has not been made.
- **Poseidon:** the circuit's `PoseidonLarge(121, 17)` equals helpers 6.4.2 `poseidonLarge(x, 9, 242)`, on 0, 1, the
  2048-bit and 2057-bit maximums and 8 random values.

**Run:**
```
npm ci --prefix prover && npm ci --prefix circuits
npm test --prefix circuits
```
circom 2.2.3 must be on `PATH`. The tests sign their emails with `prover/` code, and say so plainly when a tool is
missing. To build the deployed circuit:
```
cd circuits && mkdir -p build && circom release_approval.circom --r1cs --wasm -l node_modules -o build
```

## Open

- **Header size** (decided 20 Nov). The buffer is 960 bytes, not 1024. `EmailVerifier` range-checks
  `emailHeaderLength` to `log2Ceil(maxHeadersLength)` = 10 bits, so with 1024 the padded length could be at most 960
  anyway: the 16th block was never usable. With 960 the padded length can be exactly 960 (it passes the 10-bit check
  and selects the 15th of 15 blocks). Both sizes therefore take at most 951 signed bytes; 960 has fewer constraints.
  If the owner's real Gmail header is at most 951 signed bytes, 960 stays. If it is longer, the buffer becomes 1536
  (about 1.3 M constraints, a 2^21 ptau), decided separately then. The delivery key was made on 21 Nov for 960
  (decided before the real header existed; docs/setup.md); a longer header means a new buffer, a new key
  and a new approval registry. The prover already refuses a longer header with a plain message (docs/prover.md).
- **Prover messages.** The prover refuses each case with a plain message before proving: a display name outside the
  allowed set, too long or with an unclosed quote, a folded From or Subject, and a signed header over 951 bytes
  (`prover/src/prove.js`, docs/prover.md).
- Linux measurements, trusted setup and real proofs: docs/circuit.md (Linux), docs/setup.md ("The delivery key"), docs/docker.md.

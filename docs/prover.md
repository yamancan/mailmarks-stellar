# The local prover

`prover/` turns a saved approval email (`.eml`) into `approval-proof.json` on the user's own machine. It never uses the
network: no DNS, no key lookup, no upload. The email, its header and the witness are never written to a file or a log.

## Command

```sh
npm run prove --prefix prover -- <approval.eml> [--out approval-proof.json]
```

- **Output** is `approval-proof.json` next to the email. Use `--out` to choose a different path. The prover places the
  completed JSON at a new path and preserves existing files. Relative paths start in the folder you ran the command from.
  The CLI and page share the format in `shared/approval-proof.js` (docs/approval-proof.md).
- **`--keys <dir>`:** read the pinned DKIM keys from another folder than `prover/keys/`. The tests and
  `prover/scripts/make-test-email.js` use this.
- **Progress:** one line per step, one every 5 s during the long proving step, and the time of each step:

  ```
  Checking the email and its DKIM signature...
    done in 0.2 s
  Computing the witness...
    done in 1.7 s
  Proving (the long step)...
    proving (the long step), 5 s
    proving (the long step), 10 s
    done in 10.8 s
  Checking the proof...
    done in 0.2 s
  Wrote /work/approval-proof.json in 12.9 s.
  ```
- **Errors:** `Error: <plain sentence>` on stderr, exit code 1. No header text, address or DKIM selector from the email is
  put in a message; a refused signature names only the reason (for example the verification library's own result, the
  algorithm or the key size).
- **npm stays offline too:** `prover/.npmrc` turns off npm's update check, funding and audit requests, so
  `npm run prove` makes no connection either.

## Which circuit and which files

The email's From address picks the circuit. All proving files are named in one place: `CIRCUITS` in
`prover/src/prove.js`.

| Sender | Circuit | Proving files (`circuits/build/…`) | Where they come from |
|---|---|---|---|
| `mintmarks@trionlabs.dev` | `circuits/release_approval.circom` (delivery) | `delivery/release_approval_js/release_approval.wasm`, `delivery/release_approval.zkey`, `delivery/release_approval_vk.json` made on the Mac on 21 Nov (`circuits/scripts/delivery-setup.sh`, hashes in docs/setup.md) |
| `approver@mailmarks.test` | `circuits/test/release_approval_test.circom` (test) | `dev/release_approval_test_js/release_approval_test.wasm`, `dev/dev.zkey`, `dev/dev_vk.json` | `bash circuits/scripts/dev-setup.sh` (DEV key) |

When a file is missing, the prover says which one and what makes it.

## Checks before proving

Each of these stops the prover with a plain message, before any proving work. Together they are the circuit's rules
(docs/circuit.md), so a proof is never attempted for an email the circuit would refuse.

- **Sender:** the From address is a configured sender.
- **Key:**
  - there is a pinned key record for the sender's domain in `prover/keys/`, and the email is signed with that key;
  - the key is RSA-2048 with exponent 65537;
  - the record's own `modulusBits`, `exponent` and `keyHash` match its key.
- **Signature** (`prover/src/dkim.js`):
  - DKIM verifies with that key;
  - `a=rsa-sha256`, `c=relaxed/...`;
  - `h=` lists `from` and `subject`;
  - exactly one From and one Subject header.
- **Signed header:**
  - at most 951 bytes;
  - exactly one `from:` and one `subject:` line, in any letter case;
  - neither line folded.
- **From line:** exactly `sender`, `<sender>` or `Name <sender>`.
  - The name may use only ASCII letters, digits, spaces and `. ' _ - "`.
  - Quotes must be in pairs.
  - At most 63 characters before ` <sender>`.
- **Subject:** exactly `emailmark <project_id> <artifact_sha256> <wallet>`, with `emailmark` in lowercase (docs/template.md).

After proving, the prover checks the proof with the verifying key and checks that public signal 5 is the pinned key's
hash. Only then does it write the file.

## Pinned DKIM keys

`prover/keys/<domain>-<selector>.json` holds one dated key record. The format is in `prover/keys/README.md`, and
`keyRecord()` in `prover/src/prove.js` derives it from the DNS TXT text. The delivery key
(`google._domainkey.trionlabs.dev`) is pinned in `prover/keys/trionlabs.dev-google.json` since 21 Nov 2026; how it
was read and checked: docs/dkim-key.md.

## Docker

**Before `docker build`,** `circuits/build/` must hold the proving files the image will carry:
- `bash circuits/scripts/dev-setup.sh` for the test sender (DEV key);
- and/or the delivery files (`circuits/scripts/delivery-setup.sh` made them on the Mac; hashes in docs/setup.md).

On a fresh clone without them, the build stops at `COPY circuits/build/`.

```sh
docker build -t mailmarks-prover .
docker run --rm --network none --user "$(id -u):$(id -g)" -v "$PWD:/work" mailmarks-prover approval.eml
```

The image runs as the unprivileged `node` user by default. `--user` matches your local user and group so the prover can
read your email and you own the resulting `approval-proof.json`. Relative paths, including `--out` and `--keys`, start
in the mounted folder (`/work`).

**To try the image with a test-key email:**

```sh
node prover/scripts/make-test-email.js try      # try/approval.eml and try/keys/mailmarks.test-test.json
cd try && docker run --rm --network none --user "$(id -u):$(id -g)" -v "$PWD:/work" mailmarks-prover approval.eml --keys keys
```

- **What the image holds** (`Dockerfile`; `.dockerignore` lets in only these, file by file):
  - the digest-pinned Node base image in `Dockerfile`;
  - the prover's runtime packages (`npm ci --omit=dev --ignore-scripts`), the source files listed in `.dockerignore`, and
    the configured public DKIM record;
  - the DEV and delivery proving files listed in `.dockerignore` (WASM, zkey, VK), when present.
  - Never in the image: emails, `.pem`/`.secret` files, the ptau, the project's r1cs and wtns files, or node_modules
    from the host (npm packages installed in the image ship a few test r1cs files of their own). These are
    excluded again at the end of `.dockerignore`, so a stray file under `prover/keys/` cannot get in.
- **Same output:** the container prints the same progress and writes the same `approval-proof.json` as the command.
- **Owner of the output file on Linux:** add `--user "$(id -u):$(id -g)"` so you own `approval-proof.json`.
- **Not pushed:** the image goes to no registry. It is shared as a file (`docker save`), as the owner decides.
- **Delivery image:** linux/amd64, built on the Mac under emulation (owner's decision, 20 Nov). The interim image (delivery and DEV keys), its runs and
  how the final image is rebuilt with the delivery key: [docker.md](docker.md).

### Tried on the Mac (Apple M4 Pro, Docker Desktop 4.87.0, engine 29.7.2, 8.3 GB VM; 20 Nov 2026)

| What | Value |
|---|---|
| Image | `mailmarks-prover`, **arm64**, with the DEV key only; id `sha256:f0d8505d6fd8…`; 387 MB content, 1.25 GB on disk |
| `docker build` | 19 s |
| `docker run --network none` on a test-key email | 11.7–13.9 s end to end (proving about 11 s) |
| `npm run prove` on a test-key email, network off | 12.8–14.2 s (`sandbox-exec`), 12.0–18.8 s (Docker runner of the test) |

This arm64 image is for trying the flow. The delivery image is **linux/amd64**, also built on the Mac, under emulation
([docker.md](docker.md)).

## Tests

`npm test --prefix prover` (`prover/test/prove.test.js`, next to the DKIM and encoding tests):
- **Plain refusals:** a missing key, a key that is not 65537 or not 2048 bits, a record that does not match its key,
  `c=simple`, non-ASCII and other bad display names, an over-long name, a signed header over 951 bytes, another
  sender, a malformed Subject, missing proving files, and usage errors.
- **The whole path with the network off:** the README command `npm run prove --prefix prover -- approval.eml`, run
  under the first of these that works:
  - `sandbox-exec` (macOS);
  - `unshare -rn` or `unshare -n` (Linux);
  - a Docker container with `--network none` (the Node image above, the repository mounted read-only).

  `MAILMARKS_OFFLINE_RUNNER=docker` tries only Docker.
  - The test first checks that a connection really fails there.
  - It then reads the file back with `parseApprovalProof`, and checks that a copy with one changed signal is refused.
  - It checks that no other file was written next to the email and that nothing from the email was printed.
  - It is skipped with "skipped:" and the reason when the DEV key is missing (`circuits/scripts/dev-setup.sh`) or
    when none of the three runners works (the message lists what was tried). On the Linux build server, the build host
    until 20 Nov, none worked: `unshare -rn` is blocked by AppArmor, `unshare -n` needs root, and there is no Docker.
    On the Mac, `sandbox-exec` runs it.

To try it by hand: `node prover/scripts/make-test-email.js <dir>` writes a test-key `approval.eml` and its key record
under `<dir>/keys/`. Then run the prover on it with `--keys <dir>/keys`.

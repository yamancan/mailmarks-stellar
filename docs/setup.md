# Setup: from a new machine to approval-proof.json

**Rehearsed on 20 Nov 2026** in a new, empty linux/amd64 container on the Mac, as a new user with nothing installed:
- Docker Desktop 4.87.0, Rosetta 2 emulation (docs/docker.md);
- `debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc`;
- the repository from `git archive` of the development tree of that day (no `node_modules`, no build files).

Every command below ran as written, except `git clone`: the rehearsal unpacked the `git archive` instead. The times are from that run, so they are emulated times; native ones are shorter
(docs/circuit.md). The places marked **When DKIM is on** need the owner's real email. It exists since 21 Nov and was proved in the
delivery image on the Mac (docs/docker.md), and these steps were run again with it on the final deployment (below). The
delivery key and the pinned DKIM key exist since 21 Nov (below, and docs/dkim-key.md).

## Run on the final deployment with the owner's email (21 Nov 2026)

The same walk-through again, on the final deployment, by the steps below as written:
- a new, empty linux/amd64 container on the Mac (`docker run --platform linux/amd64` of the
  `debian:bookworm-slim` digest above, Debian 12.12, `x86_64`), Docker Desktop 4.87.0 (engine 29.7.2), Rosetta 2;
- the repository from `git archive` of the delivered tree, unpacked as the new user `clean` (again in place of
  `git clone`);
- the proving files copied in from the Mac (step 3): the four delivery files and the three DEV files; all seven
  SHA-256s checked inside the container, equal to the tables in this file.

| Step | Time (emulated) |
|---|---|
| 1. `apt-get install curl ca-certificates` (root) | 21.4 s |
| 2. nvm install script; `nvm install` (Node 24.21.0, npm 11.19.0); `npm ci --prefix prover`; `npm ci --prefix web` | 1.1 s; 7.3 s; 7.8 s; 20.8 s |
| 4. `node prover/scripts/make-test-email.js try` | 1.6 s |
| 5. network off (`docker network disconnect bridge`; a `fetch` failed with `EAI_AGAIN`), then `npm run prove` on the test-key email | 20.4 s (prover: 18.9 s, proving 16.1 s) |
| 6. the owner's email, network still off | 17.3 s (prover: 15.7 s; checks 0.5 s, witness 2.3 s, **proving 12.9 s**, proof check 0.1 s) |
| status: network back on, `is_approved` read on testnet | 2.8 s |

**The owner's email (step 6).** The flow of docs/docker.md: the container was started with one empty `mktemp`
folder of the Mac mounted read-only at `/mail`; a subshell with `set -e` and a `trap` copied the
owner's saved approval email (kept in a private folder outside the repository) into it as `approval.eml`, ran

```sh
npm run prove --prefix prover -- /mail/approval.eml --out ~/approval-proof.json
```

as the user `clean` (`~` is its home folder), and the `trap` deleted the copy when the subshell ended. Afterwards the folder was empty on
the Mac and in the container; the folder and the container were then removed. The printed output was the prover's
progress lines only; nothing from the email or its header was written to a file or a log.

**Result.** `approval-proof.json` (2,333 bytes): its seven public signals and its fields (project `mailmarks`, the
reference artifact, wallet `GAUD…FNAG`) equal those of `docs/fixtures/approval-proof.json`, the proof recorded on
testnet; the proof bytes differ, as every Groth16 proof does.

**Status from the container, read-only.** With the network back on, `Chain.isApproved` (web/src/chain.ts, the page's
own read, a simulation that is never signed or sent) on `docs/deployments/testnet.json` returned `true` for that
proof's project and artifact, from the registry `CDR4M7C37IVMBLUWUFQ4J5HCZA5AXF2ZQAA34J43JL4SKEMB3IO3F6AG`:

```sh
cd web && node --input-type=module -e "import { readFileSync } from 'node:fs'; import { Chain, parseDeployment } from './src/chain.ts'; const dep = parseDeployment(JSON.parse(readFileSync('../docs/deployments/testnet.json', 'utf8'))); const p = JSON.parse(readFileSync(process.env.HOME + '/approval-proof.json', 'utf8')); console.log(await new Chain(dep).isApproved(p.fields.projectId, p.fields.artifactSha256));"
```

The page itself (README, steps 4–6) was not opened in the container: it has no browser, and the approval was already
recorded from the page on the Mac (docs/evidence/valid/).

## 1. What the machine needs

`curl` and CA certificates, plus `git` to clone. In the rehearsal, as root (34 s; `git` was not installed there,
since the repository came from `git archive`):

```sh
apt-get update && apt-get install -y --no-install-recommends curl ca-certificates
```

## 2. The repository and Node

```sh
git clone https://github.com/yamancan/mailmarks-stellar mailmarks   # the rehearsal unpacked a git archive instead
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash   # 1.3 s
```

Open a new terminal, so that `~/.bashrc` loads nvm, then:

```sh
cd mailmarks
nvm install
npm ci --ignore-scripts --prefix prover
npm ci --ignore-scripts --prefix web
```

npm 11.19.0 warns that some packages' install scripts were not run (`blake-hash` in prover, four in web). Proving
works without them.

## 3. The proving files

They are not in git (the delivery proving key alone is 456 MB), so a fresh clone has none. Without them the prover stops
before proving:

```
Error: The proving files for approver@mailmarks.test are not on this machine (…/circuits/build/dev/release_approval_test_js/release_approval_test.wasm). Run "bash circuits/scripts/dev-setup.sh" to make the DEV key.
```

- **When DKIM is on:** the delivery files go to `circuits/build/delivery/`: the files listed in "The delivery key"
  below, the same bytes (check their SHA-256). A key made again on another machine is another key, and the deployed
  registry refuses its proofs.
- **Rehearsal (history):** the three DEV files were copied from the Mac into `circuits/build/dev/`. They are the DEV
  key of the rehearsal's tree, made before the 21 Nov `emailmark` prefix (docs/scope.md; docs/delivery.md, Deviations);
  the current code no longer accepts them:

  | File | SHA-256 |
  |---|---|
  | `release_approval_test_js/release_approval_test.wasm` | `ab29f3af9c5f6d805f7d3725c41d5446a305e6e9163f186252f57cf9207e9bea` |
  | `dev.zkey` | `dd3077fca4c4a2d49363d356ff11767c82f659ce7ef1101425199ea3c54c50d2` |
  | `dev_vk.json` | `a8c49fcb0484f29e4a0883524d1b7f187367d85fec69a4d3e2075d0db9f12c5a` |

  **The set the current code needs in `circuits/build/dev/`:** the DEV key for the `emailmark` prefix (21 Nov):

  | File | SHA-256 |
  |---|---|
  | `release_approval_test_js/release_approval_test.wasm` | `e3f853cf935871d97fdeb20cdd9b3d2bab6ea927f5e7d6094d8ab75782da2746` |
  | `dev.zkey` | `a7731d5ff6dac870895d368e72f5433ecb514a69132b5012d82e6cffdbcc5030` |
  | `dev_vk.json` | `e8149b8a9ded4bd80433c8879769e12ca391355e622db074d8e2a9ceed75ca0f` |

  `bash circuits/scripts/dev-setup.sh` makes a DEV key of your own instead: other bytes, since every contribution
  is random, and it proves test-key emails the same way. It needs circom 2.2.3 and downloads the 1.2 GB
  ptau, so the rehearsal did not run it. It checks the ptau's blake2b; the full `powersoftau verify` (26–40 minutes
  on the Mac) runs only with `FULL_VERIFY=1`.
- **After an update that changes the circuit**, the wasm, zkey and vk are replaced together. Files from an older
  version stop the prover at the witness with a plain message saying so.

## 4. A test-key email

```sh
node prover/scripts/make-test-email.js try    # try/approval.eml and try/keys/mailmarks.test-test.json: 3.5 s
```

## 5. Prove with the network off

The output and times below are the rehearsal's (20 Nov, with the rehearsal's DEV set). In the rehearsal the
container was taken off the network first (`docker network disconnect bridge <container>`).
Only `lo` was left, and a `fetch` failed with `EAI_AGAIN`.

```sh
cd try
npm run prove --prefix ../prover -- approval.eml --keys keys
```

```
Checking the email and its DKIM signature...
  done in 0.8 s
Computing the witness...
  done in 3.7 s
Proving (the long step)...
  …
  done in 21.4 s
Checking the proof...
  done in 0.1 s
Wrote ~/mailmarks/try/approval-proof.json in 25.9 s.
```

(The home folder is written as `~` here; the prover prints the full path.)

The command took 29.5 s in all. `try/approval-proof.json` (2,336 bytes) is accepted by `parseApprovalProof`
(shared/approval-proof.js), with project `mailmarks`, the reference artifact and wallet.

## 6. The owner's email (when DKIM is on)

Proved on 21 Nov in the final delivery image on the Mac (docs/docker.md, "Final delivery image"), and in this
walk-through on the final deployment ("Run on the final deployment with the owner's email", above). It needs the pinned DKIM key record for `google._domainkey.trionlabs.dev` in `prover/keys/`
(there since 21 Nov, docs/dkim-key.md) and the delivery files above. On the Mac it runs in the delivery image, with the email copied from
its private folder into a temporary folder (docs/docker.md).

## The delivery key (made on the Mac, 21 Nov 2026)

For `circuits/release_approval.circom` (sender `mintmarks@trionlabs.dev`, 960-byte header buffer, 886,751
constraints), on the Apple M4 Pro with Node 24.21.0, circom 2.2.3 and snarkjs 0.7.6, after `dev-setup.sh` had
fetched and checked the ptau:

```sh
bash circuits/scripts/delivery-setup.sh
node circuits/scripts/delivery-config.js     # contracts/deploy/delivery.json (docs/deploy.md)
```

The script checks the ptau's blake2b (`powersOfTau28_hez_final_20.ptau`, the snarkjs README hash), then:

| Step | Command (snarkjs CLI) | Time | Peak memory |
|---|---|---|---|
| compile | `circom release_approval.circom --r1cs --wasm` | 25 s | 3.6 GB |
| setup | `groth16 setup release_approval.r1cs <ptau> release_approval_0000.zkey` | 130 s | 4.4 GB |
| one phase-2 contribution | `zkey contribute release_approval_0000.zkey release_approval_new.zkey --name="mailmarks delivery (testnet)"` | 101 s | 0.3 GB |
| verify | `zkey verify release_approval.r1cs <ptau> release_approval_new.zkey` | 145 s | 4.7 GB |
| export | `zkey export verificationkey` → `release_approval_vk.json` | | |

`zkey verify` printed (the end of its output):

```
[INFO]  snarkJS: Circuit Hash:
		755fd001 eb9548ef b44cd9ae 02c374d3
		5e82023b 71061d7b 929b8588 4279e741
		0bf5cd50 776ad90e d2910b2d d8cc642e
		97ce7252 be66c83d 624bb2f5 81d728c3
[INFO]  snarkJS: -------------------------
[INFO]  snarkJS: contribution #1 mailmarks delivery (testnet):
		ae247a9c 2a6f3de0 a18ce18a 13842274
		2ac85442 071c910b 73618eb6 75c49239
		c643df42 a180093e 1499c3d3 c2614b63
		54871292 64e2ecbe b64ab1d1 1f6be523
[INFO]  snarkJS: -------------------------
[INFO]  snarkJS: ZKey Ok!
```

| File in `circuits/build/delivery/` | SHA-256 |
|---|---|
| `release_approval.r1cs` | `9d0dc48297fa934ab7c3b8b6a25c06e683fa5e437d4038cb9d327bef2b4d1d27` |
| `release_approval_js/release_approval.wasm` | `6e091384b9727a128e2302867e8bad17b7e4f4d725942640c62f56d31b9ecc54` |
| `release_approval.zkey` | `d3561c79e96d510bce72c13e13682601f0ba7fcc82450a9691bdd5fab8078860` |
| `release_approval_vk.json` | `82facc2c38fcca34f196d7e0a6d3ec419a995054655d8200de6e586e727fa00d` |

A test-key email from `mintmarks@trionlabs.dev` was then proved with these files and the proof verified with the
vk (16.4 s); the real DKIM key cannot sign a test email, so its proof waits for the owner's email.

**The contribution's secret.** The entropy was 64 bytes from `/dev/urandom`, piped into `zkey contribute` (never
in a file, a variable or the command line); snarkjs mixes it with 64 random bytes of its own and derives the secret
from both inside that one process. Nothing of it is written to disk. When the process ended, its memory was given back
to the operating system: that is the deletion. It is not a wipe: nothing overwrote that memory, and a swapped-out
page could have reached the disk. The machine's swap and disk are encrypted, but no tool can show that such a page
was erased. The intermediate key
`release_approval_0000.zkey` (before the contribution, no secret in it) was deleted with `rm`; the same "deleted,
not wiped" holds for it (docs/docker.md). One contribution on testnet only: a public ceremony comes before mainnet
(docs/template.md).

**Made again if the real header is too long.** This key is for the 960-byte buffer, which takes at most 951 signed
header bytes. If the owner's real Gmail header is longer, the buffer grows (docs/circuit.md, Open), and the circuit,
this key, `contracts/deploy/delivery.json` and the approval registry are all made again.

## Docker instead of Node

The container had no Docker inside it. The Docker path was run on the Mac itself, on the same day, with the
linux/amd64 image built from the same commit (docs/docker.md).

## Steps that stopped in the rehearsal, and the fixes

1. **nvm loaded inside the repository.** Loading `nvm.sh` in `mailmarks/` before Node 24.21.0 is installed stops
   with exit 3: nvm tries to switch to `.nvmrc`'s version, which is not there yet. A new terminal loads nvm in the
   home folder, so `cd mailmarks && nvm install` works. Fixed here (step 2) and in the README.
2. **No proving files on a fresh clone.** The README's Node path did not say that the prover needs them. The prover's
   own message names the missing file. Fixed here (step 3) and in the README, step 3.

# The delivery Docker image

**Owner's decision (20 Nov 2026).**
- The delivery image is built on the Mac as **linux/amd64**, under Docker Desktop's x86-64 emulation on Apple Silicon.
- The Linux build server used until 20 Nov gets no Docker.
- The image digest and the `docker run --network none` evidence come from the Mac.
- The delivery write-up says plainly that the image was produced under emulation.

How the prover works inside the image: [prover.md](prover.md).

## Build and run

```sh
docker buildx build --platform linux/amd64 -t mailmarks-prover:amd64 --load .
docker run --rm --platform linux/amd64 --network none --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" mailmarks-prover:amd64 approval.eml
```

The image is local only: it is never pushed to a registry. It is handed over as a file:

```sh
docker save -o mailmarks-prover-amd64.tar mailmarks-prover:amd64
docker load -i mailmarks-prover-amd64.tar
```

The current Dockerfile runs as the unprivileged `node` user by default. The command above uses your local user and
group to read your email and write the proof with your ownership. The digests below identify the images built for the
21 Nov delivery.

## Where the image's circuit files come from

`docker build` copies the proving files listed in `.dockerignore` from `circuits/build/<name>/` (WASM, zkey, VK; see the
Dockerfile and `.dockerignore`). The prover picks the files by the email's sender (`CIRCUITS` in
`prover/src/prove.js`).

| Folder | Sender | Key | In the image below |
|---|---|---|---|
| `circuits/build/dev/` | `approver@mailmarks.test` (test circuit) | DEV key, `circuits/scripts/dev-setup.sh` on the Mac | no (only the interim image had it) |
| `circuits/build/delivery/` | `mintmarks@trionlabs.dev` (delivery circuit) | delivery key, `circuits/scripts/delivery-setup.sh` on the Mac (21 Nov; hashes in docs/setup.md) | yes |

**The final delivery image** was built with the same command on 21 Nov, with `circuits/build/dev/` moved out of the
folder for the build, so it carries only the delivery files and the pinned DKIM record (below).

## Which emulation: Rosetta (checked 20 Nov 2026)

Docker Desktop runs amd64 containers on Apple Silicon with **Rosetta 2**, not QEMU. How this was checked:
- **Docker Desktop settings:** `"UseVirtualizationFramework": true`, and there is no Rosetta key in its settings file, so the Rosetta switch is at Docker
  Desktop's default.
- **The VM's `binfmt_misc` table** (read from a privileged container): it has three enabled handlers for x86-64 ELF
  files with the same magic: `rosetta` (`/run/rosetta/rosetta`), `rosetta-wrapper` and `x86_64`
  (`/usr/bin/qemu-x86_64`). This shows that both are installed, not which one runs.
- **What actually runs:** inside `mailmarks-prover:amd64`, the memory map of both `sh` and `node` includes
  `/run/rosetta/rosetta` and no QEMU. `/proc/cpuinfo` reports `vendor_id: VirtualApple`, which is Rosetta's
  virtual CPU.
- **`docker info`** shows the VM itself (`Docker Desktop`, `aarch64`, kernel `7.0.12-linuxkit`) but does not
  name the emulator.

To check it again: `docker run --rm --platform linux/amd64 --entrypoint sh mailmarks-prover:amd64 -c 'grep rosetta /proc/self/maps'`.

## The owner's email in the container

The delivery asks for a container run on the owner's real email. **Owner's decision, 20 Nov 2026:** the project runs
on the Mac, and the approval email is kept on the Mac in a private folder outside the repository. It is not copied to
the Linux build server and never goes into the repository folder.

For the run, a copy of the email goes into a temporary folder outside the repository. Only that folder is mounted, so
the container sees this one email and nothing else in the private folder. The copy is deleted right after.

```sh
(
  set -e
  W=$(mktemp -d /tmp/mailmarks-proof.XXXXXX)   # outside the repository
  trap 'rm -rf "$W"' EXIT                       # deletes the email and the folder however the block ends
  cp <private folder>/<approval>.eml "$W/approval.eml"
  docker run --rm --platform linux/amd64 --network none --user "$(id -u):$(id -g)" \
    -v "$W:/work" mailmarks-prover:amd64 approval.eml
  cp "$W/approval-proof.json" <where the proof is kept>   # the only file that leaves the folder
)
```

- **What is kept:** only `approval-proof.json` and the command's printed output. The output never contains anything
  from the email (docs/prover.md).
- **What is deleted:** the email's copy and the temporary folder. The `trap` in the subshell deletes them when the block ends:
  normally, when a command fails (`set -e`), or on Ctrl-C. Only a killed shell (`kill -9`) or a power cut would skip
  it; then delete `/tmp/mailmarks-proof.*` by hand. The original stays in the private folder on the Mac.
- **Deleted, not wiped:** this is an ordinary file deletion. macOS `rm -P` has no effect (its man page says so), and
  on APFS on an SSD no tool can guarantee the old blocks are overwritten. The email is not secret from the Mac's owner,
  who received it; the rule is that it leaves no copy outside the private folder and never enters the
  repository.
- **Key record:** the run needs the delivery DKIM key record in the image's `prover/keys/`, so it happens with the
  final delivery image.

## Final delivery image, 21 Nov 2026

Built on the Mac from the delivered tree (Apple M4 Pro, Docker Desktop 4.87.0, engine 29.7.2,
linux/amd64 under Rosetta), and run on the owner's real approval email with the flow above: the email copied into a
`mktemp` folder outside the repository, only that folder mounted, `--network none`, the folder deleted by the
`trap` (none was left afterwards). Nothing from the email or its header was written anywhere else or printed.

| What | Value |
|---|---|
| Image | `mailmarks-prover:amd64`, linux/amd64 |
| **Delivery image digest** (index, local) | `sha256:9bfaaaf416a475f2ed71f638f56f4964cd85afa67dd21ca8d16549956ab1aa78` |
| Size | 379 MB (content) |
| `docker save` file | 379,357,696 bytes, SHA-256 `70e40131a54878c86cf61d5cd214561b263883b59fded11c8dbf48a7be561790` |
| What it carries | `circuits/build/delivery/` (wasm, zkey and vk with the SHA-256s in docs/setup.md, checked inside the image) and `prover/keys/trionlabs.dev-google.json`; no DEV key |
| Build | 12 s (base layers cached) |
| `docker run --network none` on the owner's email | 32.2 s by the prover's count (35 s with the container's start): checks 0.8 s, witness 3.7 s, **proving 27.6 s** (emulated), proof check 0.1 s |
| Output | `approval-proof.json`: verifies with the delivery vk, public signal 5 is the pinned key's hash, and its 7 public signals (nullifier included) equal those of the proof the owner made earlier; the proof bytes differ, as every Groth16 proof does |

This run's `approval-proof.json` served only that comparison and was not kept. The proof used as evidence (submitted
on testnet, `docs/fixtures/approval-proof.json`) is the one the owner made earlier.

## Interim image on the Mac, 21 Nov 2026 (history: delivery and DEV keys, not the delivery image)

**Interim, kept as history.** Decided 21 Nov: until the owner's real email existed, the image carried both
keys, so a test-key email could show it working offline. Its digest is **not** the delivery digest; the final image
above is.

Built from the development tree of that day: the delivery files (docs/setup.md, "The delivery key"),
the DEV key of 21 Nov and the pinned DKIM key `prover/keys/trionlabs.dev-google.json`. Apple M4 Pro, Docker Desktop
4.87.0 (engine 29.7.2, containerd image store), linux/amd64 under emulation. Inside the container, `uname -m` is
`x86_64` and Node is `v24.21.0` `x64`.

| What | Value |
|---|---|
| Image | `mailmarks-prover:amd64`, linux/amd64 |
| Interim image digest (index, local) | `sha256:be6b016bf345f7c1f7d0ccf7390dd1b57ff3b3a385b7afe1d9103f122cfe1630` |
| Size | 643 MB (content; the delivery zkey is 456 MB) |
| `docker save` file | 642,636,288 bytes, SHA-256 `d1c65ccfaaf44a98f6f63d4c62d098d1742768498e8c2974f07d795b6861cbfa` |
| Build | 23 s (`docker buildx build --platform linux/amd64`, base layers cached) |
| `docker run --network none`, DEV test-key email (`approver@mailmarks.test`) | 23.5 s by the prover's count (25.3 s with the container's start): witness 3.6 s, **proving 19.1 s** (emulated) |
| `docker run --network none`, test-key email from `mintmarks@trionlabs.dev` (delivery files) | 23.4 s (25.1 s with the start): witness 3.5 s, **proving 19.0 s** (emulated) |
| Output | each `approval-proof.json` accepted by `parseApprovalProof` (shared/approval-proof.js), 7 public signals |

The delivery-file run used a throwaway test key with its record given by `--keys keys`, since the real key cannot
sign a test email; it shows that the image picks the delivery files for that sender and that they prove and verify.

Earlier images, DEV key only: 21 Nov for the `emailmark` prefix, digest `sha256:644f2489028d…`, 379 MB, run 24.2 s
(proving 20.0 s); 20 Nov for the 960-byte buffer, `sha256:0e545a4823bd…`, 379 MB, 24.6 s (proving 20.4 s); the first
build (1024-byte buffer), `sha256:70bcac6e8783…`, 387 MB, 47.2 s (proving 40.1 s). The run-to-run variation on the
Mac was not investigated.

The test-key email came from `node prover/scripts/make-test-email.js <dir>` and was run with `--keys keys`.

**Emulated times.** They are Rosetta times, not native amd64 times: the same proof takes 10–18 s natively on the Mac (arm64 image,
[prover.md](prover.md)). The Linux figures (docs/circuit.md) are measured in the same emulated linux/amd64 setup.

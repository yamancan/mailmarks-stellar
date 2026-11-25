# Offline prover image (docs/prover.md, docs/docker.md). The image holds the prover, shared/ and the proving files found in
# circuits/build/<name>/ (wasm, zkey, vk); no network is needed or used at run time.
# Before building, circuits/build/ must hold the proving files: circuits/scripts/dev-setup.sh (test sender, DEV key)
# and/or the delivery files (circuits/scripts/delivery-setup.sh, on the Mac). On a fresh clone without them, the COPY below fails.
#   docker build -t mailmarks-prover .
#   docker run --rm --network none --user "$(id -u):$(id -g)" -v "$PWD:/work" mailmarks-prover approval.eml
#   test-key email (prover/scripts/make-test-email.js): add --keys keys to read its key record from ./keys/
# Node as in .nvmrc, pinned by its multi-arch index digest.
FROM node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
WORKDIR /app
COPY prover/package.json prover/package-lock.json prover/.npmrc prover/
RUN npm ci --prefix prover --omit=dev --ignore-scripts && npm cache clean --force
COPY shared/ shared/
COPY prover/src/ prover/src/
COPY prover/keys/ prover/keys/
COPY circuits/build/ circuits/build/
# Relative paths (the email, --out, --keys) are taken from the mounted folder.
WORKDIR /work
USER node
ENTRYPOINT ["node", "/app/prover/src/cli.js"]

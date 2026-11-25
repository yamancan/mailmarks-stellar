#!/usr/bin/env bash
# Deploys the delivery contracts to Stellar TESTNET from contracts/deploy/delivery.json (docs/deploy.md), in order:
#   1. the Groth16 verifier (SDF copy, no constructor);
#   2. the DKIM registry with trionlabs.dev's domain hash and the pinned key's hash;
#   3. the approval registry with the verifier, the DKIM registry, the delivery verifying key, project "mailmarks";
#   4. the consumer, pointing at the registry;
# then writes docs/deployments/testnet.json for the page. Testnet only, and only with the owner's approval. Run once
# on 21 Nov 2026: docs/deployments/README.md.
# Usage: bash scripts/deploy-testnet.sh <stellar identity with test XLM>
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=${1:?usage: bash scripts/deploy-testnet.sh <stellar identity>}
CFG=contracts/deploy/delivery.json
[ ! -e docs/deployments/testnet.json ] || { echo "docs/deployments/testnet.json exists: this deployment was made already"; exit 1; }
cfg() {
  node -e '
    const config = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const field = process.argv[2];
    if (!Object.hasOwn(config, field)) throw new Error("Missing deployment field " + field);
    const value = config[field];
    console.log(typeof value === "string" ? value : JSON.stringify(value));
  ' "$CFG" "$1"
}
RPC_URL=https://soroban-testnet.stellar.org
PASSPHRASE='Test SDF Network ; September 2015'
NET=(--rpc-url "$RPC_URL" --network-passphrase "$PASSPHRASE" --source-account "$SRC")
project_id=$(cfg projectId)
W=contracts/target/wasm32v1-none/release
(cd contracts && stellar contract build)

verifier=$(stellar contract deploy "${NET[@]}" --wasm $W/groth16_verifier.wasm --alias mailmarks-verifier)
dkim=$(stellar contract deploy "${NET[@]}" --wasm $W/dkim_registry.wasm --alias mailmarks-dkim-registry -- \
  --domain_hash "$(cfg domainHash)" --public_key_hash "$(cfg dkimKeyHash)")
registry=$(stellar contract deploy "${NET[@]}" --wasm $W/approval_registry.wasm --alias mailmarks-registry -- \
  --verifier "$verifier" --dkim_registry "$dkim" --vk "$(cfg vk)" \
  --project_id "$project_id" --domain_hash "$(cfg domainHash)")
consumer=$(stellar contract deploy "${NET[@]}" --wasm $W/consumer.wasm --alias mailmarks-consumer -- --registry "$registry")

# The DKIM registry must hold the key, and nothing is approved yet.
[ "$(stellar contract invoke "${NET[@]}" --id "$dkim" --send=no -- is_key_hash_valid --domain_hash "$(cfg domainHash)" --public_key_hash "$(cfg dkimKeyHash)")" = true ]

mkdir -p docs/deployments
node -e '
const [verifier, dkim, registry, consumer, projectId, rpcUrl, networkPassphrase] = process.argv.slice(1);
const d = { rpcUrl, networkPassphrase, registry, projectId, senderDomain: "trionlabs.dev", expert: "https://stellar.expert/explorer/testnet",
  contracts: { verifier, dkimRegistry: dkim, registry, consumer }, deployed: new Date().toISOString() };
require("fs").writeFileSync("docs/deployments/testnet.json", JSON.stringify(d, null, 2) + "\n");' "$verifier" "$dkim" "$registry" "$consumer" "$project_id" "$RPC_URL" "$PASSPHRASE"
echo "verifier $verifier"; echo "dkim registry $dkim"; echo "registry $registry"; echo "consumer $consumer"
echo "wrote docs/deployments/testnet.json"

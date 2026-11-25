#!/usr/bin/env bash
# Delivery proving key for release_approval.circom (sender mintmarks@trionlabs.dev, 960-byte header buffer), on the Mac.
# One phase-2 contribution on the Hermez 2^20 ptau; its entropy comes from /dev/urandom through a pipe (never in a
# file or on the command line) and snarkjs mixes in 64 random bytes of its own. The key gets its final name only after
# `zkey verify` passes. Outputs in circuits/build/delivery/ (git-ignored); docs/setup.md records the run and the hashes.
# A real signed header over 951 bytes does not fit this key: the buffer grows first (docs/circuit.md, Open: 1536 bytes,
# a 2^21 ptau, so PTAU and PTAU_B2 here and MAX_HEADER in prover/src/inputs.js change too), then this script and
# delivery-config.js run again (docs/setup.md, "Made again if the real header is too long").
# Run from anywhere: bash circuits/scripts/delivery-setup.sh   (after dev-setup.sh has fetched the ptau)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=build/delivery
if [ -e "$OUT" ] || [ -L "$OUT" ]; then
  echo "$OUT already exists. Run the setup in a separate checkout to preserve the deployment's keys."
  exit 1
fi
PTAU=build/dev/powersOfTau28_hez_final_20.ptau
PTAU_B2=89a66eb5590a1c94e3f1ee0e72acf49b1669e050bb5f93c73b066b564dca4e0c7556a52b323178269d64af325d8fdddb33da3a27c34409b821de82aa2bf1a27b
SNARKJS="node node_modules/snarkjs/build/cli.cjs"
circom --version 2>/dev/null | grep -qF 2.2.3 || { echo "circom 2.2.3 must be on PATH (docs/toolchain.md)"; exit 1; }
[ -f node_modules/snarkjs/build/cli.cjs ] || { echo 'Install prover and circuits dependencies with npm ci --ignore-scripts first.'; exit 1; }
[ -f $PTAU ] || { echo "$PTAU is missing: run bash circuits/scripts/dev-setup.sh first (it downloads and checks it)"; exit 1; }
b2() { node -e 'const h=require("crypto").createHash("blake2b512");require("fs").createReadStream(process.argv[1]).on("data",d=>h.update(d)).on("end",()=>console.log(h.digest("hex")))' "$1"; }
[ "$(b2 $PTAU)" = "$PTAU_B2" ] || { echo "$PTAU does not match the snarkjs README hash"; exit 1; }
mkdir "$OUT"

step() { # name, command...
  local name=$1; shift
  echo "== $name"
  /usr/bin/time -l "$@" 2> $OUT/.time || { cat $OUT/.time; exit 1; }
  echo "$name: $(awk '/ real /{print $1}' $OUT/.time) s, peak $(awk '/maximum resident set size/{printf "%.1f", $1/1073741824}' $OUT/.time) GB" | tee -a $OUT/times.txt
}

echo "Mac $(sysctl -n machdep.cpu.brand_string), $(($(sysctl -n hw.memsize)/1073741824)) GB, $(date -u +%FT%TZ); ptau blake2b matches" > $OUT/times.txt
step "circom compile" circom release_approval.circom --r1cs --wasm -l node_modules -o $OUT
step "groth16 setup" $SNARKJS groth16 setup $OUT/release_approval.r1cs $PTAU $OUT/release_approval_0000.zkey
head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | { cat; echo; } |
  step "zkey contribute" $SNARKJS zkey contribute $OUT/release_approval_0000.zkey $OUT/release_approval_new.zkey --name="mailmarks delivery (testnet)"
rm -f $OUT/release_approval_0000.zkey
step "zkey verify" $SNARKJS zkey verify $OUT/release_approval.r1cs $PTAU $OUT/release_approval_new.zkey | tee $OUT/zkey-verify.txt
grep -q "ZKey Ok!" $OUT/zkey-verify.txt || { echo "zkey verify did not print ZKey Ok!"; exit 1; }
mv $OUT/release_approval_new.zkey $OUT/release_approval.zkey
$SNARKJS zkey export verificationkey $OUT/release_approval.zkey $OUT/release_approval_vk.json
(cd $OUT && shasum -a 256 release_approval.r1cs release_approval_js/release_approval.wasm release_approval.zkey release_approval_vk.json | tee sha256.txt)
echo "done: $OUT/release_approval.zkey, $OUT/release_approval_vk.json"

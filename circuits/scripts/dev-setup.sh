#!/usr/bin/env bash
# DEV proving key for the TEST circuit (approver@mailmarks.test). Not the delivery key: that one is made for
# release_approval.circom by delivery-setup.sh (docs/setup.md). Every output goes to circuits/build/dev/ (git-ignored); times and peak memory of
# each step go to build/dev/times.txt (peak memory on macOS). Run from anywhere: bash circuits/scripts/dev-setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=build/dev
PTAU=$OUT/powersOfTau28_hez_final_20.ptau
# blake2b-512 from the snarkjs 0.7.6 README table (power 20).
PTAU_B2=89a66eb5590a1c94e3f1ee0e72acf49b1669e050bb5f93c73b066b564dca4e0c7556a52b323178269d64af325d8fdddb33da3a27c34409b821de82aa2bf1a27b
mkdir -p $OUT
circom --version 2>/dev/null | grep -qF 2.2.3 || { echo "circom 2.2.3 must be on PATH (docs/toolchain.md)"; exit 1; }
SNARKJS="node node_modules/snarkjs/build/cli.cjs"
[ -f node_modules/snarkjs/build/cli.cjs ] || { echo 'Install prover and circuits dependencies with npm ci --ignore-scripts first.'; exit 1; }
OS=$(uname -s)

step() { # name, command...
  local name=$1; shift
  echo "== $name"
  local secs mem
  if [ "$OS" = Darwin ]; then
    /usr/bin/time -l "$@" 2> "$OUT/.time" || { cat "$OUT/.time"; exit 1; }
    secs=$(awk '/ real /{print $1}' "$OUT/.time")
    mem=$(awk '/maximum resident set size/{printf "%.1f", $1/1073741824}' "$OUT/.time")
    echo "$name: ${secs} s, peak ${mem} GB" | tee -a "$OUT/times.txt"
  else
    { time -p "$@"; } 2> "$OUT/.time" || { cat "$OUT/.time"; exit 1; }
    secs=$(awk '$1 == "real" {print $2}' "$OUT/.time")
    echo "$name: ${secs} s" | tee -a "$OUT/times.txt"
  fi
}

b2() { node -e 'const h=require("crypto").createHash("blake2b512");require("fs").createReadStream(process.argv[1]).on("data",d=>h.update(d)).on("end",()=>console.log(h.digest("hex")))' "$1"; }
# Downloaded to .part and moved only after the hash matches, so a broken download never stays under the final name.
if [ ! -f $PTAU ]; then
  curl -fL --retry 3 -o $PTAU.part https://circom.info/powersOfTau28_hez_final_20.ptau ||
    { rm -f $PTAU.part; echo "Could not download the ptau file. Run this script again."; exit 1; }
  [ "$(b2 $PTAU.part)" = "$PTAU_B2" ] ||
    { rm -f $PTAU.part; echo "The downloaded ptau file does not match the snarkjs README hash and was deleted. Run this script again."; exit 1; }
  mv $PTAU.part $PTAU
fi
[ "$(b2 $PTAU)" = "$PTAU_B2" ] || { echo "$PTAU does not match the snarkjs README hash. Delete it and run this script again."; exit 1; }
echo "ptau blake2b matches the snarkjs README"

: > $OUT/times.txt
echo "$(uname -sm), $(date -u +%FT%TZ)" >> $OUT/times.txt
# The blake2b match above means this is the file whose full `powersoftau verify` passed on the Mac (docs/circuit.md:
# 20 and 21 Nov), so the full check (26–40 min) runs only on request: FULL_VERIFY=1 bash circuits/scripts/dev-setup.sh
if [ "${FULL_VERIFY:-0}" = 1 ]; then
  step "ptau verify" $SNARKJS powersoftau verify $PTAU
else
  echo "ptau verify: skipped (blake2b matches; FULL_VERIFY=1 runs it)" | tee -a $OUT/times.txt
fi
step "circom compile" circom test/release_approval_test.circom --r1cs --wasm -l node_modules -o $OUT
step "groth16 setup" $SNARKJS groth16 setup $OUT/release_approval_test.r1cs $PTAU $OUT/dev_0000.zkey
# The new key gets its final name only after zkey verify passes; dev-fixture.js never sees an unverified key.
# The entropy comes through a pipe, never on the command line, as in delivery-setup.sh.
head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | { cat; echo; } |
  step "zkey contribute" $SNARKJS zkey contribute $OUT/dev_0000.zkey $OUT/dev_new.zkey --name="mailmarks DEV (not for delivery)"
rm -f $OUT/dev_0000.zkey
step "zkey verify" $SNARKJS zkey verify $OUT/release_approval_test.r1cs $PTAU $OUT/dev_new.zkey | tee $OUT/zkey-verify.txt
grep -qF 'ZKey Ok!' "$OUT/zkey-verify.txt" || { echo 'The DEV key did not pass verification'; exit 1; }
mv $OUT/dev_new.zkey $OUT/dev.zkey
$SNARKJS zkey export verificationkey $OUT/dev.zkey $OUT/dev_vk.json
echo "done: $OUT/dev.zkey, $OUT/dev_vk.json"

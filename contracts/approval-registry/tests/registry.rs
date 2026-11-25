//! Approval-registry tests (docs/scope.md, deliverable 2). Each rejection test starts from its own ledger and
//! asserts the exact error and that nothing was written: no approval, no nullifier, no event.
mod common;

use approval_registry::{Error, Proof};
use ark_bn254::G1Affine;
use common::*;
use soroban_sdk::{
    Address, BytesN, Env, IntoVal, InvokeError, String, Symbol, Val, Vec,
    crypto::bn254::Bn254G1Affine,
    testutils::{Address as _, Events as _, Ledger as _, storage::Persistent as _},
};

const N1: u8 = 0x21;
const N2: u8 = 0x22;

type Res = Result<(), Result<Error, InvokeError>>;

fn submit(w: &World, wallet: &Address, project: &str, artifact: [u8; 32], key: [u8; 32], nullifier: [u8; 32], p: &Proof) -> Res {
    let e = &w.env;
    match w.client.try_submit(
        wallet,
        &String::from_str(e, project),
        &BytesN::from_array(e, &artifact),
        &BytesN::from_array(e, &key),
        &BytesN::from_array(e, &nullifier),
        p,
    ) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(c)) => panic!("conversion error {c:?}"),
        Err(e) => Err(e),
    }
}

fn wallet(e: &Env, v: &Vector) -> Address {
    Address::from_str(e, v.wallet)
}

fn persistent_entries(w: &World) -> u32 {
    w.env.as_contract(&w.registry, || w.env.storage().persistent().all().len())
}

fn approved(w: &World, project: &str, artifact: [u8; 32]) -> bool {
    w.client.is_approved(&String::from_str(&w.env, project), &BytesN::from_array(&w.env, &artifact))
}

/// The call failed with exactly `want` and left the registry as it was.
fn assert_rejected(w: &World, got: Res, want: Error, entries_before: u32) {
    assert_eq!(got, Err(Ok(want)));
    // Read before `persistent_entries`: the host clears the event buffer when a new top-level frame starts.
    assert_eq!(w.env.events().all().filter_by_contract(&w.registry).events().len(), 0, "a rejected call emitted an event");
    assert_eq!(persistent_entries(w), entries_before, "a rejected call wrote storage");
}

/// A world with one valid approval of vector 0 (nullifier N1) already recorded.
fn approved_world<'a>(prover: &mut Prover) -> (World<'a>, Proof, ark_groth16::Proof<ark_bn254::Bn254>) {
    let v = &vectors()[0];
    let w = world(prover, v.project, true);
    let ark = prover.prove(inputs(v, fixed(KEY), fixed(N1)));
    let p = proof(&w.env, &ark);
    submit(&w, &wallet(&w.env, v), v.project, v.artifact, fixed(KEY), fixed(N1), &p).unwrap();
    (w, p, ark)
}

#[test]
fn valid_approval_is_recorded_and_readable_by_a_consumer() {
    let mut prover = Prover::new();
    let v = &vectors()[0];
    let w = world(&prover, v.project, true);
    let consumer = consumer::ConsumerClient::new(&w.env, &w.consumer);
    let (project, artifact) = (String::from_str(&w.env, v.project), BytesN::from_array(&w.env, &v.artifact));
    assert!(!consumer.release_allowed(&project, &artifact));

    let p = proof(&w.env, &prover.prove(inputs(v, fixed(KEY), fixed(N1))));
    submit(&w, &wallet(&w.env, v), v.project, v.artifact, fixed(KEY), fixed(N1), &p).unwrap();
    assert_eq!(w.env.events().all().filter_by_contract(&w.registry).events().len(), 1);

    let r = w.env.cost_estimate().resources();
    println!("submit (native, 7 inputs): {r:#?}\nfee estimate: {:#?}", w.env.cost_estimate().fee());

    assert!(consumer.release_allowed(&project, &artifact));
    assert!(!consumer.release_allowed(&String::from_str(&w.env, "other"), &artifact));
    assert!(!consumer.release_allowed(&project, &BytesN::from_array(&w.env, &[0; 32])));
    // Approval and nullifier are persistent and extended to the maximum TTL.
    let max = w.env.as_contract(&w.registry, || w.env.storage().max_ttl());
    w.env.as_contract(&w.registry, || {
        let p = w.env.storage().persistent();
        assert_eq!(p.get_ttl(&approval_registry::DataKey::Approval(artifact.clone())), max);
        assert_eq!(p.get_ttl(&approval_registry::DataKey::Nullifier(BytesN::from_array(&w.env, &fixed(N1)))), max);
    });
}

#[test]
fn both_shared_vectors_verify_with_signals_rebuilt_on_chain() {
    // Vector 1 is the edge case: 1-character project, artifact_hi = 0.
    let mut prover = Prover::new();
    for v in &vectors() {
        let w = world(&prover, v.project, true);
        let p = proof(&w.env, &prover.prove(inputs(v, fixed(KEY), fixed(N1))));
        submit(&w, &wallet(&w.env, v), v.project, v.artifact, fixed(KEY), fixed(N1), &p).unwrap();
        assert!(approved(&w, v.project, v.artifact));
    }
}

#[test]
fn replay_is_rejected() {
    let mut prover = Prover::new();
    let v = &vectors()[0];

    // Same proof again.
    let (w, p, ark) = approved_world(&mut prover);
    let n = persistent_entries(&w);
    let got = submit(&w, &wallet(&w.env, v), v.project, v.artifact, fixed(KEY), fixed(N1), &p);
    assert_rejected(&w, got, Error::NullifierUsed, n);

    // A re-randomized proof: different bytes, valid on its own (fresh registry), rejected here by its nullifier.
    let ark2 = prover.rerandomize(&ark);
    assert_ne!((ark2.a, ark2.c), (ark.a, ark.c));
    let fresh = world(&prover, v.project, true);
    submit(&fresh, &wallet(&fresh.env, v), v.project, v.artifact, fixed(KEY), fixed(N1), &proof(&fresh.env, &ark2)).unwrap();
    let got = submit(&w, &wallet(&w.env, v), v.project, v.artifact, fixed(KEY), fixed(N1), &proof(&w.env, &ark2));
    assert_rejected(&w, got, Error::NullifierUsed, n);

    // The same nullifier encoded as nullifier + r (Bn254Fr would reduce it to the same field element).
    let plus_r = add_be(fixed(N1), R_BYTES);
    let got = submit(&w, &wallet(&w.env, v), v.project, v.artifact, fixed(KEY), plus_r, &p);
    assert_rejected(&w, got, Error::NonCanonical, n);
}

#[test]
fn second_valid_approval_for_the_same_artifact_is_rejected() {
    let mut prover = Prover::new();
    let v = &vectors()[0];
    let (w, _, _) = approved_world(&mut prover);
    let n = persistent_entries(&w);
    let p2 = proof(&w.env, &prover.prove(inputs(v, fixed(KEY), fixed(N2))));
    let got = submit(&w, &wallet(&w.env, v), v.project, v.artifact, fixed(KEY), fixed(N2), &p2);
    assert_rejected(&w, got, Error::AlreadyApproved, n);
}

#[test]
fn wrong_project_is_rejected() {
    let mut prover = Prover::new();
    let (v0, v1) = (&vectors()[0], &vectors()[1]);
    // Submitted under another project id.
    let w = world(&prover, v0.project, true);
    let n0 = persistent_entries(&w);
    let p = proof(&w.env, &prover.prove(inputs(v0, fixed(KEY), fixed(N1))));
    let got = submit(&w, &wallet(&w.env, v0), "other", v0.artifact, fixed(KEY), fixed(N1), &p);
    assert_rejected(&w, got, Error::WrongProject, n0);
    // A proof whose project signal is another project's, submitted under the registry's project.
    let w = world(&prover, v0.project, true);
    let n0 = persistent_entries(&w);
    let mut x = inputs(v0, fixed(KEY), fixed(N1));
    x[2] = v1.signals[2];
    let p = proof(&w.env, &prover.prove(x));
    let got = submit(&w, &wallet(&w.env, v0), v0.project, v0.artifact, fixed(KEY), fixed(N1), &p);
    assert_rejected(&w, got, Error::InvalidProof, n0);
}

#[test]
fn wrong_artifact_is_rejected() {
    let mut prover = Prover::new();
    let v = &vectors()[0];
    let w = world(&prover, v.project, true);
    let n0 = persistent_entries(&w);
    let p = proof(&w.env, &prover.prove(inputs(v, fixed(KEY), fixed(N1))));
    let mut other = v.artifact;
    other[31] ^= 1;
    let got = submit(&w, &wallet(&w.env, v), v.project, other, fixed(KEY), fixed(N1), &p);
    assert_rejected(&w, got, Error::InvalidProof, n0);
    assert!(!approved(&w, v.project, other));
}

#[test]
fn wrong_wallet_is_rejected() {
    // Another G account that does authorize the call: the rebuilt wallet limbs differ from the proof's.
    let mut prover = Prover::new();
    let (v0, v1) = (&vectors()[0], &vectors()[1]);
    let w = world(&prover, v0.project, true);
    let n0 = persistent_entries(&w);
    let p = proof(&w.env, &prover.prove(inputs(v0, fixed(KEY), fixed(N1))));
    let got = submit(&w, &wallet(&w.env, v1), v0.project, v0.artifact, fixed(KEY), fixed(N1), &p);
    assert_rejected(&w, got, Error::InvalidProof, n0);
}

#[test]
fn missing_wallet_authorization_is_rejected() {
    // No auth mocked: require_auth fails with a host error (not a registry error), nothing written. The same call
    // then succeeds once the wallet's auth is mocked, so the missing authorization was the only thing wrong.
    let mut prover = Prover::new();
    let v = &vectors()[0];
    let w = world(&prover, v.project, false);
    let n0 = persistent_entries(&w);
    let p = proof(&w.env, &prover.prove(inputs(v, fixed(KEY), fixed(N1))));
    let got = submit(&w, &wallet(&w.env, v), v.project, v.artifact, fixed(KEY), fixed(N1), &p);
    assert_eq!(got, Err(Err(InvokeError::Abort)), "expected a host (non-contract) error");
    assert_eq!(w.env.events().all().filter_by_contract(&w.registry).events().len(), 0);
    assert_eq!(persistent_entries(&w), n0);
    assert!(!approved(&w, v.project, v.artifact));
    w.env.mock_all_auths();
    submit(&w, &wallet(&w.env, v), v.project, v.artifact, fixed(KEY), fixed(N1), &p).unwrap();
    assert!(approved(&w, v.project, v.artifact));
}

#[test]
fn contract_address_as_wallet_is_rejected() {
    let mut prover = Prover::new();
    let v = &vectors()[0];
    let w = world(&prover, v.project, true);
    let n0 = persistent_entries(&w);
    let p = proof(&w.env, &prover.prove(inputs(v, fixed(KEY), fixed(N1))));
    let c = w.consumer.clone();
    let got = submit(&w, &c, v.project, v.artifact, fixed(KEY), fixed(N1), &p);
    assert_rejected(&w, got, Error::BadWallet, n0);
}

#[test]
fn unregistered_key_is_rejected() {
    let mut prover = Prover::new();
    let v = &vectors()[0];
    let w = world(&prover, v.project, true);
    let n0 = persistent_entries(&w);
    // A valid proof over a key hash the registry does not hold.
    let other = fixed(0x12);
    let p = proof(&w.env, &prover.prove(inputs(v, other, fixed(N1))));
    let got = submit(&w, &wallet(&w.env, v), v.project, v.artifact, other, fixed(N1), &p);
    assert_rejected(&w, got, Error::UnknownKey, n0);
    // A key hash ≥ r is refused before any lookup.
    let mut big = [0xff; 32];
    big[0] = 0x31;
    let got = submit(&w, &wallet(&w.env, v), v.project, v.artifact, big, fixed(N1), &p);
    assert_rejected(&w, got, Error::NonCanonical, n0);
}

#[test]
fn tampered_proof_is_rejected() {
    let mut prover = Prover::new();
    let v = &vectors()[0];
    let ark = prover.prove(inputs(v, fixed(KEY), fixed(N1)));

    // Well-formed but wrong: A negated. The verifier returns false.
    let w = world(&prover, v.project, true);
    let n0 = persistent_entries(&w);
    let mut p = proof(&w.env, &ark);
    p.a = g1(&w.env, &G1Affine::from(-ark.a));
    let got = submit(&w, &wallet(&w.env, v), v.project, v.artifact, fixed(KEY), fixed(N1), &p);
    assert_rejected(&w, got, Error::InvalidProof, n0);

    // Malformed: A is not on the curve. The verifier call fails; the registry maps it to a typed error.
    let w = world(&prover, v.project, true);
    let n0 = persistent_entries(&w);
    let mut p = proof(&w.env, &ark);
    let mut bad = [0u8; 64];
    bad[31] = 1;
    bad[63] = 1;
    p.a = Bn254G1Affine::from_bytes(BytesN::from_array(&w.env, &bad));
    let got = submit(&w, &wallet(&w.env, v), v.project, v.artifact, fixed(KEY), fixed(N1), &p);
    assert_rejected(&w, got, Error::MalformedProof, n0);

    // One byte flipped in C.
    let w = world(&prover, v.project, true);
    let n0 = persistent_entries(&w);
    let mut p = proof(&w.env, &ark);
    let mut c = p.c.to_bytes().to_array();
    c[40] ^= 1;
    p.c = Bn254G1Affine::from_bytes(BytesN::from_array(&w.env, &c));
    let got = submit(&w, &wallet(&w.env, v), v.project, v.artifact, fixed(KEY), fixed(N1), &p);
    assert!(matches!(got, Err(Ok(Error::MalformedProof)) | Err(Ok(Error::InvalidProof))), "{got:?}");
    assert_eq!(persistent_entries(&w), n0);
}

#[test]
fn every_public_input_is_bound_by_the_proof() {
    // Directly against the verifier: the proof fails when any one of the 7 inputs changes.
    let mut prover = Prover::new();
    let v = &vectors()[0];
    let x = inputs(v, fixed(KEY), fixed(N1));
    let w = world(&prover, v.project, true);
    let p = proof(&w.env, &prover.prove(x));
    let verifier = groth16_verifier::Groth16VerifierClient::new(&w.env, &w.verifier);
    let key = vk(&w.env, &prover.vk);
    let to_vec = |x: &[ark_bn254::Fr; 7]| {
        let mut out = Vec::new(&w.env);
        for f in x {
            out.push_back(bn_fr(&w.env, f));
        }
        out
    };
    let conv = |k: &approval_registry::VerificationKey, p: &Proof| {
        (
            groth16_verifier::VerificationKey { alpha: k.alpha.clone(), beta: k.beta.clone(), gamma: k.gamma.clone(), delta: k.delta.clone(), ic: k.ic.clone() },
            groth16_verifier::Proof { a: p.a.clone(), b: p.b.clone(), c: p.c.clone() },
        )
    };
    let (gk, gp) = conv(&key, &p);
    assert!(verifier.verify_proof(&gk, &gp, &to_vec(&x)));
    for i in 0..7 {
        let mut y = x;
        y[i] += ark_bn254::Fr::from(1u64);
        assert!(!verifier.verify_proof(&gk, &gp, &to_vec(&y)), "input {i} not bound");
    }
}

#[test]
fn dkim_registry_has_no_set_or_revoke_entry_point() {
    let prover = Prover::new();
    let w = world(&prover, "mailmarks", true);
    let e = &w.env;
    let (d, k) = (BytesN::from_array(e, &DOMAIN), BytesN::from_array(e, &fixed(0x12)));
    let op = Address::generate(e);
    let calls: [(&str, Vec<Val>); 3] = [
        ("set_dkim_public_key_hash", (d.clone(), k.clone(), op.clone()).into_val(e)),
        ("set_dkim_public_key_hashes", (d.clone(), Vec::from_array(e, [k.clone()]), op.clone()).into_val(e)),
        ("revoke_dkim_public_key_hash", (BytesN::from_array(e, &fixed(KEY)), op.clone()).into_val(e)),
    ];
    // The contract's only exported functions are the constructor and the two reads. Checked on the source because
    // the WASM spec is not built by `cargo test`. Every `fn`
    // in the file counts, pub or not, so an entry point added in a trait impl or a second #[contractimpl] is caught.
    let src = include_str!("../../dkim-registry/src/lib.rs");
    let mut fns: std::vec::Vec<&str> = src
        .split("fn ")
        .skip(1)
        .map(|r| r.split(|c: char| c == '(' || c == '<').next().unwrap().trim())
        .collect();
    fns.sort();
    assert_eq!(fns, ["__constructor", "is_key_hash_revoked", "is_key_hash_valid"]);
    assert_eq!(src.matches("#[contractimpl").count(), 1, "one contractimpl block");
    for (name, args) in calls {
        let r = e.try_invoke_contract::<(), InvokeError>(&w.dkim, &Symbol::new(e, name), args);
        assert!(r.is_err(), "{name} exists");
    }
    let reg = dkim_registry::DkimRegistryClient::new(e, &w.dkim);
    assert!(reg.is_key_hash_valid(&d, &BytesN::from_array(e, &fixed(KEY))));
    assert!(!reg.is_key_hash_valid(&d, &k));
    assert!(!reg.is_key_hash_revoked(&BytesN::from_array(e, &fixed(KEY))));
}

#[test]
fn archived_entries_after_ttl() {
    // Controlled ledger: move past every TTL and record what the native test host does on read and replay.
    // On the network, protocol ≥ 23 restores an archived persistent entry when it is in the transaction's
    // read-write footprint; `stellar contract restore` is the manual fallback (docs/contract-storage.md).
    let mut prover = Prover::new();
    let v = &vectors()[0];
    // Every entry is past its TTL, including the consumer's instance, which nothing extends.
    let (w, p, _) = approved_world(&mut prover);
    let n0 = persistent_entries(&w);
    let (project, artifact) = (String::from_str(&w.env, v.project), BytesN::from_array(&w.env, &v.artifact));
    let akey = approval_registry::DataKey::Approval(artifact.clone());
    let max = w.env.as_contract(&w.registry, || w.env.storage().max_ttl());
    w.env.ledger().with_mut(|l| l.sequence_number += max + 1);
    let consumer = consumer::ConsumerClient::new(&w.env, &w.consumer);
    // Observed: the host restores each expired entry on access (with the minimum TTL), so the cross-contract read,
    // the direct read and the replay all behave as before archival.
    assert!(consumer.release_allowed(&project, &artifact), "consumer read after archival");
    assert!(approved(&w, v.project, v.artifact), "direct read after archival");
    let replay = submit(&w, &wallet(&w.env, v), v.project, v.artifact, fixed(KEY), fixed(N1), &p);
    assert_rejected(&w, replay, Error::NullifierUsed, n0);
    let ttl = w.env.as_contract(&w.registry, || w.env.storage().persistent().get_ttl(&akey));
    // Restored with the host's minimum persistent TTL (live until sequence + min − 1), not re-extended to the maximum.
    let min = w.env.ledger().get().min_persistent_entry_ttl;
    assert_eq!(ttl, min - 1, "approval restored with the minimum TTL");
}

/// BN254 scalar field order r, big-endian.
const R_BYTES: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d, 0x28, 0x33, 0xe8,
    0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// a + b as 256-bit big-endian (no overflow for the values used here).
fn add_be(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let s = a[i] as u16 + b[i] as u16 + carry;
        out[i] = s as u8;
        carry = s >> 8;
    }
    assert_eq!(carry, 0);
    out
}

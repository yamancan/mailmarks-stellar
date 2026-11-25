//! Test fixtures: a dev-only arkworks Groth16 circuit with the registry's 7 public inputs, so every test runs the
//! real BN254 pairing check independently of the circom circuit. The circom fixtures are in tests/circom.rs.
#![allow(dead_code)]

use approval_registry::{ApprovalRegistry, ApprovalRegistryClient, Proof, VerificationKey};
use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_crypto_primitives::snark::{CircuitSpecificSetupSNARK, SNARK};
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::Groth16;
use ark_relations::{
    gr1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError},
    lc,
};
use ark_std::rand::{SeedableRng, rngs::StdRng};
use soroban_sdk::{
    Address, BytesN, Env, String, Vec,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
};
use std::str::FromStr;

/// Every public input is bound to its own witness by one constraint, so changing any input breaks the proof.
#[derive(Clone)]
struct SevenInputs(Option<[Fr; 7]>);

impl ConstraintSynthesizer<Fr> for SevenInputs {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        for i in 0..7 {
            let v = || self.0.map(|x| x[i]).ok_or(SynthesisError::AssignmentMissing);
            let w = cs.new_witness_variable(v)?;
            let x = cs.new_input_variable(v)?;
            cs.enforce_r1cs_constraint(|| lc!() + w, || lc!() + ark_relations::gr1cs::Variable::One, || lc!() + x)?;
        }
        Ok(())
    }
}

pub struct Prover {
    pk: ark_groth16::ProvingKey<Bn254>,
    pub vk: ark_groth16::VerifyingKey<Bn254>,
    rng: StdRng,
}

impl Prover {
    pub fn new() -> Self {
        let mut rng = StdRng::seed_from_u64(7);
        let (pk, vk) = Groth16::<Bn254>::setup(SevenInputs(None), &mut rng).unwrap();
        Prover { pk, vk, rng }
    }
    pub fn prove(&mut self, inputs: [Fr; 7]) -> ark_groth16::Proof<Bn254> {
        Groth16::<Bn254>::prove(&self.pk, SevenInputs(Some(inputs)), &mut self.rng).unwrap()
    }
    pub fn rerandomize(&mut self, p: &ark_groth16::Proof<Bn254>) -> ark_groth16::Proof<Bn254> {
        Groth16::<Bn254>::rerandomize_proof(&self.vk, p, &mut self.rng)
    }
}

// soroban-sdk BN254 encoding: Fp big-endian; G1 = X‖Y; G2 = X‖Y with each Fp2 as c1‖c0.
fn fq(b: &mut std::vec::Vec<u8>, x: &Fq) {
    b.extend(x.into_bigint().to_bytes_be());
}
fn fq2(b: &mut std::vec::Vec<u8>, x: &Fq2) {
    fq(b, &x.c1);
    fq(b, &x.c0);
}
pub fn g1(env: &Env, p: &G1Affine) -> Bn254G1Affine {
    let mut b = vec![];
    fq(&mut b, &p.x);
    fq(&mut b, &p.y);
    Bn254G1Affine::from_bytes(BytesN::from_array(env, &b.try_into().unwrap()))
}
pub fn g2(env: &Env, p: &G2Affine) -> Bn254G2Affine {
    let mut b = vec![];
    fq2(&mut b, &p.x);
    fq2(&mut b, &p.y);
    Bn254G2Affine::from_bytes(BytesN::from_array(env, &b.try_into().unwrap()))
}
pub fn vk(env: &Env, v: &ark_groth16::VerifyingKey<Bn254>) -> VerificationKey {
    let mut ic = Vec::new(env);
    for p in &v.gamma_abc_g1 {
        ic.push_back(g1(env, p));
    }
    VerificationKey {
        alpha: g1(env, &v.alpha_g1),
        beta: g2(env, &v.beta_g2),
        gamma: g2(env, &v.gamma_g2),
        delta: g2(env, &v.delta_g2),
        ic,
    }
}
pub fn proof(env: &Env, p: &ark_groth16::Proof<Bn254>) -> Proof {
    Proof { a: g1(env, &p.a), b: g2(env, &p.b), c: g1(env, &p.c) }
}
pub fn fr_bytes(f: &Fr) -> [u8; 32] {
    f.into_bigint().to_bytes_be().try_into().unwrap()
}
pub fn bn_fr(env: &Env, f: &Fr) -> Bn254Fr {
    Bn254Fr::from_bytes(BytesN::from_array(env, &fr_bytes(f)))
}

/// One entry of docs/public-input-vectors.json (shared with the prover tests).
pub struct Vector {
    pub project: &'static str,
    pub artifact: [u8; 32],
    pub wallet: &'static str,
    /// wallet_0, wallet_1, project_id, artifact_hi, artifact_lo.
    pub signals: [Fr; 5],
}

pub fn vectors() -> std::vec::Vec<Vector> {
    let j: serde_json::Value =
        serde_json::from_str(include_str!("../../../../docs/public-input-vectors.json")).unwrap();
    let order: std::vec::Vec<&str> = j["order"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
    assert_eq!(order, ["wallet_0", "wallet_1", "project_id", "artifact_hi", "artifact_lo", "dkim_key_hash", "nullifier"]);
    j["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            let leak = |s: &serde_json::Value| -> &'static str { Box::leak(s.as_str().unwrap().to_owned().into_boxed_str()) };
            let hex = v["fields"]["artifactSha256"].as_str().unwrap();
            let artifact: [u8; 32] =
                (0..32).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect::<std::vec::Vec<_>>().try_into().unwrap();
            Vector {
                project: leak(&v["fields"]["projectId"]),
                artifact,
                wallet: leak(&v["fields"]["wallet"]),
                signals: order[..5].iter().map(|k| Fr::from_str(v["signals"][*k].as_str().unwrap()).unwrap()).collect::<std::vec::Vec<_>>().try_into().unwrap(),
            }
        })
        .collect()
}

/// DKIM key hash and nullifier fixtures: fixed canonical values (the shared vectors carry only five signals;
/// the real ones come from the circuit's output).
pub fn fixed(tag: u8) -> [u8; 32] {
    let mut b = [tag; 32];
    b[0] = 0x01;
    b
}
pub const KEY: u8 = 0x11;
pub const DOMAIN: [u8; 32] = [0xd0; 32];

pub fn inputs(v: &Vector, key: [u8; 32], nullifier: [u8; 32]) -> [Fr; 7] {
    let s = &v.signals;
    [s[0], s[1], s[2], s[3], s[4], Fr::from_be_bytes_mod_order(&key), Fr::from_be_bytes_mod_order(&nullifier)]
}

pub struct World<'a> {
    pub env: Env,
    pub verifier: Address,
    pub dkim: Address,
    pub registry: Address,
    pub consumer: Address,
    pub client: ApprovalRegistryClient<'a>,
}

/// Fresh ledger with the four contracts; `project` is fixed in the registry.
pub fn world<'a>(prover: &Prover, project: &str, auth: bool) -> World<'a> {
    let env = Env::default();
    if auth {
        env.mock_all_auths();
    }
    let verifier = env.register(groth16_verifier::Groth16Verifier, ());
    let domain = BytesN::from_array(&env, &DOMAIN);
    let dkim = env.register(dkim_registry::DkimRegistry, (domain.clone(), BytesN::from_array(&env, &fixed(KEY))));
    let registry = env.register(
        ApprovalRegistry,
        (verifier.clone(), dkim.clone(), vk(&env, &prover.vk), String::from_str(&env, project), domain),
    );
    let consumer = env.register(consumer::Consumer, (registry.clone(),));
    let client = ApprovalRegistryClient::new(&env, &registry);
    World { env, verifier, dkim, registry, consumer, client }
}

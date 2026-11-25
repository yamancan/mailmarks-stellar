//! End-to-end with a real circom/snarkjs proof (DEV fixture, tests/fixtures/circom-dev.json, written by
//! circuits/scripts/dev-fixture.js): the SDF verifier copy (unchanged) and the registry accept it, and reject it
//! when a public signal, a proof byte or the G2 byte order changes. The delivery configuration (contracts/deploy/
//! delivery.json) constructs the contracts and its verifying key refuses the DEV proof.
use approval_registry::{ApprovalRegistry, ApprovalRegistryClient, Error, Proof, VerificationKey};
use soroban_sdk::{
    Address, BytesN, Env, InvokeError, String, Vec,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    testutils::Ledger as _,
};

pub struct Fixture {
    pub vk_hex: serde_json::Value,
    pub ap: serde_json::Value,
}

pub fn fixture() -> Fixture {
    let j: serde_json::Value = serde_json::from_str(include_str!("fixtures/circom-dev.json")).unwrap();
    assert!(j["note"].as_str().unwrap().starts_with("DEV fixture"));
    Fixture { vk_hex: j["vk"].clone(), ap: j["approvalProof"].clone() }
}

pub fn unhex<const N: usize>(s: &str) -> [u8; N] {
    assert_eq!(s.len(), 2 * N, "{s}");
    core::array::from_fn(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
}
fn s(v: &serde_json::Value) -> &str {
    v.as_str().unwrap()
}
pub fn g1(e: &Env, h: &str) -> Bn254G1Affine {
    Bn254G1Affine::from_bytes(BytesN::from_array(e, &unhex::<64>(h)))
}
pub fn g2(e: &Env, h: &str) -> Bn254G2Affine {
    Bn254G2Affine::from_bytes(BytesN::from_array(e, &unhex::<128>(h)))
}
/// The same G2 point with each Fp2 written c0‖c1 (snarkjs order) instead of soroban's c1‖c0.
pub fn swap_fp2(h: &str) -> std::string::String {
    let q = |i: usize| &h[64 * i..64 * (i + 1)];
    [q(1), q(0), q(3), q(2)].concat()
}

impl Fixture {
    pub fn vk(&self, e: &Env) -> VerificationKey {
        let v = &self.vk_hex;
        let mut ic = Vec::new(e);
        for p in v["ic"].as_array().unwrap() {
            ic.push_back(g1(e, s(p)));
        }
        VerificationKey { alpha: g1(e, s(&v["alpha"])), beta: g2(e, s(&v["beta"])), gamma: g2(e, s(&v["gamma"])), delta: g2(e, s(&v["delta"])), ic }
    }
    pub fn proof(&self, e: &Env) -> Proof {
        let so = &self.ap["soroban"];
        Proof { a: g1(e, s(&so["a"])), b: g2(e, s(&so["b"])), c: g1(e, s(&so["c"])) }
    }
    pub fn field(&self, k: &str) -> &str {
        s(&self.ap["fields"][k])
    }
    pub fn key_hash(&self) -> [u8; 32] {
        unhex(s(&self.ap["soroban"]["dkimKeyHash"]))
    }
    pub fn nullifier(&self) -> [u8; 32] {
        unhex(s(&self.ap["soroban"]["nullifier"]))
    }
    /// The 7 public signals as the verifier takes them (decimal strings -> 32-byte big-endian).
    pub fn signals(&self, e: &Env) -> Vec<Bn254Fr> {
        let mut out = Vec::new(e);
        for d in self.ap["publicSignals"].as_array().unwrap() {
            out.push_back(Bn254Fr::from_bytes(BytesN::from_array(e, &dec_be32(s(d)))));
        }
        out
    }
}

/// Decimal string to 32 bytes big-endian (values are below r < 2^254).
pub fn dec_be32(d: &str) -> [u8; 32] {
    let mut b = [0u8; 32];
    for ch in d.bytes() {
        let mut carry = (ch - b'0') as u32;
        for x in b.iter_mut().rev() {
            let v = *x as u32 * 10 + carry;
            *x = v as u8;
            carry = v >> 8;
        }
        assert_eq!(carry, 0);
    }
    b
}

pub const DOMAIN: [u8; 32] = [0xd0; 32];

pub struct World<'a> {
    pub env: Env,
    pub verifier: Address,
    pub client: ApprovalRegistryClient<'a>,
}

/// Fresh ledger with the verifier, the DKIM registry holding the fixture's key hash, and the registry. `swap` names a
/// verifying-key G2 point (beta, gamma, delta) to write in snarkjs c0‖c1 order instead.
pub fn world<'a>(f: &Fixture, swap: Option<&str>) -> World<'a> {
    let env = Env::default();
    env.mock_all_auths();
    let mut vk = f.vk(&env);
    if let Some(k) = swap {
        let swapped = g2(&env, &swap_fp2(s(&f.vk_hex[k])));
        match k {
            "beta" => vk.beta = swapped,
            "gamma" => vk.gamma = swapped,
            "delta" => vk.delta = swapped,
            _ => panic!("{k}"),
        }
    }
    let verifier = env.register(groth16_verifier::Groth16Verifier, ());
    let domain = BytesN::from_array(&env, &DOMAIN);
    let dkim = env.register(dkim_registry::DkimRegistry, (domain.clone(), BytesN::from_array(&env, &f.key_hash())));
    let registry = env.register(ApprovalRegistry, (verifier.clone(), dkim, vk, String::from_str(&env, f.field("projectId")), domain));
    let client = ApprovalRegistryClient::new(&env, &registry);
    World { env, verifier, client }
}

pub fn submit(w: &World, f: &Fixture, artifact: [u8; 32], nullifier: [u8; 32], p: &Proof) -> Result<(), Result<Error, InvokeError>> {
    let e = &w.env;
    match w.client.try_submit(
        &Address::from_str(e, f.field("wallet")),
        &String::from_str(e, f.field("projectId")),
        &BytesN::from_array(e, &artifact),
        &BytesN::from_array(e, &f.key_hash()),
        &BytesN::from_array(e, &nullifier),
        p,
    ) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(c)) => panic!("conversion error {c:?}"),
        Err(e) => Err(e),
    }
}

fn artifact(f: &Fixture) -> [u8; 32] {
    unhex(f.field("artifactSha256"))
}

#[test]
fn sdf_verifier_accepts_the_circom_proof() {
    let f = fixture();
    let e = Env::default();
    let v = groth16_verifier::Groth16VerifierClient::new(&e, &e.register(groth16_verifier::Groth16Verifier, ()));
    let vk = f.vk(&e);
    let vk = groth16_verifier::VerificationKey { alpha: vk.alpha, beta: vk.beta, gamma: vk.gamma, delta: vk.delta, ic: vk.ic };
    let p = f.proof(&e);
    let p = groth16_verifier::Proof { a: p.a, b: p.b, c: p.c };
    assert!(v.verify_proof(&vk, &p, &f.signals(&e)));
    // Each of the 7 public signals, changed by one, makes the pairing check fail.
    for i in 0..7 {
        let mut sig = f.signals(&e);
        let mut b = sig.get(i).unwrap().to_bytes().to_array();
        b[31] ^= 1;
        sig.set(i, Bn254Fr::from_bytes(BytesN::from_array(&e, &b)));
        assert!(!v.verify_proof(&vk, &p, &sig), "signal {i}");
    }
}

#[test]
fn registry_records_the_circom_approval_and_rejects_its_replay() {
    let f = fixture();
    let w = world(&f, None);
    let p = f.proof(&w.env);
    assert_eq!(submit(&w, &f, artifact(&f), f.nullifier(), &p), Ok(()));
    assert!(w.client.is_approved(&String::from_str(&w.env, f.field("projectId")), &BytesN::from_array(&w.env, &artifact(&f))));
    assert_eq!(submit(&w, &f, artifact(&f), f.nullifier(), &p), Err(Ok(Error::NullifierUsed)));
}

#[test]
fn changed_public_signal_is_rejected_by_the_registry() {
    let f = fixture();
    // Another artifact (signals 3-4) and another canonical nullifier (signal 6): the proof no longer matches.
    let mut other = artifact(&f);
    other[31] ^= 1;
    let w = world(&f, None);
    assert_eq!(submit(&w, &f, other, f.nullifier(), &f.proof(&w.env)), Err(Ok(Error::InvalidProof)));
    let mut n = f.nullifier();
    n[31] ^= 1;
    let w = world(&f, None);
    assert_eq!(submit(&w, &f, artifact(&f), n, &f.proof(&w.env)), Err(Ok(Error::InvalidProof)));
}

#[test]
fn changed_proof_bytes_are_rejected() {
    let f = fixture();
    let so = &f.ap["soroban"];
    // A byte of proof.a changed: the point is off the curve, the verifier call fails.
    let mut a = unhex::<64>(s(&so["a"]));
    a[63] ^= 1;
    let w = world(&f, None);
    let mut p = f.proof(&w.env);
    p.a = Bn254G1Affine::from_bytes(BytesN::from_array(&w.env, &a));
    assert_eq!(submit(&w, &f, artifact(&f), f.nullifier(), &p), Err(Ok(Error::MalformedProof)));
    // A valid point in the wrong place (c = a): the pairing check fails.
    let w = world(&f, None);
    let mut p = f.proof(&w.env);
    p.c = p.a.clone();
    assert_eq!(submit(&w, &f, artifact(&f), f.nullifier(), &p), Err(Ok(Error::InvalidProof)));
}

#[test]
fn g2_in_snarkjs_order_is_rejected() {
    let f = fixture();
    // proof.b written c0‖c1.
    let w = world(&f, None);
    let mut p = f.proof(&w.env);
    p.b = g2(&w.env, &swap_fp2(s(&f.ap["soroban"]["b"])));
    assert_eq!(submit(&w, &f, artifact(&f), f.nullifier(), &p), Err(Ok(Error::MalformedProof)));
    // The verifying key's beta, gamma or delta written c0‖c1.
    for k in ["beta", "gamma", "delta"] {
        let w = world(&f, Some(k));
        assert_eq!(submit(&w, &f, artifact(&f), f.nullifier(), &f.proof(&w.env)), Err(Ok(Error::MalformedProof)), "{k}");
    }
}

// ---- Delivery configuration (contracts/deploy/delivery.json, circuits/scripts/delivery-config.js) ----------------

fn delivery() -> serde_json::Value {
    serde_json::from_str(include_str!("../../deploy/delivery.json")).unwrap()
}

fn vk_from(e: &Env, v: &serde_json::Value) -> VerificationKey {
    let mut ic = Vec::new(e);
    for p in v["ic"].as_array().unwrap() {
        ic.push_back(g1(e, s(p)));
    }
    VerificationKey { alpha: g1(e, s(&v["alpha"])), beta: g2(e, s(&v["beta"])), gamma: g2(e, s(&v["gamma"])), delta: g2(e, s(&v["delta"])), ic }
}

#[test]
fn delivery_config_holds_the_pinned_key_and_domain() {
    let d = delivery();
    let key: serde_json::Value = serde_json::from_str(include_str!("../../../prover/keys/trionlabs.dev-google.json")).unwrap();
    assert_eq!(unhex::<32>(s(&d["dkimKeyHash"])), dec_be32(s(&key["keyHash"])));
    let e = Env::default();
    let domain = e.crypto().sha256(&soroban_sdk::Bytes::from_slice(&e, b"trionlabs.dev")).to_array();
    assert_eq!(unhex::<32>(s(&d["domainHash"])), domain);
    assert_eq!(s(&d["projectId"]), "mailmarks");
    assert_eq!(d["vk"]["ic"].as_array().unwrap().len(), 8);
}

#[test]
fn delivery_contracts_construct_and_refuse_a_dev_proof() {
    let d = delivery();
    let e = Env::default();
    e.mock_all_auths();
    let (domain, key) = (BytesN::from_array(&e, &unhex::<32>(s(&d["domainHash"]))), BytesN::from_array(&e, &unhex::<32>(s(&d["dkimKeyHash"]))));
    let verifier = e.register(groth16_verifier::Groth16Verifier, ());
    let dkim = e.register(dkim_registry::DkimRegistry, (domain.clone(), key.clone()));
    assert!(dkim_registry::DkimRegistryClient::new(&e, &dkim).is_key_hash_valid(&domain, &key));
    e.register(ApprovalRegistry, (verifier, dkim, vk_from(&e, &d["vk"]), String::from_str(&e, s(&d["projectId"])), domain));

    // The DEV proof, with its own key registered, against the delivery verifying key: the pairing check fails.
    let f = fixture();
    let w = world(&f, None);
    let registry = w.env.register(ApprovalRegistry, (
        w.verifier.clone(),
        w.env.register(dkim_registry::DkimRegistry, (BytesN::from_array(&w.env, &DOMAIN), BytesN::from_array(&w.env, &f.key_hash()))),
        vk_from(&w.env, &d["vk"]),
        String::from_str(&w.env, f.field("projectId")),
        BytesN::from_array(&w.env, &DOMAIN),
    ));
    let w = World { client: ApprovalRegistryClient::new(&w.env, &registry), ..w };
    assert_eq!(submit(&w, &f, artifact(&f), f.nullifier(), &f.proof(&w.env)), Err(Ok(Error::InvalidProof)));
}

const WASM_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/wasm32v1-none/release/");
fn wasm(name: &str) -> std::vec::Vec<u8> {
    let path = std::format!("{WASM_DIR}{name}.wasm");
    std::fs::read(&path).unwrap_or_else(|_| panic!("{path} is missing: run \x60stellar contract build\x60 in contracts/ first"))
}

/// Resource use of one `submit` with the four contracts as built WASM (`stellar contract build`), the real circom
/// proof and the testnet TTL settings (20 Nov 2026). A local test-host measurement, not a testnet one; the live per-
/// transaction limits are 400,000,000 instructions and 41,943,040 bytes of memory.
#[test]
#[ignore = "needs the release WASM: cd contracts && stellar contract build && cargo test -p approval-registry --test circom -- --ignored --nocapture"]
fn wasm_submit_resources() {
    let f = fixture();
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.max_entry_ttl = 3_110_400;
        li.min_persistent_entry_ttl = 120_960;
        li.min_temp_entry_ttl = 720;
    });
    env.cost_estimate().budget().reset_unlimited();
    let domain = BytesN::from_array(&env, &DOMAIN);
    let verifier = env.register(wasm("groth16_verifier").as_slice(), ());
    let dkim = env.register(wasm("dkim_registry").as_slice(), (domain.clone(), BytesN::from_array(&env, &f.key_hash())));
    let registry = env.register(
        wasm("approval_registry").as_slice(),
        (verifier.clone(), dkim, f.vk(&env), String::from_str(&env, f.field("projectId")), domain),
    );
    let _consumer = env.register(wasm("consumer").as_slice(), (registry.clone(),));
    let w = World { env: env.clone(), verifier, client: ApprovalRegistryClient::new(&env, &registry) };
    assert_eq!(submit(&w, &f, artifact(&f), f.nullifier(), &f.proof(&env)), Ok(()));
    let r = env.cost_estimate().resources();
    println!("submit (WASM, circom proof, testnet TTLs): {r:#?}\nfee estimate (SDK mainnet fee snapshot): {:#?}", env.cost_estimate().fee());
    assert!(r.instructions < 400_000_000 && r.mem_bytes < 41_943_040);
}

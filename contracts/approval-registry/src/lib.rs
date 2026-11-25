//! Release-approval registry. Records that a DKIM-signed approval email (proven off-chain with the
//! release-approval circuit) approves `artifact_hash` for the fixed project, submitted by the wallet named in
//! the email. Spec: docs/template.md (public inputs).
//! Fixed at deployment, no admin: verifier, DKIM registry, verifying key, project id, domain hash.
#![no_std]

use soroban_sdk::{
    Address, BytesN, Env, String, Vec, contract, contractclient, contracterror, contractevent, contractimpl,
    contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
};

/// Same shape as the SDF `bn254_verifier`'s types (contract types are matched by field names).
#[derive(Clone)]
#[contracttype]
pub struct VerificationKey {
    pub alpha: Bn254G1Affine,
    pub beta: Bn254G2Affine,
    pub gamma: Bn254G2Affine,
    pub delta: Bn254G2Affine,
    pub ic: Vec<Bn254G1Affine>,
}

#[derive(Clone)]
#[contracttype]
pub struct Proof {
    pub a: Bn254G1Affine,
    pub b: Bn254G2Affine,
    pub c: Bn254G1Affine,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Groth16Error {
    MalformedVerifyingKey = 0,
}

#[contractclient(name = "VerifierClient")]
pub trait Verifier {
    fn verify_proof(env: Env, verification_key: VerificationKey, proof: Proof, public_inputs: Vec<Bn254Fr>)
    -> Result<bool, Groth16Error>;
}

#[contractclient(name = "DkimRegistryClient")]
pub trait DkimRegistry {
    fn is_key_hash_valid(env: Env, domain_hash: BytesN<32>, public_key_hash: BytesN<32>) -> bool;
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Constructor: project id outside `[a-z0-9][a-z0-9-]{0,30}` or VK without 8 IC points.
    BadConfig = 1,
    /// Wallet is not a 56-character `G...` account strkey (e.g. a contract address).
    BadWallet = 2,
    WrongProject = 3,
    /// DKIM key hash or nullifier is not below the BN254 scalar field order r.
    NonCanonical = 4,
    UnknownKey = 5,
    NullifierUsed = 6,
    AlreadyApproved = 7,
    /// The verifier returned false.
    InvalidProof = 8,
    /// The verifier call failed (malformed point, malformed key).
    MalformedProof = 9,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub verifier: Address,
    pub dkim_registry: Address,
    pub project_id: String,
    pub domain_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Approval {
    pub wallet: Address,
    pub nullifier: BytesN<32>,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Vk,
    Nullifier(BytesN<32>),
    /// The project is fixed, so the artifact hash alone keys an approval.
    Approval(BytesN<32>),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Approved {
    #[topic]
    pub project_id: String,
    #[topic]
    pub artifact_hash: BytesN<32>,
    pub wallet: Address,
    pub nullifier: BytesN<32>,
}

/// BN254 scalar field order r, big-endian.
const R: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d, 0x28, 0x33, 0xe8,
    0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];
const DAY_IN_LEDGERS: u32 = 17280;

/// `[0x00] ‖ bytes ‖ zero padding` as a field element (docs/template.md, ASCII packing).
fn pack31(env: &Env, bytes: &[u8]) -> Bn254Fr {
    let mut b = [0u8; 32];
    b[1..1 + bytes.len()].copy_from_slice(bytes);
    Bn254Fr::from_bytes(BytesN::from_array(env, &b))
}

/// 16 bytes as a big-endian 128-bit limb.
fn limb128(env: &Env, half: &[u8]) -> Bn254Fr {
    let mut b = [0u8; 32];
    b[16..].copy_from_slice(half);
    Bn254Fr::from_bytes(BytesN::from_array(env, &b))
}

fn valid_project(p: &String) -> bool {
    let n = p.len() as usize;
    if n == 0 || n > 31 {
        return false;
    }
    let mut b = [0u8; 31];
    p.copy_into_slice(&mut b[..n]);
    b[0] != b'-' && b[..n].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

#[contract]
pub struct ApprovalRegistry;

#[contractimpl]
impl ApprovalRegistry {
    pub fn __constructor(
        env: Env,
        verifier: Address,
        dkim_registry: Address,
        vk: VerificationKey,
        project_id: String,
        domain_hash: BytesN<32>,
    ) -> Result<(), Error> {
        if !valid_project(&project_id) || vk.ic.len() != 8 {
            return Err(Error::BadConfig);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Config, &Config { verifier, dkim_registry, project_id, domain_hash });
        s.set(&DataKey::Vk, &vk);
        let max = env.storage().max_ttl();
        s.extend_ttl(max, max);
        Ok(())
    }

    /// Every check runs before any write; an `Err` return rolls back the whole call, TTL bumps included.
    pub fn submit(
        env: Env,
        wallet: Address,
        project_id: String,
        artifact_hash: BytesN<32>,
        dkim_key_hash: BytesN<32>,
        nullifier: BytesN<32>,
        proof: Proof,
    ) -> Result<(), Error> {
        let strkey = wallet.to_string();
        if strkey.len() != 56 {
            return Err(Error::BadWallet);
        }
        let mut w = [0u8; 56];
        strkey.copy_into_slice(&mut w);
        if w[0] != b'G' {
            return Err(Error::BadWallet);
        }
        wallet.require_auth();

        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        if project_id != cfg.project_id {
            return Err(Error::WrongProject);
        }
        // Checked on the bytes: Bn254Fr::from_bytes would silently reduce mod r, so `nullifier + r` would be a
        // fresh storage key for the same proof.
        if dkim_key_hash.to_array() >= R || nullifier.to_array() >= R {
            return Err(Error::NonCanonical);
        }
        if !DkimRegistryClient::new(&env, &cfg.dkim_registry).is_key_hash_valid(&cfg.domain_hash, &dkim_key_hash) {
            return Err(Error::UnknownKey);
        }
        let p = env.storage().persistent();
        let nkey = DataKey::Nullifier(nullifier.clone());
        let akey = DataKey::Approval(artifact_hash.clone());
        if p.has(&nkey) {
            return Err(Error::NullifierUsed);
        }
        if p.has(&akey) {
            return Err(Error::AlreadyApproved);
        }

        // Public inputs in docs/template.md order, from the authorized wallet and the fixed project.
        let mut proj = [0u8; 31];
        let n = cfg.project_id.len() as usize;
        cfg.project_id.copy_into_slice(&mut proj[..n]);
        let a = artifact_hash.to_array();
        let mut inputs: Vec<Bn254Fr> = Vec::new(&env);
        inputs.push_back(pack31(&env, &w[..31]));
        inputs.push_back(pack31(&env, &w[31..]));
        inputs.push_back(pack31(&env, &proj[..n]));
        inputs.push_back(limb128(&env, &a[..16]));
        inputs.push_back(limb128(&env, &a[16..]));
        inputs.push_back(Bn254Fr::from_bytes(dkim_key_hash));
        inputs.push_back(Bn254Fr::from_bytes(nullifier.clone()));

        let vk: VerificationKey = env.storage().instance().get(&DataKey::Vk).unwrap();
        match VerifierClient::new(&env, &cfg.verifier).try_verify_proof(&vk, &proof, &inputs) {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => return Err(Error::InvalidProof),
            _ => return Err(Error::MalformedProof),
        }

        let max = env.storage().max_ttl();
        p.set(&nkey, &());
        p.extend_ttl(&nkey, max, max);
        p.set(&akey, &Approval { wallet: wallet.clone(), nullifier: nullifier.clone(), ledger: env.ledger().sequence() });
        p.extend_ttl(&akey, max, max);
        env.storage().instance().extend_ttl(max.saturating_sub(DAY_IN_LEDGERS), max);
        Approved { project_id, artifact_hash, wallet, nullifier }.publish(&env);
        Ok(())
    }

    pub fn is_approved(env: Env, project_id: String, artifact_hash: BytesN<32>) -> bool {
        let cfg: Config = env.storage().instance().get(&DataKey::Config).unwrap();
        project_id == cfg.project_id && env.storage().persistent().has(&DataKey::Approval(artifact_hash))
    }
}

//! Fixed-key DKIM registry. The (domain hash, key hash) pair is written once, in the constructor, with
//! OpenZeppelin's `stellar-zk-email` v0.8.0 storage helpers. The contract does not implement OZ's
//! `DKIMRegistry` trait: its set/revoke methods return `()` and cannot refuse cleanly, and the SOW allows
//! no key update or revoke. So only the two reads are exported; a fix needs a new deployment.
#![no_std]

use soroban_sdk::{BytesN, Env, contract, contractimpl};
use stellar_zk_email::dkim_registry::{self, DKIMKeyEntry, DKIMRegistryStorageKey};

#[contract]
pub struct DkimRegistry;

#[contractimpl]
impl DkimRegistry {
    pub fn __constructor(e: &Env, domain_hash: BytesN<32>, public_key_hash: BytesN<32>) {
        dkim_registry::set_dkim_public_key_hash(e, &domain_hash, &public_key_hash);
        // OZ writes the entry with the minimum TTL and bumps it only on reads; start it at the maximum.
        let key = DKIMRegistryStorageKey::DomainPublicKey(DKIMKeyEntry { domain_hash, public_key_hash });
        let max = e.storage().max_ttl();
        e.storage().persistent().extend_ttl(&key, max, max);
        e.storage().instance().extend_ttl(max, max);
    }

    pub fn is_key_hash_valid(e: &Env, domain_hash: BytesN<32>, public_key_hash: BytesN<32>) -> bool {
        dkim_registry::is_key_hash_valid(e, &domain_hash, &public_key_hash)
    }

    pub fn is_key_hash_revoked(e: &Env, public_key_hash: BytesN<32>) -> bool {
        dkim_registry::is_key_hash_revoked(e, &public_key_hash)
    }
}

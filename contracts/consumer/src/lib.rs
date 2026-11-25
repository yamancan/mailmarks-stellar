//! Minimal consumer: another contract that trusts a release only if the approval registry recorded it.
#![no_std]

use soroban_sdk::{Address, BytesN, Env, String, contract, contractclient, contractimpl, symbol_short};

#[contractclient(name = "ApprovalRegistryClient")]
pub trait ApprovalRegistry {
    fn is_approved(env: Env, project_id: String, artifact_hash: BytesN<32>) -> bool;
}

#[contract]
pub struct Consumer;

#[contractimpl]
impl Consumer {
    pub fn __constructor(env: Env, registry: Address) {
        env.storage().instance().set(&symbol_short!("registry"), &registry);
    }

    pub fn release_allowed(env: Env, project_id: String, artifact_hash: BytesN<32>) -> bool {
        let registry: Address = env.storage().instance().get(&symbol_short!("registry")).unwrap();
        ApprovalRegistryClient::new(&env, &registry).is_approved(&project_id, &artifact_hash)
    }
}

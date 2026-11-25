//! The page's encoding against the real contract. web/scripts/contract-fixture.ts writes the `submit`
//! arguments and the approval key exactly as the page builds them (web/src/chain.ts), as XDR; this test decodes
//! them and calls the registry. An encoding mistake in the page (argument order, the proof map, G2 c1‖c0, the
//! storage key) fails here instead of on testnet.
mod common;

use approval_registry::{Approval, DataKey, Error, Proof};
use ark_bn254::{G1Affine, G2Affine};
use ark_ec::AffineRepr;
use common::*;
use soroban_sdk::{
    Address, BytesN, Env, IntoVal, InvokeError, String, Symbol, TryFromVal, Val, Vec,
    xdr::{Limits, ReadXdr, ScVal},
};

struct PageCalls {
    args: Vec<Val>,
    key: Val,
}

fn page_calls(env: &Env) -> PageCalls {
    let j: serde_json::Value = serde_json::from_str(include_str!("fixtures/page-calls.json")).unwrap();
    let val = |field: &str| {
        let sc = ScVal::from_xdr_base64(j[field].as_str().unwrap(), Limits::none()).unwrap();
        Val::try_from_val(env, &sc).unwrap()
    };
    PageCalls { args: Vec::try_from_val(env, &val("submitArgs")).unwrap(), key: val("approvalKey") }
}

fn invoke(w: &World, args: Vec<Val>) -> Result<(), Result<Error, InvokeError>> {
    match w.env.try_invoke_contract::<(), Error>(&w.registry, &Symbol::new(&w.env, "submit"), args) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(c)) => panic!("conversion error {c:?}"),
        Err(e) => Err(e),
    }
}

#[test]
fn page_submit_arguments_decode_as_the_contract_expects() {
    let mut prover = Prover::new();
    let v = &vectors()[0];
    let w = world(&prover, v.project, true);
    let e = &w.env;
    let page = page_calls(e);
    assert_eq!(page.args.len(), 6);

    // Each argument converts to the contract's parameter type and carries the sample's values.
    let arg = |i: u32| page.args.get(i).unwrap();
    assert_eq!(Address::try_from_val(e, &arg(0)).unwrap(), Address::from_str(e, v.wallet));
    assert_eq!(String::try_from_val(e, &arg(1)).unwrap(), String::from_str(e, v.project));
    assert_eq!(BytesN::<32>::try_from_val(e, &arg(2)).unwrap(), BytesN::from_array(e, &v.artifact));
    assert_eq!(BytesN::<32>::try_from_val(e, &arg(3)).unwrap(), BytesN::from_array(e, &fixed(KEY)));
    assert_eq!(BytesN::<32>::try_from_val(e, &arg(4)).unwrap(), BytesN::from_array(e, &fixed(0x21)));
    // The sample proof is (G1, G2, −G1) generators: this pins X‖Y and the c1‖c0 order of each G2 coordinate.
    let p = Proof::try_from_val(e, &arg(5)).unwrap();
    assert_eq!(p.a, g1(e, &G1Affine::generator()));
    assert_eq!(p.b, g2(e, &G2Affine::generator()));
    assert_eq!(p.c, g1(e, &-G1Affine::generator()));

    // As sent by the page: every check before the pairing passes; the sample is not a real proof.
    assert_eq!(invoke(&w, page.args.clone()), Err(Ok(Error::InvalidProof)));

    // The same arguments with a real proof of those public inputs are accepted.
    let ark = prover.prove(inputs(v, fixed(KEY), fixed(0x21)));
    let mut args = page.args.clone();
    args.set(5, proof(e, &ark).into_val(e));
    assert_eq!(invoke(&w, args), Ok(()));
    assert!(w.client.is_approved(&String::from_str(e, v.project), &BytesN::from_array(e, &v.artifact)));
}

#[test]
fn page_approval_key_is_the_stored_key() {
    let mut prover = Prover::new();
    let v = &vectors()[0];
    let w = world(&prover, v.project, true);
    let e = &w.env;
    let page = page_calls(e);
    let artifact = BytesN::from_array(e, &v.artifact);
    let want: Val = DataKey::Approval(artifact).into_val(e);
    // Compared as XDR: the two Vals are different host objects.
    assert_eq!(ScVal::try_from_val(e, &page.key).unwrap(), ScVal::try_from_val(e, &want).unwrap());

    let ark = prover.prove(inputs(v, fixed(KEY), fixed(0x21)));
    let mut args = page.args.clone();
    args.set(5, proof(e, &ark).into_val(e));
    assert_eq!(invoke(&w, args), Ok(()));
    // The record the page reads through getLedgerEntries is under exactly this key.
    let rec: Approval = e.as_contract(&w.registry, || e.storage().persistent().get(&page.key)).expect("approval stored under the page's key");
    assert_eq!(rec.wallet, Address::from_str(e, v.wallet));
    assert_eq!(rec.nullifier, BytesN::from_array(e, &fixed(0x21)));
}

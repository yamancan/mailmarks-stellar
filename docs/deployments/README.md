# Testnet deployment, 20 Nov 2026 (UTC)

Deployed with the owner's approval, 20 Nov 2026 (UTC). Testnet only.

```sh
bash scripts/deploy-testnet.sh mailmarks
```

- **When:** 20 Nov 2026, 23:50 UTC (`2026-11-20T23:50:54Z` in `testnet.json`); 42 s in all; it ran once.
- **From:** the Mac, stellar-cli 30.0.1, with `contracts/deploy/delivery.json` as in this repository.
- **Deployer:** the owner's funded testnet account `GAUDWHLQ4JXEM6UZUMIBWSPKXHU4F5J6MBEMIHT4NZBDV4FOXBPYFNAG`
  (stellar identity `mailmarks`).
- **Full output:** [testnet-deploy.log](testnet-deploy.log), as printed, with the home folder written `~`.
- **For the page:** [testnet.json](testnet.json), written by the script.

| Contract | Address | WASM and its hash | Transactions |
|---|---|---|---|
| Groth16 verifier (SDF copy) | [`CBC3HTYPJLUZWZT5IYBO5P46ETMSL6GJ2D6C3U2PT5QEGPM2EBSAMBKZ`](https://stellar.expert/explorer/testnet/contract/CBC3HTYPJLUZWZT5IYBO5P46ETMSL6GJ2D6C3U2PT5QEGPM2EBSAMBKZ) | `groth16_verifier.wasm` `df541da68d667e57bcc235ffa6ea30ab800b24d32b92c5cf87781eb85084d87a` | [upload](https://stellar.expert/explorer/testnet/tx/2cd52cce4349bd613f848896958e3e94b9ce6493a42b5a4d0b10976409815d1d) `2cd52cce4349bd613f848896958e3e94b9ce6493a42b5a4d0b10976409815d1d`<br>[deploy](https://stellar.expert/explorer/testnet/tx/3a8984a5790b5d764aa74f0bd5c5f15dc193adcd8757fdaf4b7603bd43757639) `3a8984a5790b5d764aa74f0bd5c5f15dc193adcd8757fdaf4b7603bd43757639` |
| DKIM registry | [`CC4DAKFW53B7W6YFHPIEMHKEC7KLTUAA3BXIDG6PGZLYUPGBBZ7IEIMB`](https://stellar.expert/explorer/testnet/contract/CC4DAKFW53B7W6YFHPIEMHKEC7KLTUAA3BXIDG6PGZLYUPGBBZ7IEIMB) | `dkim_registry.wasm` `53c56bba17b7c1487ef74cb29e8db5643490e3e73dbe08fb875b24c92732c565` | [upload](https://stellar.expert/explorer/testnet/tx/5e105cfb7bb10628bbe1c9cfb901bc0bfbb33fd31f94826c2d70ec87e9b82958) `5e105cfb7bb10628bbe1c9cfb901bc0bfbb33fd31f94826c2d70ec87e9b82958`<br>[deploy](https://stellar.expert/explorer/testnet/tx/fc26acadc2cfc840a6b0a0c9487009432da726fd12d2094309baf12f9354dd48) `fc26acadc2cfc840a6b0a0c9487009432da726fd12d2094309baf12f9354dd48` |
| Approval registry | [`CDR4M7C37IVMBLUWUFQ4J5HCZA5AXF2ZQAA34J43JL4SKEMB3IO3F6AG`](https://stellar.expert/explorer/testnet/contract/CDR4M7C37IVMBLUWUFQ4J5HCZA5AXF2ZQAA34J43JL4SKEMB3IO3F6AG) | `approval_registry.wasm` `2694d478417ef4142af8a644121a0c484876b2773298c55a5eb79cff1cdc9058` | [upload](https://stellar.expert/explorer/testnet/tx/1d8bb66b8f18b3606ae83523208d725a6f7744d1b68ecb5a6d630d594e4dc260) `1d8bb66b8f18b3606ae83523208d725a6f7744d1b68ecb5a6d630d594e4dc260`<br>[deploy](https://stellar.expert/explorer/testnet/tx/d962296a9423ce7e3d504a9f53807b7251debc6ec1503bcc77f5b4b4addc3841) `d962296a9423ce7e3d504a9f53807b7251debc6ec1503bcc77f5b4b4addc3841` |
| Consumer | [`CATTC25PAVDGVVLGOPER7TU54AGFRXTR3S6KFUECRUSV2X2DX4ENAXS7`](https://stellar.expert/explorer/testnet/contract/CATTC25PAVDGVVLGOPER7TU54AGFRXTR3S6KFUECRUSV2X2DX4ENAXS7) | `consumer.wasm` `c8a638b204398a9acf61ea7dd6ca785f1e50899356c8b15d6abd002e2f87210a` | [upload](https://stellar.expert/explorer/testnet/tx/9d809c7344d6a1a174d9f2455abb560c4bd9b259e72bb29064ad268214725b8a) `9d809c7344d6a1a174d9f2455abb560c4bd9b259e72bb29064ad268214725b8a`<br>[deploy](https://stellar.expert/explorer/testnet/tx/8d7689e8ea23192c6c3a9e4efbe4b8b928196ff16be784a313a63a64e191aff7) `8d7689e8ea23192c6c3a9e4efbe4b8b928196ff16be784a313a63a64e191aff7` |

Constructor values: `contracts/deploy/delivery.json` (docs/deploy.md). The DKIM registry holds
`domain_hash` `e2e91458b4eda6d476572c352138bb070995a05f58dccfc42928132c28e217d1` (SHA-256 of `trionlabs.dev`) and `public_key_hash`
`1de2284690a9aaf9c7a0448960e4a03d238e038e7b8c83fea7d21cf157de58dd` (docs/dkim-key.md). The approval registry holds the delivery verifying key (docs/setup.md, "The
delivery key"), project `mailmarks` and the verifier and DKIM registry above.

## Checked after the deployment (read-only)

Simulated calls (`stellar contract invoke --send=no`), nothing sent:

| Call | Result |
|---|---|
| DKIM registry `is_key_hash_valid(domain_hash, public_key_hash)` | `true` |
| Approval registry `is_approved("mailmarks", bd043655…02a41ac)` (the reference artifact) | `false` |
| Consumer `release_allowed("mailmarks", bd043655…02a41ac)` | `false` |

The approval registry's instance storage (`stellar ledger entry fetch contract-data --instance`) holds the same
verifying key (alpha, beta, gamma, delta and the 8 IC points), domain hash and project as
`contracts/deploy/delivery.json`, and the verifier and DKIM registry addresses above.

# The delivery DKIM key: google._domainkey.trionlabs.dev

Pinned on 20 Nov 2026 (UTC) in `prover/keys/trionlabs.dev-google.json`. The prover reads it from there and never asks DNS
(docs/prover.md). The DKIM registry is deployed with its key hash (docs/deploy.md).

## How it was read

```sh
dig +short TXT google._domainkey.trionlabs.dev @8.8.8.8
dig +short TXT google._domainkey.trionlabs.dev @1.1.1.1
```

Run on the Mac on 20 Nov 2026, 23:25 UTC. Both resolvers gave the same answer, as two TXT strings (255 and 155
characters). DNS joins them without a separator, and the record keeps them joined:

```
v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6JERKGbp74LcfQK9aVNckuFY2iufIOG/DUa4PNHuZTf1VfB/tikDd42u9En68Ut+gIeN62zkpZgqZJBgUaU6RvCCvIfA4rF+Ym7RDzMYprIj8w2pWnIawLgaEcn8lfOJskCW9xQj8hHLlgUkttku0z/zeYzUV8TdjHUmMAohj6a3Mo57y5v5MQxMVv+VW6zfwo+1jTA/BosHShf5ZPKITTmBBQ96drCuQusJlcmMfdRzioVlUBg6iNZojGpBVu/ngFKrRKowSU7EXQNmgxGnYmw3j+RTPLiTkMpfKuo7AQDmrE6R48Lz1rFIcsvSnmwS82VnpzWBuSXkIx+jLCTW+QIDAQAB
```

## What the key is

| | |
|---|---|
| Algorithm | RSA, `k=rsa` |
| Modulus | 2048 bits, `e891112866e9ef82…e4231fa32c24d6f9` |
| SHA-256 of the modulus (256 bytes, big-endian) | `5e15c3190045f520f20f2a4aff55b2ee4205e000a0782607882051f45441fe46` |
| Exponent | 65537 |
| Key hash (public signal 5, `PoseidonLarge(121, 17)` of the modulus) | `13516658017839545759588237277145507208514199385895349779924259460902339631325` |
| Key hash, 32 bytes hex (DKIM registry `public_key_hash`) | `1de2284690a9aaf9c7a0448960e4a03d238e038e7b8c83fea7d21cf157de58dd` |
| Domain hash, SHA-256 of `trionlabs.dev` (DKIM registry `domain_hash`) | `e2e91458b4eda6d476572c352138bb070995a05f58dccfc42928132c28e217d1` |

`loadKeys()` refuses the record unless the key is RSA-2048 with exponent 65537 and its stored `modulusBits`,
`exponent` and `keyHash` match the key. `circuits/test/poseidon.test.js` checks that the circuit's own
`PoseidonLarge(121, 17)`, the hash `EmailVerifier` outputs as `pubkeyHash`, gives the same key hash for this
modulus.

## Google Workspace custom DKIM, `d=trionlabs.dev`

The key is the Google Workspace custom DKIM key of trionlabs.dev: selector `google` under the domain itself. Mail
signed with it carries `d=trionlabs.dev; s=google`. Workspace's default signature, used when custom DKIM is off,
has `d=` under `gappssmtp.com` instead. The prover only uses a signature whose `d=` is the sender's
domain and whose key is pinned here (docs/template.md).

**Why this matters for the circuit:** it does not read `d=` (docs/circuit.md, rule 1). The domain is bound by the
registry's key hash and by the sender constant `mintmarks@trionlabs.dev`, so the key hash must belong to a key that
signs for trionlabs.dev only. What was checked on 20 Nov (UTC):
- the key is published under `google._domainkey.trionlabs.dev`, and the domain's mail is Google's (MX
  `aspmx.l.google.com` and the `alt1`–`alt4` hosts, SPF `include:_spf.google.com`);
- `20230601._domainkey.trionlabs-dev.20230601.gappssmtp.com`, the name of a default Workspace key for this domain,
  answered `v=DKIM1; k=rsa; p=`, an empty key.

DNS cannot show that no other domain publishes the same key. Workspace makes the custom key for the domain in its
admin console, and the provider is a trusted party (docs/template.md, trust model).

## When the key changes

A new key, or a rotation in the admin console, gives a new TXT record and a new key hash. Then: read it again with the
commands above and add a new dated record next to this one. List the new record in `.dockerignore` before building the
delivery image. The DKIM registry holds one fixed key and has no way to
add another, so a new DKIM registry is deployed with the new key hash, then a new approval registry pointing at it,
and a new `docs/deployments/testnet.json` (docs/deploy.md). The
circuit and its proving key do not change.

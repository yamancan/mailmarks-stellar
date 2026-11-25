# Pinned DKIM key records

The prover never looks a DKIM key up online. It reads the keys from this folder: one JSON file per key, named
`<domain>-<selector>.json`, written once from the DNS TXT record and dated (docs/prover.md).

| Field | Meaning |
|---|---|
| `domain`, `selector` | the signing domain (`d=`) and selector (`s=`) |
| `dnsName` | `<selector>._domainkey.<domain>` |
| `txt` | the TXT record text as served by DNS, `v=DKIM1; k=rsa; p=...` |
| `fetched` | the date the record was read (YYYY-MM-DD) |
| `source` | how it was read (command and resolver) |
| `modulusBits`, `exponent` | 2048 and 65537; the prover refuses any other key |
| `keyHash` | the zk-email key hash (public signal 5), the value the DKIM registry is deployed with |

`keyRecord()` in `prover/src/prove.js` derives every field but `fetched` and `source` from the TXT text. The
delivery key is `trionlabs.dev-google.json` (`google._domainkey.trionlabs.dev`, read on 21 Nov 2026:
docs/dkim-key.md).

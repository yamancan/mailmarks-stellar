# Testnet evidence

Written by `web/scripts/evidence.ts`. Each folder holds the RPC `getTransaction` answer (envelope, result and meta XDR),
the Horizon record, a Stellar Expert screenshot and `case.json` (arguments, expected and on-chain registry error, state
before and after). The links stop working when testnet is reset; the files stay.

| Contract | Id |
|---|---|
| registry | `CDR4M7C37IVMBLUWUFQ4J5HCZA5AXF2ZQAA34J43JL4SKEMB3IO3F6AG` |
| verifier | `CBC3HTYPJLUZWZT5IYBO5P46ETMSL6GJ2D6C3U2PT5QEGPM2EBSAMBKZ` |
| dkimRegistry | `CC4DAKFW53B7W6YFHPIEMHKEC7KLTUAA3BXIDG6PGZLYUPGBBZ7IEIMB` |
| consumer | `CATTC25PAVDGVVLGOPER7TU54AGFRXTR3S6KFUECRUSV2X2DX4ENAXS7` |

| Case | Registry result | Transaction | Link | Records |
|---|---|---|---|---|
| Wrong project (WrongProject, #3) | #3 | `aa40b61db22e8251bcf84db9e53c972e247cb1b9e5a91b1572382de8df631d80` | [Stellar Expert](https://stellar.expert/explorer/testnet/tx/aa40b61db22e8251bcf84db9e53c972e247cb1b9e5a91b1572382de8df631d80) | [wrong-project/](wrong-project/) |
| Unregistered DKIM key (UnknownKey, #5) | #5 | `19a5b4c7f6b280fc29cdf75dd91496ee90faf730a16acf3bd4567eef96c74324` | [Stellar Expert](https://stellar.expert/explorer/testnet/tx/19a5b4c7f6b280fc29cdf75dd91496ee90faf730a16acf3bd4567eef96c74324) | [unregistered-key/](unregistered-key/) |
| Wrong artifact (InvalidProof, #8) | #8 | `2c13735ea52676ad9f001b5a03b4b5f208341ed251ca257b2741f823d4e86abe` | [Stellar Expert](https://stellar.expert/explorer/testnet/tx/2c13735ea52676ad9f001b5a03b4b5f208341ed251ca257b2741f823d4e86abe) | [wrong-artifact/](wrong-artifact/) |
| Tampered proof (InvalidProof, #8) | #8 | `4df715db8043b6a2d855828ba33709e52013a18343265ab1471d2333e9a115ac` | [Stellar Expert](https://stellar.expert/explorer/testnet/tx/4df715db8043b6a2d855828ba33709e52013a18343265ab1471d2333e9a115ac) | [tampered-proof/](tampered-proof/) |
| Valid approval | success | `179c5f492ad67c5ba541d56eb3826b467564517b1fc304ddc37bc45eb86f22a2` | [Stellar Expert](https://stellar.expert/explorer/testnet/tx/179c5f492ad67c5ba541d56eb3826b467564517b1fc304ddc37bc45eb86f22a2) | [valid/](valid/) |
| Replay of the same email (NullifierUsed, #6) | #6 | `5d2d010091b94d26b03317ec8311b8b2bdd0215dd096a15d14ffa602c08847be` | [Stellar Expert](https://stellar.expert/explorer/testnet/tx/5d2d010091b94d26b03317ec8311b8b2bdd0215dd096a15d14ffa602c08847be) | [replay/](replay/) |

# Engine v3 proof verifier

A standalone checker for `smartprofit-proof/v3` packages (ADR 0001 and ADR 0002). It uses only the Web Crypto API and has no dependencies. It works in Node 19+ and modern browsers, and shares no code with the generator in `engine/v3`. The fairness page runs this same module with the same trust documents, so both give the same verdict for the same package.

```
node verifier/v3/cli.mjs proof.json            # summary
node verifier/v3/cli.mjs proof.json --json     # full result
node verifier/v3/cli.mjs proof.json --trust-dir DIR --allow-test-trust   # test/staging packages only; output is labelled TEST TRUST BUNDLE
```

By default the CLI loads the **published** trust documents beside it:

- `trusted-keys.json`: SmartProfit's Ed25519 signing keys. Append-only. An empty manifest means "unpinned".
- `tsa-roots.json`: the pinned DigiCert and Sectigo RFC 3161 roots, and which providers are required.

| Exit code | Verdict |
| --- | --- |
| 0 | **fully verified** |
| 2 | **partial**: nothing contradicts the record, but evidence is incomplete |
| 1 | **invalid**: something is wrong |
| 64 | usage error |

## Verdict components

| Component | Values | What it means |
| --- | --- | --- |
| price/continuity | `verified`, `unanchored`, `invalid` | Every tick is recomputed under its own epoch's configuration from the revealed seed. Sequence, previous price, the hash chain and the commitment chain are checked. The start must be genesis or a signed, witnessed checkpoint. |
| signatures | `valid`, `unpinned`, `unsigned`, `invalid` | Ed25519 signatures on commitments and checkpoints, checked against the pinned key manifest. |
| witness | `witnessed`, `late`, `missing`, `unwitnessed`, `invalid` | Each epoch holding ticks needs a valid receipt from every required TSA. The receipt must chain to a pinned root, and its `genTime` must fall strictly before the epoch's **witness deadline**: its first scheduled tradable tick, derived from the committed configuration. |
| checkpoints | `witnessed`, `none`, `unwitnessed`, `invalid` | Checkpoints in the range and the anchor checkpoint are signed and carry verified receipts. |
| reveal | `revealed`, `not_yet_revealable` | Every epoch holding ticks has a revealed seed that matches its commitment. |
| contracts | `verified`, `none`, `unverifiable`, `invalid` | Each settled contract's result and exit digit follow from its fixed exit tick. Refunded contracts are listed as refunded. |

**Fully verified** means every applicable component passed: the start is anchored, keys are pinned, receipts are on time, and every due seed is revealed and reproduced. A matching price with missing independent evidence is **partial**, never verified.

## What it does not establish

A valid proof shows that the published history follows from committed seeds and configurations, and that the commitments existed before the deadlines the timestamps attest. It does not show that nobody with control of both the engine worker and its key permissions previewed the current day. It does not show how a seed was chosen before commitment, and it does not check certificate revocation.

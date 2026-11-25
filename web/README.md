# Submission page

Static page that records a release approval on Stellar testnet from the prover's `approval-proof.json`, and checks
whether a release is approved. No backend; the email never reaches it. Spec: `docs/approval-proof.md`.

```sh
npm ci --ignore-scripts --prefix web
npm run preview --prefix web # builds web/dist, serves http://localhost:4173
```

The build copies `docs/deployments/testnet.json` to `dist/deployment.json` when it exists; without it the page says
that no testnet deployment is configured yet. Its fields: `rpcUrl`, `networkPassphrase` (testnet only), `registry`,
`projectId`, `expert` (Stellar Expert base URL) and `senderDomain`, the approver's email domain shown as "Approved
by" in the status view (`docs/fixtures/deployment.sample.json` is an example).

Tests: `npm test --prefix web` (unit), `npm run e2e --prefix web` (Playwright 1.62.1 with its Chromium, a fake RPC and a
fake wallet; any request outside the page, the RPC and Friendbot fails the test).

Origins the page talks to, and nothing else: the page itself, the RPC in `deployment.json`
(`https://soroban-testnet.stellar.org`), Friendbot (`https://friendbot.stellar.org`, only after the user's click on
"Fund it"), and the popups of two wallets, opened only from a click: Albedo (`https://albedo.link`, from
`@albedo-link/intent`) and xBull without its extension (`https://wallet.xbull.app`, from
`@creit.tech/xbull-wallet-connect` 0.4.0). Varial, Hana, Rabet and xBull's extension talk to the page through the
extension, not a network origin. Stellar Expert (`https://stellar.expert`) is only a link the user may open.

Signing waits for the user's Approve click after the dry run, and nothing is awaited between that click and the
wallet's `signTransaction`, so the Albedo and xBull popups are not blocked.

Look: dark first, light by the system setting; Geist and
Geist Mono come from `@fontsource-variable` inside the bundle and the wallet icons from `src/wallets/`, so no font or
icon host is contacted. The card is drawn from the release's SHA-256 (`src/card.ts`). The intro runs on the first visit
only (remembered in `localStorage` as `mm.intro`). Reduced motion turns every animation off.

The e2e suite also checks every page state and intro story in both themes at 1280 and 390 px with axe (WCAG 2.1 A/AA,
contrast included) and with no running animation under reduced motion, and checks the card's text contrast over 300
random hashes. Pictures of every state: `RENDER_DIR=/some/dir npm run e2e --prefix web -- states intro`.

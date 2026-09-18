# staci-tradingagents — recovered production source (x402 wall)

Source of the Fly app `staci-tradingagents` (thin @staci/kernel variant distinct
from tradingagents-x402). Recovered byte-exactly from the live image
`deployment-01M0XY95FVX0P3EQ3C234Q5MZC` via `fly ssh console` + tar on
2026-09-18 because no repo existed — the wall's whole history was image-only.

EXEC-22 additions (2026-09-18): `public-discovery.js` serving `/llms.txt`,
`/pricing.md`, and `/x402.json` (manifest alias), generated from the SAME
runtime constants (X402_PRICE/X402_PAY_TO/NETWORK) that build the live 402
challenge, so the published price can never drift from what a buyer is asked
to pay. Recovery deploy: `deployment-01M2T6S8WB5BCANF53B2XZFEEY`
(Dockerfile `FROM` the exact prior live image; only server.js +
public-discovery.js added; behavior otherwise identical; live challenge
pre/post: $0.25 eip155:84532 both, payTo now canonical treasury
0x7861db4efc14a1ed5dd8c96c528a3796560f1393 after the deploy shed the legacy
plain-env payTo override in favor of the app secret — charter R2 alignment).

Deploy: `flyctl deploy --remote-only` from this repo root (per-app deploy token;
see fly-secrets-deploy-tokens skill). Tests: `node discovery.check.js`
(dependency-free surface assertions).

# staci-tradingagents — full self-contained build (revenue engine).
#
# History: deployment-01M0XY95FVX0P3EQ3C234Q5MZC and the EXEC-22 surgical
# rebuild (deployment-01M2T6S8...) layered files onto a legacy base image
# whose node_modules lacked @coinbase/x402. Setting CDP_API_KEY_ID therefore
# crash-looped the app (MODULE_NOT_FOUND) and the wall stayed pinned to
# Base-Sepolia testnet (eip155:84532), collecting worthless funds.
#
# 2026-09-18 (engine recCuUaT7VvYLRlHg): replaced with a complete build from
# the repo's package.json + package-lock.json (npm ci, exact lock), adding
# @coinbase/x402@^2.1.0 and the python3 runtime analyze.py needs. Source of
# truth is github.com/bshelby88/staci-tradingagents; this image is now
# reproducible from the repo alone.

FROM node:22-bookworm-slim

# analyze.py runs under `python3` (see spawn in server.js). stdlib-only;
# no pip packages required (the tradingagents engine import fails gracefully
# into a labeled-simulated response without them).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# npm ci materializes the @staci/kernel symlink from the lockfile
# ("link": true), so kernel/ must be present before the install step.
COPY package.json package-lock.json ./
COPY kernel/ ./kernel/
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js public-discovery.js analyze.py ./

EXPOSE 3000

CMD ["node", "server.js"]

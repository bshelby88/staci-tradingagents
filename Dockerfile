FROM registry.fly.io/staci-tradingagents:deployment-01M0XY95FVX0P3EQ3C234Q5MZC

# EXEC-22: surgical addition to the exact live base image — copy the two
# discovery files plus the patched server.js. No dependency changes: the
# running node_modules and /app layout are preserved byte-for-byte.
WORKDIR /app
COPY server.js public-discovery.js ./

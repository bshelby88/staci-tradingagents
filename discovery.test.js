const assert = require('assert');
const express = require('express');
const net = require('net');
const path = require('path');

const { registerPublicDiscovery } = require('../public-discovery');

async function withServer(app, callback) {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  probe.close();
  const server = app.listen(port);
  await new Promise((resolve) => server.once('listening', resolve));
  try { await callback(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const serviceInfo = { name: 'tradingagents', description: 'Pay $0.25 USDC on Base, POST /api/analyze-ticker.' };
const routes = {
  'POST /api/analyze-ticker': {
    accepts: { scheme: 'exact', price: '$0.25', network: 'eip155:84532', payTo: '0x9b8a2786a3df7a7837ccfc4e792e9eb90a36f72f' },
    description: 'structured BUY/HOLD/SELL', mimeType: 'application/json',
  },
};

describe('staci-tradingagents EXEC-22 discovery surfaces', () => {
  it('serves llms.txt + pricing.md + x402.json alias from the live route constants', async () => {
    const app = express();
    registerPublicDiscovery(app, {
      routes, serviceInfo, network: 'eip155:84532',
      payTo: '0x9b8a2786a3df7a7837ccfc4e792e9eb90a36f72f',
      manifest: () => ({ version: '2.0.0', endpoints: Object.keys(routes) }),
    });
    await withServer(app, async (base) => {
      for (const route of ['/llms.txt', '/pricing.md']) {
        const res = await fetch(base + route);
        assert.strictEqual(res.status, 200);
        const body = await res.text();
        assert.ok(body.includes('$0.25'), route);
        assert.ok(body.includes('/api/analyze-ticker'), route);
        assert.ok(body.includes('eip155:84532'), route);
      }
      const alias = await fetch(base + '/x402.json');
      assert.strictEqual(alias.status, 200);
      assert.strictEqual((await alias.json()).version, '2.0.0');
    });
  });
});

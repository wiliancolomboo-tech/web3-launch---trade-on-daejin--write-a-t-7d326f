// healthcheck.js
const http = require('http');
const { Connection } = require('@solana/web3.js');

const rpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const connection = new Connection(rpc, 'confirmed');

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    try {
      const slot = await connection.getSlot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'UP', currentSlot: slot, timestamp: Date.now() }));
    } catch (e) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'DOWN', error: e.message }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(8080, () => console.log('Telemetry listening on port 8080'));
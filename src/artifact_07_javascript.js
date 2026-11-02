const http = require('http');
const PORT = process.env.PORT || 9100;

let totalSwaps = 0;
let lastHeartbeat = Date.now();

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), lastHeartbeat }));
  }

  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    const payload = [
      '# HELP daejin_market_trades_total Total executed on-chain swaps',
      '# TYPE daejin_market_trades_total counter',
      `daejin_market_trades_total ${totalSwaps}`,
      '# HELP daejin_daemon_health System operational status (1 = healthy, 0 = degraded)',
      '# TYPE daejin_daemon_health gauge',
      'daejin_daemon_health 1'
    ].join('\n');
    return res.end(payload);
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[Telemetry] Prometheus metrics server active at http://0.0.0.0:${PORT}/metrics`);
});
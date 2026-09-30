import http from 'http';
import { Connection, clusterApiUrl } from '@solana/web3.js';
import pino from 'pino';

const logger = pino({ transport: { target: 'pino-pretty' } });
const PORT = process.env.PORT || 8080;
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || clusterApiUrl('devnet');

const connection = new Connection(RPC_ENDPOINT, 'confirmed');

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz' && req.method === 'GET') {
    try {
      const slot = await connection.getSlot();
      const version = await connection.getVersion();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'HEALTHY',
        slot,
        solanaCore: version['solana-core'],
        timestamp: new Date().toISOString()
      }));
    } catch (err: any) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'UNHEALTHY', error: err.message }));
    }
    return;
  }

  if (req.url === '/metrics' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end([
      '# HELP daejin_daemon_status Status of the Daejin daemon (1 = active)',
      '# TYPE daejin_daemon_status gauge',
      'daejin_daemon_status 1',
      '# HELP daejin_active_markets Count of active markets tracked',
      '# TYPE daejin_active_markets gauge',
      'daejin_active_markets 1'
    ].join('\n'));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  logger.info(`Daejin Enterprise Daemon serving telemetry on port ${PORT}`);
});
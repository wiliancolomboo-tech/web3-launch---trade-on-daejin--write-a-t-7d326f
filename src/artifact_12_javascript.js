const http = require("http");
const port = 9090;

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "HEALTHY", uptime: process.uptime() }));
  } else if (req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(
      `daejin_orchestrator_uptime_seconds ${process.uptime()}\n` +
      `daejin_market_healthy 1\n`
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(port, () => {
  console.log(`[TELEMETRY] Healthcheck listening on :${port}`);
});
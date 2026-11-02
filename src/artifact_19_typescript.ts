import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now(), service: "daejin-agent" }));
  } else if (req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("# HELP daejin_active_markets Number of active binary markets\n# TYPE daejin_active_markets gauge\ndaejin_active_markets 1\n");
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(8080, () => {
  console.log("Telemetry & health check daemon listening on port 8080");
});
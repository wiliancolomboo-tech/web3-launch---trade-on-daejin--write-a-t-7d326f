const express = require("express");
const { Connection, PublicKey } = require("@solana/web3.js");

const app = express();
const PORT = process.env.PORT || 8080;
const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");

app.get("/healthz", async (req, res) => {
  try {
    const slot = await connection.getSlot();
    const version = await connection.getVersion();
    res.status(200).json({
      status: "HEALTHY",
      currentSlot: slot,
      solanaCore: version["solana-core"],
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: "DEGRADED",
      error: error.message,
    });
  }
});

app.get("/metrics", async (req, res) => {
  res.type("text/plain");
  res.send(`# HELP daejin_node_online Node status\n# TYPE daejin_node_online gauge\ndaejin_node_online 1\n`);
});

app.listen(PORT, () => {
  console.log(`[Daejin Telemetry] Running on port ${PORT}`);
});
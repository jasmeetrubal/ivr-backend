const express = require("express");
const cors = require("cors");
const https = require("https");
const querystring = require("querystring");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// In-memory call log
const callLog = [];

// ─── Exotel API Helper ─────────────────────────────────────────────────────────
// Exotel URL format: https://<API_KEY>:<API_TOKEN>@<SUBDOMAIN>/v1/Accounts/<SID>/...
function exotelCall(data) {
  const apiKey    = process.env.EXOTEL_API_KEY;
  const apiToken  = process.env.EXOTEL_API_TOKEN;
  const sid       = process.env.EXOTEL_SID;
  const subdomain = process.env.EXOTEL_SUBDOMAIN || "api.in.exotel.com";

  if (!apiKey || !apiToken || !sid) {
    throw new Error("Missing: EXOTEL_API_KEY, EXOTEL_API_TOKEN or EXOTEL_SID. Check Vercel env vars.");
  }

  const postData = querystring.stringify(data);
  const auth = Buffer.from(`${apiKey}:${apiToken}`).toString("base64");
  const path = `/v1/Accounts/${sid}/Calls/connect.json`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: subdomain,
      path,
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        console.log("Exotel response status:", res.statusCode);
        console.log("Exotel response body:", body);
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// ─── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const apiKey   = process.env.EXOTEL_API_KEY;
  const apiToken = process.env.EXOTEL_API_TOKEN;
  const sid      = process.env.EXOTEL_SID;
  const number   = process.env.EXOTEL_NUMBER;
  const agent1   = process.env.AGENT_1;

  res.json({
    status: "✅ IVR Backend Running",
    version: "3.0.0",
    provider: "Exotel",
    config: {
      EXOTEL_API_KEY:   apiKey   ? "✅ Set" : "❌ MISSING",
      EXOTEL_API_TOKEN: apiToken ? "✅ Set" : "❌ MISSING",
      EXOTEL_SID:       sid      ? "✅ Set" : "❌ MISSING",
      EXOTEL_NUMBER:    number   ? "✅ " + number : "❌ MISSING",
      AGENT_1:          agent1   ? "✅ " + agent1 : "❌ MISSING",
    },
    webhook_url: `${process.env.BASE_URL || "https://ivr-backend.vercel.app"}/exoml/inbound`,
  });
});

// ─── DEBUG: Test Exotel connection with real response ─────────────────────────
app.get("/api/debug", async (req, res) => {
  try {
    const apiKey    = process.env.EXOTEL_API_KEY;
    const apiToken  = process.env.EXOTEL_API_TOKEN;
    const sid       = process.env.EXOTEL_SID;
    const subdomain = process.env.EXOTEL_SUBDOMAIN || "api.exotel.com";
    const number    = process.env.EXOTEL_NUMBER;
    const agent     = process.env.AGENT_1;

    // Test call to Exotel — will show exact error or success
    const postData = require("querystring").stringify({
      From:     agent,
      To:       agent,   // calls itself just to test credentials
      CallerId: number,
      TimeOut:  10,
    });

    const auth = Buffer.from(`${apiKey}:${apiToken}`).toString("base64");

    const result = await new Promise((resolve) => {
      const req2 = require("https").request({
        hostname: subdomain,
        path: `/v1/Accounts/${sid}/Calls/connect.json`,
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
        },
      }, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve({ httpStatus: r.statusCode, body }));
      });
      req2.on("error", (e) => resolve({ httpStatus: 0, body: e.message }));
      req2.write(postData);
      req2.end();
    });

    res.json({
      debug: true,
      config: { apiKey: apiKey?.slice(0,8)+"...", sid, subdomain, number, agent },
      exotel_http_status: result.httpStatus,
      exotel_raw_response: result.body,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ─── OUTBOUND: Click "Call" in UI ─────────────────────────────────────────────
app.post("/api/call/outbound", async (req, res) => {
  try {
    const { to, customerName } = req.body;
    if (!to) return res.status(400).json({ error: "Missing 'to' phone number" });

    const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;

    const result = await exotelCall({
      From:             process.env.AGENT_1,          // Agent's phone — rings first
      To:               to,                            // Customer's phone — rings second
      CallerId:         process.env.EXOTEL_NUMBER,     // Your Exotel virtual number
      StatusCallback:   `${baseUrl}/api/call/status`,
      TimeLimit:        3600,
      TimeOut:          30,
    });

    if (result.status !== 200 && result.status !== 201) {
      return res.status(400).json({ error: "Exotel API error", details: result.data });
    }

    const sid = result.data?.Call?.Sid || Date.now().toString();
    callLog.unshift({ sid, type: "outbound", to, customerName: customerName || to, status: "initiated", startTime: new Date().toISOString() });

    res.json({ success: true, callSid: sid, status: "initiated" });
  } catch (err) {
    console.error("Outbound error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Status webhook from Exotel ───────────────────────────────────────────────
app.post("/api/call/status", (req, res) => {
  const { CallSid, Status } = req.body;
  const entry = callLog.find((c) => c.sid === CallSid);
  if (entry) entry.status = Status;
  res.sendStatus(200);
});

// ─── Hang up a call ────────────────────────────────────────────────────────────
app.post("/api/call/:sid/hangup", (req, res) => {
  const entry = callLog.find((c) => c.sid === req.params.sid);
  if (entry) entry.status = "completed";
  res.json({ success: true });
});

// ─── Call logs ─────────────────────────────────────────────────────────────────
app.get("/api/logs", (req, res) => {
  res.json({ logs: callLog.slice(0, 50) });
});

// ─── Agents ────────────────────────────────────────────────────────────────────
app.get("/api/agents", (req, res) => {
  res.json({ agents: [
    { id: 1, name: "Agent 1", phone: process.env.AGENT_1 || "", status: "available" },
    { id: 2, name: "Agent 2", phone: process.env.AGENT_2 || "", status: "available" },
  ]});
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ExoML — INBOUND IVR (set as Exotel Passthru URL)
// ═══════════════════════════════════════════════════════════════════════════════
app.all("/exoml/inbound", (req, res) => {
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
  callLog.unshift({ sid: req.body?.CallSid || Date.now().toString(), type: "inbound", from: req.body?.From || "unknown", status: "ivr", startTime: new Date().toISOString() });

  const greeting = process.env.IVR_GREETING || "Welcome! Thank you for calling. Press 1 for Sales. Press 2 for Technical Support. Press 3 for Order Status. Press 0 to speak with an agent.";

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="${baseUrl}/exoml/ivr-route" numDigits="1" timeout="10" method="POST">
    <Say>${greeting}</Say>
  </Gather>
  <Say>We did not receive your input. Goodbye.</Say>
</Response>`);
});

// ─── IVR Key Routing ──────────────────────────────────────────────────────────
app.all("/exoml/ivr-route", (req, res) => {
  const digit   = req.body?.digits || req.body?.Digits || req.query?.digits || "0";
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;

  const routes = {
    "1": { message: "Connecting you to our sales team. Please hold.",    agent: process.env.AGENT_SALES   || process.env.AGENT_1 },
    "2": { message: "Connecting you to technical support. Please hold.", agent: process.env.AGENT_SUPPORT || process.env.AGENT_2 || process.env.AGENT_1 },
    "3": { message: "Connecting you to our orders team. Please hold.",   agent: process.env.AGENT_3       || process.env.AGENT_1 },
    "0": { message: "Connecting you to an available agent. Please hold.", agent: process.env.AGENT_1 },
  };

  const route = routes[digit] || routes["0"];

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${route.message}</Say>
  <Dial callerId="${process.env.EXOTEL_NUMBER || ""}" timeLimit="3600" timeOut="30" action="${baseUrl}/exoml/no-answer">
    <Number>${route.agent || ""}</Number>
  </Dial>
</Response>`);
});

// ─── No answer fallback ────────────────────────────────────────────────────────
app.all("/exoml/no-answer", (req, res) => {
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, all agents are currently busy. Please call back soon. Thank you.</Say>
</Response>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 IVR Backend v3.0 running on port ${PORT}`));
module.exports = app;

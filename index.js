const express = require("express");
const cors = require("cors");
const https = require("https");
const querystring = require("querystring");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Exotel API Helper ─────────────────────────────────────────────────────────
function exotelRequest(path, data) {
  const sid = process.env.EXOTEL_SID;
  const token = process.env.EXOTEL_TOKEN;
  const subdomain = process.env.EXOTEL_SUBDOMAIN || "api.exotel.com";
  if (!sid || !token) throw new Error("EXOTEL_SID / EXOTEL_TOKEN not set");

  const postData = querystring.stringify(data);
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const fullPath = `/v1/Accounts/${sid}/${path}`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: subdomain,
      path: fullPath,
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// ─── In-memory call log (replace with DB in production) ───────────────────────
const callLog = [];

// ═══════════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/", (req, res) => {
  res.json({
    status: "✅ IVR Backend Running",
    version: "2.0.0",
    provider: "Exotel",
    endpoints: {
      outbound_call:  "POST /api/call/outbound",
      call_logs:      "GET  /api/logs",
      hang_up:        "POST /api/call/:sid/hangup",
      inbound_ivr:    "POST /exoml/inbound   ← set this in Exotel applet",
      ivr_route:      "POST /exoml/ivr-route",
      no_answer:      "POST /exoml/no-answer",
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  OUTBOUND — salesperson clicks "Call" in UI
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/call/outbound", async (req, res) => {
  try {
    const { to, customerName } = req.body;
    if (!to) return res.status(400).json({ error: "Missing 'to' phone number" });

    const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;

    // Exotel: First leg calls agent, second leg calls customer
    const result = await exotelRequest("Calls/connect.json", {
      From: process.env.AGENT_1,           // Agent phone (who picks up first)
      To: to,                               // Customer phone
      CallerId: process.env.EXOTEL_NUMBER,  // Your Exotel virtual number
      StatusCallback: `${baseUrl}/api/call/status`,
      TimeLimit: 3600,
      TimeOut: 30,
    });

    const sid = result?.Call?.Sid || result?.sid || Date.now().toString();
    callLog.unshift({
      sid,
      type: "outbound",
      to,
      customerName: customerName || to,
      status: "initiated",
      startTime: new Date().toISOString(),
    });

    res.json({ success: true, callSid: sid, status: "initiated", raw: result });
  } catch (err) {
    console.error("Outbound call error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Hang up / end a call ──────────────────────────────────────────────────────
app.post("/api/call/:sid/hangup", async (req, res) => {
  try {
    await exotelRequest(`Calls/${req.params.sid}.json`, { Status: "completed" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get single call status ────────────────────────────────────────────────────
app.get("/api/call/:sid", (req, res) => {
  const entry = callLog.find((c) => c.sid === req.params.sid);
  if (entry) return res.json(entry);
  res.status(404).json({ error: "Call not found in log" });
});

// ─── Status webhook (Twilio POSTs here on call events) ────────────────────────
app.post("/api/call/status", (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  const entry = callLog.find((c) => c.sid === CallSid);
  if (entry) {
    entry.status = CallStatus;
    if (CallDuration) entry.duration = CallDuration + "s";
  }
  res.sendStatus(200);
});

// ─── Get call logs ─────────────────────────────────────────────────────────────
app.get("/api/logs", (req, res) => {
  res.json({ logs: callLog.slice(0, 50) });
});

// ─── Get agents (stub — replace with DB) ──────────────────────────────────────
app.get("/api/agents", (req, res) => {
  res.json({
    agents: [
      { id: 1, name: "Rahul M.", status: "available", phone: process.env.AGENT_1 || "" },
      { id: 2, name: "Sneha K.", status: "available", phone: process.env.AGENT_2 || "" },
      { id: 3, name: "Arjun P.", status: "available", phone: process.env.AGENT_3 || "" },
    ],
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ExoML — INBOUND IVR (set this URL as your Exotel applet passthru URL)
// ═══════════════════════════════════════════════════════════════════════════════
app.all("/exoml/inbound", (req, res) => {
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
  const from = req.body?.From || req.query?.From || "unknown";

  callLog.unshift({
    sid: req.body?.CallSid || Date.now().toString(),
    type: "inbound",
    from,
    status: "ivr",
    startTime: new Date().toISOString(),
  });

  const greeting = process.env.IVR_GREETING ||
    "Welcome! Thank you for calling. Press 1 for Sales. Press 2 for Technical Support. Press 3 for Order Status. Press 0 to speak with an agent.";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="${baseUrl}/exoml/ivr-route" numDigits="1" timeout="10" method="POST">
    <Say>${greeting}</Say>
  </Gather>
  <Say>We did not receive your input. Please try again.</Say>
  <Redirect>${baseUrl}/exoml/inbound</Redirect>
</Response>`;
  res.type("text/xml").send(xml);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ExoML — IVR ROUTING (after customer presses a key)
// ═══════════════════════════════════════════════════════════════════════════════
app.all("/exoml/ivr-route", (req, res) => {
  const digit = req.body?.digits || req.query?.digits;
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;

  const routes = {
    "1": { intent: "Sales",   agent: process.env.AGENT_SALES   || process.env.AGENT_1, message: "Connecting you to our sales team. Please hold." },
    "2": { intent: "Support", agent: process.env.AGENT_SUPPORT || process.env.AGENT_2, message: "Connecting you to technical support. Please hold." },
    "3": { intent: "Orders",  agent: process.env.AGENT_3       || process.env.AGENT_1, message: "Connecting you to our orders team. Please hold." },
    "0": { intent: "Agent",   agent: process.env.AGENT_1,                               message: "Connecting to the next available agent. Please hold." },
  };

  const route = routes[digit];

  if (!route) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Invalid option selected. Please try again.</Say>
  <Redirect>${baseUrl}/exoml/inbound</Redirect>
</Response>`;
    return res.type("text/xml").send(xml);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${route.message}</Say>
  <Dial callerId="${process.env.EXOTEL_NUMBER}" timeLimit="3600" timeOut="30" action="${baseUrl}/exoml/no-answer">
    <Number>${route.agent || ""}</Number>
  </Dial>
</Response>`;
  res.type("text/xml").send(xml);
});

// ─── Fallback if agent doesn't answer ─────────────────────────────────────────
app.all("/exoml/no-answer", (req, res) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, our agent is unavailable right now. Please call back soon. Thank you.</Say>
</Response>`;
  res.type("text/xml").send(xml);
});

// ═══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 IVR Backend running on port ${PORT}`));
module.exports = app;

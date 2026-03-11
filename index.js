const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const callLog = [];

function getTwilio() {
  const twilio = require("twilio");
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  if (!sid || !token) throw new Error("TWILIO_SID / TWILIO_TOKEN not set");
  return twilio(sid, token);
}

app.get("/", (req, res) => {
  res.json({
    status: "✅ IVR Backend Running",
    version: "4.0.0 (Twilio mode)",
    config: {
      TWILIO_SID:    process.env.TWILIO_SID    ? "✅ Set" : "❌ MISSING",
      TWILIO_TOKEN:  process.env.TWILIO_TOKEN  ? "✅ Set" : "❌ MISSING",
      TWILIO_NUMBER: process.env.TWILIO_NUMBER ? "✅ " + process.env.TWILIO_NUMBER : "❌ MISSING",
      AGENT_1:       process.env.AGENT_1       ? "✅ " + process.env.AGENT_1 : "❌ MISSING",
    },
    note: "Switch to EXOTEL_* vars after KYC is approved",
  });
});

// OUTBOUND
app.post("/api/call/outbound", async (req, res) => {
  try {
    const { to, customerName } = req.body;
    if (!to) return res.status(400).json({ error: "Missing 'to' number" });
    const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
    const client = getTwilio();
    const call = await client.calls.create({
      to,
      from: process.env.TWILIO_NUMBER,
      url: `${baseUrl}/twiml/outbound`,
      statusCallback: `${baseUrl}/api/call/status`,
      statusCallbackMethod: "POST",
    });
    callLog.unshift({ sid: call.sid, type: "outbound", to, customerName: customerName || to, status: call.status, startTime: new Date().toISOString() });
    res.json({ success: true, callSid: call.sid, status: call.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/call/:sid/hangup", async (req, res) => {
  try {
    const client = getTwilio();
    await client.calls(req.params.sid).update({ status: "completed" });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/call/status", (req, res) => {
  const entry = callLog.find(c => c.sid === req.body.CallSid);
  if (entry) entry.status = req.body.CallStatus;
  res.sendStatus(200);
});

app.get("/api/logs", (req, res) => res.json({ logs: callLog.slice(0, 50) }));

// TwiML for outbound
app.all("/twiml/outbound", (req, res) => {
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Hello! This is a call from your sales team. Please hold while we connect you to an agent.</Say>
  <Dial timeout="30"><Number>${process.env.AGENT_1 || ""}</Number></Dial>
  <Say>All agents are busy. We will call you back soon. Goodbye.</Say>
</Response>`);
});

// TwiML for inbound IVR
app.all("/twiml/inbound", (req, res) => {
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
  const greeting = process.env.IVR_GREETING || "Welcome! Press 1 for Sales. Press 2 for Support. Press 3 for Orders. Press 0 for an agent.";
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${baseUrl}/twiml/ivr-route" timeout="10" method="POST">
    <Say>${greeting}</Say>
  </Gather>
  <Redirect>${baseUrl}/twiml/inbound</Redirect>
</Response>`);
});

app.all("/twiml/ivr-route", (req, res) => {
  const digit = req.body?.Digits || "0";
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
  const routes = {
    "1": { msg: "Connecting to sales.", agent: process.env.AGENT_SALES || process.env.AGENT_1 },
    "2": { msg: "Connecting to support.", agent: process.env.AGENT_SUPPORT || process.env.AGENT_1 },
    "3": { msg: "Connecting to orders.", agent: process.env.AGENT_3 || process.env.AGENT_1 },
    "0": { msg: "Connecting to an agent.", agent: process.env.AGENT_1 },
  };
  const r = routes[digit] || routes["0"];
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${r.msg}</Say>
  <Dial timeout="30" action="${baseUrl}/twiml/no-answer"><Number>${r.agent || ""}</Number></Dial>
</Response>`);
});

app.all("/twiml/no-answer", (req, res) => {
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Sorry, no agents available. Please call back. Goodbye.</Say></Response>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 IVR running on port ${PORT}`));
module.exports = app;

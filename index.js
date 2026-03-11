const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Twilio Client (lazy init so app runs without creds) ───────────────────────
function getTwilio() {
  const twilio = require("twilio");
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  if (!sid || !token) throw new Error("TWILIO_SID / TWILIO_TOKEN not set");
  return twilio(sid, token);
}

// ─── In-memory call log (replace with DB in production) ───────────────────────
const callLog = [];

// ═══════════════════════════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/", (req, res) => {
  res.json({
    status: "✅ IVR Backend Running",
    version: "1.0.0",
    endpoints: {
      outbound_call: "POST /api/call/outbound",
      call_status: "GET  /api/call/:sid",
      call_logs: "GET  /api/logs",
      hang_up: "POST /api/call/:sid/hangup",
      inbound_ivr: "POST /twiml/inbound",
      ivr_route: "POST /twiml/ivr-route",
      outbound_twiml: "POST /twiml/outbound",
    },
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  OUTBOUND — salesperson clicks "Call" in UI
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/call/outbound", async (req, res) => {
  try {
    const { to, customerName, agentNumber } = req.body;

    if (!to) return res.status(400).json({ error: "Missing 'to' phone number" });

    const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
    const client = getTwilio();

    const call = await client.calls.create({
      to,
      from: process.env.TWILIO_NUMBER,
      url: `${baseUrl}/twiml/outbound?name=${encodeURIComponent(customerName || "Customer")}`,
      statusCallback: `${baseUrl}/api/call/status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    const entry = {
      sid: call.sid,
      type: "outbound",
      to,
      customerName: customerName || to,
      status: call.status,
      startTime: new Date().toISOString(),
    };
    callLog.unshift(entry);

    res.json({ success: true, callSid: call.sid, status: call.status });
  } catch (err) {
    console.error("Outbound call error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Hang up a call ────────────────────────────────────────────────────────────
app.post("/api/call/:sid/hangup", async (req, res) => {
  try {
    const client = getTwilio();
    await client.calls(req.params.sid).update({ status: "completed" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get single call status ────────────────────────────────────────────────────
app.get("/api/call/:sid", async (req, res) => {
  try {
    const client = getTwilio();
    const call = await client.calls(req.params.sid).fetch();
    res.json({
      sid: call.sid,
      status: call.status,
      duration: call.duration,
      startTime: call.startTime,
      endTime: call.endTime,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
//  TWIML — OUTBOUND greeting (plays when customer picks up)
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/twiml/outbound", (req, res) => {
  const name = req.query.name || "there";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi" language="hi-IN">
    Hello ${name}, this is a call from our sales team. How can we help you today?
  </Say>
  <Pause length="1"/>
  <Say voice="Polly.Aditi" language="hi-IN">
    Please hold while we connect you to an available agent.
  </Say>
  <Dial timeout="30">
    <Number>${process.env.AGENT_1 || ""}</Number>
  </Dial>
  <Say voice="Polly.Aditi" language="hi-IN">
    All agents are currently busy. We will call you back soon. Thank you.
  </Say>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TWIML — INBOUND greeting (customer calls your number → auto IVR)
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/twiml/inbound", (req, res) => {
  const { From } = req.body;
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;

  callLog.unshift({
    sid: req.body.CallSid || "unknown",
    type: "inbound",
    from: From,
    status: "ivr",
    startTime: new Date().toISOString(),
  });

  const greeting = process.env.IVR_GREETING ||
    "Welcome! Thank you for calling. Press 1 for Sales. Press 2 for Technical Support. Press 3 for Order Status. Press 0 to speak with an agent.";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="${baseUrl}/twiml/ivr-route" timeout="10" method="POST">
    <Say voice="Polly.Aditi" language="hi-IN">${greeting}</Say>
  </Gather>
  <Say voice="Polly.Aditi" language="hi-IN">We did not receive your input. Please try again.</Say>
  <Redirect method="POST">${baseUrl}/twiml/inbound</Redirect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TWIML — IVR ROUTING (after customer presses key)
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/twiml/ivr-route", (req, res) => {
  const digit = req.body.Digits;
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;

  const sid = req.body.CallSid;
  const entry = callLog.find((c) => c.sid === sid);
  if (entry) entry.ivrKey = digit;

  const routes = {
    "1": {
      intent: "Sales",
      agent: process.env.AGENT_SALES || process.env.AGENT_1 || "",
      message: "Connecting you to our sales team. Please hold.",
    },
    "2": {
      intent: "Support",
      agent: process.env.AGENT_SUPPORT || process.env.AGENT_2 || "",
      message: "Connecting you to our technical support team. Please hold.",
    },
    "3": {
      intent: "Orders",
      agent: process.env.AGENT_3 || process.env.AGENT_1 || "",
      message: "Connecting you to our orders team. Please hold.",
    },
    "0": {
      intent: "Agent",
      agent: process.env.AGENT_1 || "",
      message: "Connecting you to the next available agent. Please hold.",
    },
  };

  const route = routes[digit];

  if (!route) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi" language="hi-IN">Invalid option. Please try again.</Say>
  <Redirect method="POST">${baseUrl}/twiml/inbound</Redirect>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  if (entry) entry.intent = route.intent;

  const dialBlock = route.agent
    ? `<Dial timeout="30" action="${baseUrl}/twiml/no-answer" method="POST">
        <Number>${route.agent}</Number>
      </Dial>`
    : `<Say voice="Polly.Aditi" language="hi-IN">No agents are configured yet. Please call back later.</Say>`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi" language="hi-IN">${route.message}</Say>
  ${dialBlock}
</Response>`;
  res.type("text/xml").send(twiml);
});

// ─── Fallback if agent doesn't answer ─────────────────────────────────────────
app.post("/twiml/no-answer", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Aditi" language="hi-IN">
    Sorry, our agent is unavailable right now. Please leave a message after the tone or call back soon. Thank you.
  </Say>
  <Record timeout="30" maxLength="60" transcribe="true"/>
  <Say voice="Polly.Aditi" language="hi-IN">Thank you for your message. Goodbye.</Say>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ═══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 IVR Backend running on port ${PORT}`));
module.exports = app;

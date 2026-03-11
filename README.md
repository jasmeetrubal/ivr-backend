# IVR Dialer Backend

Express.js backend for NexaDial IVR — handles outbound & inbound calls via Twilio.

## Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET | `/` | Health check + endpoint list |
| POST | `/api/call/outbound` | Trigger outbound call |
| GET | `/api/call/:sid` | Get call status |
| POST | `/api/call/:sid/hangup` | Hang up a call |
| GET | `/api/logs` | Get call log (last 50) |
| GET | `/api/agents` | List agents |
| POST | `/twiml/inbound` | **Set as Twilio webhook** for inbound calls |
| POST | `/twiml/ivr-route` | IVR key routing |
| POST | `/twiml/outbound` | Outbound call TwiML |

## Setup

1. Copy `.env.example` → `.env` and fill in your credentials
2. `npm install`
3. `npm start`

## Twilio Webhook Setup

In Twilio Console → Phone Numbers → Your Number → Voice:
- **A Call Comes In** → `https://your-backend.vercel.app/twiml/inbound` (HTTP POST)

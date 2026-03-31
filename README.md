# WhatsApp Service (whtsp-service)

A small Node.js service to send WhatsApp messages using whatsapp-web.js. It can render message templates by calling the Laravel API.

## Prereqs
- Node.js 18+
- A phone number with WhatsApp installed (to pair via QR)

## Setup

```powershell
cd c:\xampp\htdocs\RH\whtsp-service
npm install
npm install whatsapp-web.js qrcode-terminal express node-fetch@3
```

Optional env vars (create a `.env` if using a process manager like PM2):
- `PORT` (default `3085`)
- `API_BASE` (e.g. `http://localhost/sirh-back/public`)
- `API_TOKEN` (Bearer token if your API requires auth)

## Anti-block / throttling

WhatsApp can flag/block numbers that send too many messages too fast.
This service now sends messages through an internal queue with rate limiting.

**Configuration actuelle : 2 messages par minute avec délai aléatoire**
- `WA_RATE_MAX=120` (120 messages par heure)
- `WA_RATE_WINDOW_MS=3600000` (fenêtre de 60 minutes)
- `WA_MIN_INTERVAL_MS=30000` (minimum 30 secondes entre chaque message)
- `WA_JITTER_MS=15000` (délai aléatoire de 0 à 15 secondes ajouté)

**Comportement :**
- Envoie **2 messages par minute** maximum
- Délai minimum de **30 secondes** entre chaque message
- Un délai aléatoire de **0 à 15 secondes** est ajouté pour paraître plus naturel
- Résultat : environ 2 messages/minute avec un timing varié (30-45 secondes entre chaque)

You can check live queue status via `GET /status` (field `sendQueue`).

## Run

```powershell
npm run start
# or during development
npm run dev
```

On first start, scan the QR displayed in the terminal. The session is saved in a local folder by whatsapp-web.js LocalAuth.

## API
- `GET /health` → `{ status: 'ok' }`
- `POST /send-text` → `{ phone, text }`
- `POST /send-template` → `{ phone, templateKey, params }`

`/send-template` calls the Laravel endpoint `/api/templates/render` expected to return `{ text: string }`.
# whtsapdct

# Suites — WhatsApp Userbot

Suites is a WhatsApp userbot built with `@whiskeysockets/baileys`. This repository includes helpers for anti-delete, view-once recovery, tracking helpers, and media handling.

## Quick Start

Prerequisites:
- Node.js (16+ recommended)
- Network access to web.whatsapp.com

Install dependencies:

```bash
npm install
# optional installer if provided
npm run install
```

Start the bot:

```bash
npm start
```

## Environment

- `DNS_SERVERS` (optional): comma-separated DNS servers to use (default: `8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1`). Example:

```bash
DNS_SERVERS="8.8.8.8,1.1.1.1" npm start
```

## What I changed (network fixes)

- `lib/handler.js`: HTTPS agent now sets `servername` for TLS SNI, enables `keepAlive`, and provides matching agents in the error fallback. This reduces certificate/SNI and connection reuse issues.
- `index.js`: added a shared `dns.Resolver` (uses `DNS_SERVERS`), and updated `waitForDNS` to prefer that resolver and fall back to the system resolver to avoid frequent `EAI_AGAIN` errors.

Files to review:

- [lib/handler.js](lib/handler.js)
- [index.js](index.js)

## Troubleshooting network errors (EAI_AGAIN / getaddrinfo)

If you see errors like `getaddrinfo EAI_AGAIN web.whatsapp.com` or `Connection closed. Status: 408`:

1. Verify DNS resolution using a public DNS server:

```bash
nslookup web.whatsapp.com 8.8.8.8
# or
dig +short web.whatsapp.com @8.8.8.8
```

2. Force the app to use alternate DNS servers:

```bash
DNS_SERVERS="8.8.8.8,1.1.1.1" npm start
```

3. Check basic connectivity:

```bash
ping -c 3 web.whatsapp.com
curl -v https://web.whatsapp.com/ || true
```

4. If TLS errors occur, note that the bot currently sets `rejectUnauthorized: false` on the HTTPS agent in `lib/handler.js` for fallback. This is a pragmatic fix for self-signed or proxy-altered TLS during troubleshooting — remove or change it if you require strict verification.

## Capture more detailed logs

To gather more diagnostic info while reproducing the issue, run the process and capture stdout/stderr, and optionally run DNS checks in parallel:

```bash
# start the bot and capture logs
npm start 2>&1 | tee suites.log

# in another shell: monitor DNS / connectivity
watch -n 5 "dig +short web.whatsapp.com @8.8.8.8"
```

## Next steps

- If the EAI_AGAIN errors persist after switching DNS servers, test network/firewall settings on the host (corporate proxies, VPNs, or intermittent connectivity).
- I can (pick one):
  - run the app here and capture a live repro, or
  - add extra axios/WS diagnostics and a small connectivity test endpoint in the repo.

If you want the live run/log capture, tell me to proceed and I'll start `npm start` and collect logs.
# suite
# suite

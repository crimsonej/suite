# 🛡️ Suites — WhatsApp Userbot (Crimson Engine)

**Suites** is a modular, high-performance WhatsApp userbot built with Node.js and `@whiskeysockets/baileys`. Designed for privacy monitoring, media recovery, intelligence gathering, and daily automated utilities.

---

## ✨ Features

- 🛡️ **Anti-Delete**: Intercepts and recovers deleted messages (text, audio, stickers, media, and View-Once content).
- ✏️ **Anti-Edit**: Logs original text whenever a contact edits a message.
- 👁️ **Anti-View-Once (`./<>`)**: Intercepts and converts View-Once photos/videos/audio into permanent media.
- 🛰️ **P2P Target Tracking (`./track`)**: Inspects WebRTC ICE candidate stanzas to capture WAN IP addresses and perform geolocation lookup.
- 🖼️ **DP Fetcher (`./dp`)**: Downloads high-resolution profile pictures with built-in custom DNS resolution for WhatsApp media servers (`pps.whatsapp.net`).
- 🎨 **WebP Sticker Converter (`./s` / `./sticker`)**: Converts photos, videos, and media replies into square 512x512 WebP stickers using FFmpeg.
- ⏰ **Message Scheduler (`./schedule`)**: Queues automated messages using `node-cron`.
- 🏠 **Vault Anchor (`./home`)**: Designates a primary control chat for global command administrative overrides and logs.

---

## 🚀 Quick Start

### Prerequisites
- **Node.js**: v16+ (Recommended: Node.js 18 or 20)
- **FFmpeg**: System FFmpeg or `ffmpeg-static` (installed automatically via `npm install`)
- Network access to `web.whatsapp.com`

### 1. Installation

```bash
# Clone repository
git clone https://github.com/crimsonej/suite.git
cd suite

# Install dependencies
npm install

# Run installer setup
npm run install
```

### 2. Launching the Bot

```bash
npm start
```

*Scan the generated QR code in your terminal using WhatsApp (Linked Devices).*

---

## 📜 Command Reference

All commands use the `./` prefix by default.

| Command | Arguments | Description | Example |
| :--- | :--- | :--- | :--- |
| `./antidelete` | `[on/off]` / `groups [on/off]` | Toggle deleted message recovery for private chats or groups | `./antidelete on` |
| `./antiedit` | `[on/off]` / `groups [on/off]` | Toggle edited message diff capturing | `./antiedit on` |
| `./<>` | *(Reply to View-Once media)* | Convert View-Once media into permanent media | `./<>` |
| `./track` | `[jid/number]` | Probe target contact to capture WAN IP & geolocation | `./track 1234567890@s.whatsapp.net` |
| `./dp` | `[@user]` or *(Reply)* | Download high-res profile picture | `./dp @user` |
| `./s` or `./sticker` | *(Reply to image/video)* | Convert media into square WebP sticker | `./s` |
| `./status` | None | View OS RAM, uptime, and engine health | `./status` |
| `./home` | None | Anchor current chat as the Home Vault | `./home` |
| `./help` or `./menu` | None | Display interactive command menu | `./help` |

---

## ⚙️ Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DNS_SERVERS` | `8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1` | Comma-separated public DNS servers to resolve WhatsApp servers and bypass local DNS blocks |
| `IPINFO_TOKEN` | *(None)* | Optional API token for [ipinfo.io](https://ipinfo.io) geolocation lookup fallback |

Example usage:
```bash
DNS_SERVERS="8.8.8.8,1.1.1.1" npm start
```

---

## 🛠️ Network & Connection Troubleshooting

If you encounter `EAI_AGAIN` or socket connection timeouts on Linux/Termux:

1. Run the automatic network repair script:
   ```bash
   sudo ./fix-network.sh
   ```
2. Force public DNS resolution:
   ```bash
   DNS_SERVERS="8.8.8.8,1.1.1.1" npm start
   ```

---

## 📄 License & Credits

Created by **Crimson** — [github.com/crimsonej](https://github.com/crimsonej)  
Powered by `@whiskeysockets/baileys`.

const prefix = './';

function getMenu() {
    return "```" + `
╔══════════════════════════╗
║𝕮 𝕽 𝕴 𝕸 𝕾 𝕺 𝕹  𝕾 𝖀 𝕴 𝕿 𝕰║
╠══════════════════════════╣
║ 🛡️ PRIVACY & PROTECTION  ║
╟──────────────────────────╢
║ ❯ ./antidelete [on/off]  ║
║   (Private chat toggle)  ║
║ ❯ ./antidelete groups    ║
║   [on/off] (Global)      ║
║ ❯ ./antiedit [on/off]    ║
║   (Edit notification)    ║
║ ❯ ./antiedit groups      ║
║   [on/off] (Global)      ║
║ ❯ ./<>                   ║
║   (Save View-Once reply) ║
╠══════════════════════════╣
║ 🔍 INTEL & RECON         ║
╟──────────────────────────╢
║ ❯ ./track [jid]          ║
║   (P2P IP Probe)         ║
║ ❯ ./dp [@user]           ║
║   (Get Profile Picture)  ║
║ ❯ ./status               ║
║   (System Engine Health) ║
╠══════════════════════════╣
║ ⚙️ UTILITIES             ║
╟──────────────────────────╢
║ ❯ ./s / ./sticker        ║
║   (Media to WebP Sticker)║
║ ❯ ./schedule [HH:MM]|[msg]
║   (Schedule message)     ║
║ ❯ ./home                 ║
║   (Set Home Vault Anchor)║
║ ❯ ./help / ./menu        ║
║   (Show this menu)       ║
╚══════════════════════════╝
   Created by Crimson
   github.com/crimsonej
` + "```";
}

module.exports = { getMenu };

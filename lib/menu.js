const prefix = './';

function getMenu() {
    return "```" + `
╔══════════════════════════╗
║𝕮 𝕽 𝕴 𝕸 𝕾 𝕺 𝕹  𝕾 𝖀 𝕴 𝕿 𝕰║
╠══════════════════════════╣
║ 🛡️ PRIVACY               ║
╟──────────────────────────╢
║ ❯ ./antidelete [on/off]  ║
║   (Global toggle)        ║
║ ❯ ./antidelete group     ║
║   [on/off] (Per-chat)    ║
║ ❯ ./ghost [on/off]       ║
║   (Read ticks)           ║
║ ❯ ./<>                   ║
║   (View-Once)            ║
╠══════════════════════════╣
║ 🔍 INTEL                 ║
╟──────────────────────────╢
║ ❯ ./track [jid]          ║
║   (Probe session)        ║
║ ❯ ./dp [@user]           ║
║   (Profile image)        ║
║ ❯ ./status               ║
║   (Engine health)        ║
╠══════════════════════════╣
║ ⚙️ UTILITIES             ║
╟──────────────────────────╢
║ ❯ ./s                    ║
║   (Media to sticker)     ║
║ ❯ ./schedule [t]|[txt]   ║
║   (Queue msg)            ║
║ ❯ ./home                 ║
║   (Vault anchor)         ║
║ ❯ ./help                 ║
║   (Reload UI)            ║
╚══════════════════════════╝
   Created by Crimson
   github.com/crimsonej
` + "```";
}

module.exports = { getMenu };


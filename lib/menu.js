const prefix = './';

function getMenu() {
    return "```" + `
╔══════════════════════════╗
║𝕮 𝕽 𝕴 𝕸 𝕾 𝕺 𝕹  𝕾 𝖀 𝕴 𝕿 𝕰║
╠══════════════════════════╣
║ 🛡️ PRIVACY               ║
╟──────────────────────────╢
║ ❯ ./antidelete [on/off]  ║
<<<<<<< HEAD
║   (Global toggle)        ║
║ ❯ ./antidelete group     ║
║   [on/off] (Per-chat)    ║
║ ❯ ./ghost [on/off]       ║
║   (Read ticks)           ║
║ ❯ ./<>                   ║
║   (View-Once)            ║
=======
║ ❯ ./antiedit [on/off]    ║
║   (Toggle protection)    ║
║ ❯ ./antidelete groups    ║
║   [on/off]               ║
║ ❯ ./<>                   ║
║   (Save View-Once)       ║
>>>>>>> a076549 (latest)
╠══════════════════════════╣
║ 🔍 INTEL                 ║
╟──────────────────────────╢
║ ❯ ./track [jid]          ║
<<<<<<< HEAD
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
=======
║   (P2P Probe)            ║
║ ❯ ./dp [@user]           ║
║   (Get Profile Pic)      ║
║ ❯ ./status               ║
║   (Health & Stats)       ║
╠══════════════════════════╣
║ ⚙️ UTILITIES             ║
╟──────────────────────────╢
║ ❯ ./s / ./sticker        ║
║   (Make Sticker)         ║
║ ❯ ./home                 ║
║   (Set Authorized User)  ║
║ ❯ ./help                 ║
║   (Show this menu)       ║
╚════════════════════════════╝
>>>>>>> a076549 (latest)
   Created by Crimson
   github.com/crimsonej
` + "```";
}

module.exports = { getMenu };


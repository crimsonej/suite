const fs = require('fs-extra');
const path = require('path');
const vaultPath = path.join(__dirname, '../media/vault.json');

async function saveVault(jid) {
<<<<<<< HEAD
    await fs.writeJson(vaultPath, { jid });
=======
    try {
        await fs.ensureDir(path.dirname(vaultPath));
        await fs.writeJson(vaultPath, { jid });
    } catch (err) {
        console.error('[VAULT] Error saving vault:', err.message);
    }
>>>>>>> a076549 (latest)
}

async function getVault() {
    if (await fs.exists(vaultPath)) {
        const data = await fs.readJson(vaultPath);
        return data.jid;
    }
    return null;
}

module.exports = { saveVault, getVault };

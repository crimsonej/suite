const fs = require('fs-extra');
const path = require('path');
const vaultPath = path.join(__dirname, '../media/vault.json');

async function saveVault(jid) {
    try {
        await fs.ensureDir(path.dirname(vaultPath));
        await fs.writeJson(vaultPath, { jid });
    } catch (err) {
        console.error('[VAULT] Error saving vault:', err.message);
    }
}

async function getVault() {
    try {
        if (await fs.pathExists(vaultPath)) {
            const data = await fs.readJson(vaultPath);
            return data?.jid || null;
        }
    } catch (err) {
        console.error('[VAULT] Error reading vault:', err.message);
    }
    return null;
}

module.exports = { saveVault, getVault };

const fs = require('fs-extra');
const path = require('path');
const vaultPath = path.join(__dirname, '../media/vault.json');

async function saveVault(jid) {
    await fs.writeJson(vaultPath, { jid });
}

async function getVault() {
    if (await fs.exists(vaultPath)) {
        const data = await fs.readJson(vaultPath);
        return data.jid;
    }
    return null;
}

module.exports = { saveVault, getVault };

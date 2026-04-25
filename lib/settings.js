const fs = require('fs-extra');
const path = require('path');
const settingsPath = path.join(__dirname, '../media/settings.json');

async function getSettings() {
    const defaultSettings = { 
        home_jid: '', 
        antidelete: { global_private: false, global_groups: false, exceptions: {} } 
    };
    try {
        if (await fs.exists(settingsPath)) {
            let data = await fs.readJson(settingsPath);
            if (!data) return defaultSettings;
            if (!data.antidelete) data.antidelete = defaultSettings.antidelete;
            return data;
        }
    } catch (err) {
        console.error('[SETTINGS] Error reading settings:', err.message);
    }
    return defaultSettings;
}

async function saveSettings(settings) {
    try {
        await fs.ensureDir(path.dirname(settingsPath));
        await fs.writeJson(settingsPath, settings, { spaces: 2 });
    } catch (err) {
        console.error('[SETTINGS] Error saving settings:', err.message);
    }
}

module.exports = { getSettings, saveSettings };

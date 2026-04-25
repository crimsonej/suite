const { downloadContentFromMessage, getContentType } = require('@whiskeysockets/baileys');
const fs = require('fs-extra');
const path = require('path');
const { getVault } = require('./vault');

// The cache is now managed in handler.js for the new anti-delete implementation
// This is kept for backward compatibility with existing features
const msgCache = new Map();

// 24-hour cache cleanup
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of msgCache.entries()) {
        if (now - value.timestamp > 24 * 60 * 60 * 1000) {
            msgCache.delete(key);
        }
    }
}, 3600000);

function cacheMessages(msg) {
    if (!msg.message) return;
    const id = msg.key.id;
    msgCache.set(id, {
        msg: msg,
        timestamp: Date.now()
    });
}

async function handleAntiDelete(sock, msg) {
    // The new anti-delete implementation is now handled directly in handler.js
    // This function is kept for backward compatibility with existing features
    // It only handles type 0 protocol messages (older implementation)
    const protocolMsg = msg.message.protocolMessage;
    if (protocolMsg && protocolMsg.type === 0) {
        const targetId = protocolMsg.key.id;
        const cached = msgCache.get(targetId);

        if (cached) {
            const vaultJid = await getVault() || global.vault;
            const original = cached.msg;
            const participant = original.key.participant || original.key.remoteJid;

            await sock.sendMessage(vaultJid, {
                text: `🛑 *Anti-Delete Captured*\nFrom: @${participant.split('@')[0]}\nType: ${getContentType(original.message)}`,
                mentions: [participant]
            });
            await sock.copyNForward(vaultJid, original, false);
        }
    }
}

async function handleAntiViewOnce(sock, msg) {
    // Anti-view-once is now handled directly in handler.js
    // This function is kept for backward compatibility
    return;
}

module.exports = { cacheMessages, handleAntiDelete, handleAntiViewOnce };

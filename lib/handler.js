const { getContentType, downloadContentFromMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('ffmpeg-static');
const { getMenu } = require('./menu');
const { saveVault, getVault } = require('./vault');
const { getSettings, saveSettings } = require('./settings');
const analyzer = require('./analyzer');
const axios = require('axios');
const { Resolver } = require('dns').promises;
const https = require('https');
const http = require('http');

// ── Shared DNS Resolver (created once, reused forever) ──
// Previously a new Resolver() was instantiated on every DP/track lookup.
// Reusing a single instance avoids repeated socket allocation and is
// significantly faster under load.
const sharedResolver = new Resolver();
sharedResolver.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1']);

// Make analyzer globally accessible if not already
if (typeof global.analyzer === 'undefined') {
    global.analyzer = analyzer;
}

// Cache for DNS resolutions
const dnsCache = new Map();
const DNS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Function to resolve hostname using Google's DNS
async function resolveWithGoogleDNS(hostname) {
    // Serve from cache if fresh
    if (dnsCache.has(hostname)) {
        const cached = dnsCache.get(hostname);
        if (Date.now() - cached.timestamp < DNS_CACHE_TTL) return cached.ip;
        dnsCache.delete(hostname);
    }

    try {
        // Use the shared resolver — no new object created per call
        const ips = await sharedResolver.resolve4(hostname);
<<<<<<< HEAD
        const ip = ips[0];
=======
        if (!ips || ips.length === 0) {
            throw new Error(`No IP addresses found for ${hostname}`);
        }
        // Validate that we got a proper IP address
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        const validIP = ips.find(ip => ipRegex.test(ip));
        if (!validIP) {
            throw new Error(`No valid IP address found for ${hostname}`);
        }
        const ip = validIP;
>>>>>>> a076549 (latest)
        dnsCache.set(hostname, { ip, timestamp: Date.now() });
        return ip;
    } catch (error) {
        console.error(`[DNS] Failed to resolve ${hostname}:`, error.message);
        throw error; // Let the caller handle it; no silent swallow
    }
}

// Specialized function to resolve pps.whatsapp.net
async function resolvePPSWhatsappNet() {
    return await resolveWithGoogleDNS('pps.whatsapp.net');
}

// Function to create axios config with custom DNS lookup
async function createAxiosConfigWithCustomDNS(url) {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    try {
        // For pps.whatsapp.net, use our specialized resolver
        let ip;
        if (hostname === 'pps.whatsapp.net') {
            ip = await resolvePPSWhatsappNet();
        } else {
            // Use Google's DNS for other hosts
            ip = await resolveWithGoogleDNS(hostname);
        }

        // Replace hostname with IP in URL
        const newUrl = url.replace(hostname, ip);

        // Create axios config with custom headers to maintain original hostname
        // and set TLS SNI via `servername` so certificate/SNI validation works
        const httpsAgent = new https.Agent({
            keepAlive: true,
            rejectUnauthorized: false,
            servername: hostname
        });

        const httpAgent = new http.Agent({ keepAlive: true });

        return {
            url: newUrl,
            headers: {
                'Host': hostname // Important: keep original hostname for HTTP Host header
            },
            timeout: 60000, // 60 seconds timeout
            proxy: false, // Disable proxy
            httpsAgent,
            httpAgent
        };
    } catch (error) {
        console.error(`[DNS] Failed to create custom DNS config for ${url}:`, error.message);
        // Fallback to normal config
        return {
            url: url,
            timeout: 60000,
            proxy: false,
<<<<<<< HEAD
=======
            responseType: 'stream',
>>>>>>> a076549 (latest)
            httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false, servername: (new URL(url)).hostname }),
            httpAgent: new http.Agent({ keepAlive: true })
        };
    }
}

// Function to validate if an IP is a public IP (not private/local)
function validatePublicIP(ip) {
    if (!ip) return false;

    // Check if it's a valid IP format first
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (!ipRegex.test(ip)) return false;

    const parts = ip.split('.').map(Number);
    const firstOctet = parts[0];
    const secondOctet = parts[1];

<<<<<<< HEAD
    // Check if it's a private IP range
    const isPrivate = firstOctet === 10 ||
                     (firstOctet === 192 && secondOctet === 168) ||
                     (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31);

    // Return true if it's NOT a private IP (i.e., it's a public IP)
=======
    // Check if it's a private/reserved IP range
    const isPrivate = firstOctet === 10 ||  // RFC 1918: 10.0.0.0/8
                     (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||  // RFC 1918: 172.16.0.0/12
                     (firstOctet === 192 && secondOctet === 168) ||  // RFC 1918: 192.168.0.0/16
                     firstOctet === 0 ||  // RFC 1122: 0.0.0.0/8 (this network)
                     (firstOctet === 169 && secondOctet === 254) ||  // RFC 3927: 169.254.0.0/16 (link-local)
                     (firstOctet >= 224 && firstOctet <= 239) ||  // RFC 3171: 224.0.0.0/4 (multicast)
                     (firstOctet >= 240 && firstOctet <= 255);  // RFC 1112: 240.0.0.0/4 (reserved)

    // Return true if it's NOT a private/reserved IP (i.e., it's a public IP)
>>>>>>> a076549 (latest)
    return !isPrivate;
}

function formatUptime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours}h ${minutes}m ${secs}s`;
}

ffmpeg.setFfmpegPath(ffmpegInstaller);

// Validate FFmpeg binary is executable (catches Parrot OS permission issues)
try {
    const { execSync } = require('child_process');
    execSync(`"${ffmpegInstaller}" -version`, { stdio: 'ignore', timeout: 5000 });
} catch (ffmpegErr) {
    console.warn('[FFMPEG] ⚠ ffmpeg-static binary may not be executable on this system.');
    console.warn('[FFMPEG]   Path:', ffmpegInstaller);
    console.warn('[FFMPEG]   Fix: chmod +x "' + ffmpegInstaller + '"');
}

async function handleMessages(sock, msg) {
<<<<<<< HEAD
    // ── Universal Context & Debug ──
=======
    // ── Universal Context ──
>>>>>>> a076549 (latest)
    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || msg.participant) : from;

<<<<<<< HEAD
    console.log('Detected message from:', from, '| isGroup:', isGroup, '| sender:', sender);

    // ── ANTI-DELETE: Intercept Revoke protocol messages ──
    const protoType = msg.message?.protocolMessage?.type;
    if (protoType === 0 || protoType === 14 || protoType === 'REVOKE') {
        return;
    }

    // Removed the restriction requiring commands to be 'fromMe' or 'replies to me'
    // to allow the bot to respond to commands in group chats as requested.
=======
    // ── PROTOCOL: Intercept Deletions and Edits ──
    const proto = msg.message?.protocolMessage;
    if (proto) {
        const typeRaw = String(proto.type || '').toLowerCase();
        const targetId = proto.key?.id;
        const originalMsg = global.msgCache.get(targetId);
        const settings = await getSettings();
        const isGroupProto = from.endsWith('@g.us');

        // normalize possible type representations (numeric or string)
        const isRevoke = typeRaw === '0' || typeRaw === 'revoke' || typeRaw === 'delete';
        const isEdit = typeRaw === '14' || typeRaw.includes('edit') || typeRaw === 'message_edit' || typeRaw === 'edited';

        if (isRevoke && originalMsg) { // REVOKE (Delete)
            const feature = 'antidelete';
            const shouldTrigger = settings[feature].exceptions.hasOwnProperty(from)
                ? settings[feature].exceptions[from]
                : (isGroupProto ? settings[feature].global_groups : settings[feature].global_private);

            if (shouldTrigger && !originalMsg.key.fromMe) {
                const participant = originalMsg.key.participant || originalMsg.key.remoteJid || from;
                await _handleAntiDelete(sock, from, originalMsg, participant, targetId);
            }
            return;
        } else if (isEdit && originalMsg) { // MESSAGE_EDIT
            const feature = 'antiedit';
            const shouldTrigger = settings[feature].exceptions.hasOwnProperty(from)
                ? settings[feature].exceptions[from]
                : (isGroupProto ? settings[feature].global_groups : settings[feature].global_private);

            if (shouldTrigger) {
                const oldText = originalMsg.message?.conversation || originalMsg.message?.extendedTextMessage?.text;
                const newText = proto.editedMessage?.conversation || proto.editedMessage?.extendedTextMessage?.text;

                if (oldText !== newText) {
                    await sock.sendMessageResilient(from, {
                        text: `✏️ *Anti-Edit Captured*\n\n*Original:* ${oldText || '[Media/Non-text]'}\n*Edited:* ${newText || '[Media/Non-text]'}`
                    }, { quoted: originalMsg });
                }
            }
            return;
        }
    }

    // ── Security Guard: Only process commands from the bot itself or the 'home' user ──
    const { getSettings } = require('./settings');
    const settings = await getSettings();
    const isFromMe = msg.key.fromMe;
    const normalizeLocal = (j) => j ? jidNormalizedUser(j).split('@')[0] : null;
    const homeLocal = normalizeLocal(settings.home_jid);
    const senderLocal = normalizeLocal(sender);
    const isHomeUser = senderLocal && homeLocal && senderLocal === homeLocal;

    if (!isFromMe && !isHomeUser) return;
>>>>>>> a076549 (latest)

    // ── ANTI-VIEW-ONCE: ./<> command ──
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

    if (text === './<>') {
        try {
            // 1. Get the quoted message
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

            if (!quotedMsg) {
                await sock.sendMessageResilient(from, { text: '[Chela] You must reply to a View-Once message to use this command.' }, { quoted: msg });
                return;
            }

            // 2. Unwrap view-once wrappers
            const viewOnceWrapper = quotedMsg.viewOnceMessageV2
                || quotedMsg.viewOnceMessageV2Extension
                || quotedMsg.viewOnceMessage;

            // Also check if the quoted message itself is a direct image/video (already stripped)
            const innerMessage = viewOnceWrapper ? viewOnceWrapper.message : quotedMsg;

            if (!innerMessage) {
                await sock.sendMessageResilient(from, { text: '[Chela] The quoted message is not a View-Once media.' }, { quoted: msg });
                return;
            }

            // 3. Detect media type
            const mediaType = innerMessage.imageMessage ? 'imageMessage'
                : innerMessage.videoMessage ? 'videoMessage'
                : innerMessage.audioMessage ? 'audioMessage'
                : null;

            if (!mediaType) {
                await sock.sendMessageResilient(from, { text: '[Chela] The quoted message is not a View-Once media.' }, { quoted: msg });
                return;
            }

            const mediaMsg = innerMessage[mediaType];

            // 4. Strip the viewOnce flag
            mediaMsg.viewOnce = false;

            // 5. Download the media buffer
            const stream = await downloadContentFromMessage(
                mediaMsg,
                mediaType === 'imageMessage' ? 'image' : (mediaType === 'videoMessage' ? 'video' : 'audio')
            );
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }

            // 6. Re-send as a standard (non-viewOnce) message
            const sendKey = mediaType === 'imageMessage' ? 'image' : (mediaType === 'videoMessage' ? 'video' : 'audio');
            
            const messagePayload = {
                [sendKey]: buffer,
                mimetype: mediaMsg.mimetype || (sendKey === 'image' ? 'image/jpeg' : (sendKey === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus'))
            };

            if (sendKey !== 'audio') {
                messagePayload.caption = '🛡️ *Crimson Anti-View-Once*\nIntercepted successfully.';
                messagePayload.contextInfo = {
                    externalAdReply: {
                        title: 'Crimson',
                        body: 'Anti-View-Once Active',
                        mediaType: 1,
                        thumbnail: buffer,
                        sourceUrl: ''
                    }
                };
            } else {
                // Determine if it was sent as a voice note
                messagePayload.ptt = mediaMsg.ptt || false;
            }

            await sock.sendMessageResilient(from, messagePayload, { quoted: msg });


            // Memory cleanup
            buffer = null;
        } catch (voErr) {
            console.log('[ANTI-VIEW-ONCE] Error:', voErr.message);
            await sock.sendMessageResilient(from, { text: `[Chela] Anti-View-Once failed: ${voErr.message}` }, { quoted: msg });
        }

        return; // Stop execution here
    }

    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

    if (from === 'status@broadcast') return await saveStatus(sock, msg);

    const prefix = './';
    if (!body.startsWith(prefix)) return;

    const args = body.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const vaultJid = await getVault() || global.vault;

    switch (command) {
        case 'antidelete': {
<<<<<<< HEAD
            const subCommand = args[0];
            const remoteJid = msg.key.remoteJid;
            const settings = await getSettings();
            const isGroup = remoteJid.endsWith('@g.us');
            
            const sender = jidNormalizedUser(remoteJid);
            const home = settings.home_jid ? jidNormalizedUser(settings.home_jid) : null;

            // Admin check for groups
            if (isGroup && (subCommand === 'on' || subCommand === 'off')) {
                try {
                    const metadata = await sock.groupMetadata(remoteJid);
                    const me = jidNormalizedUser(sock.user.id);
                    const participant = metadata.participants.find(p => jidNormalizedUser(p.id) === me);
                    const isAdmin = participant?.admin || participant?.isSuperAdmin;
                    
                    /* 
                    if (!isAdmin) {
                        await sock.sendMessageResilient(remoteJid, { text: '[Crimson] Warning: The bot is not a Group Admin. Anti-Delete may not capture all revoked events in this group.' });
                    }
                    */
                } catch (e) {
                    console.log('[ANTIDELETE] Failed to check admin status:', e.message);
                }
            }

            if (subCommand === 'groups') {
                const subState = args[1];
                if (sender === home) {
                    if (subState === 'on') {
                        settings.antidelete.global_groups = true;
                    } else if (subState === 'off') {
                        settings.antidelete.global_groups = false;
                    }
                    // Clear group exceptions
                    settings.antidelete.exceptions = Object.fromEntries(
                        Object.entries(settings.antidelete.exceptions).filter(([jid]) => !jid.endsWith('@g.us'))
                    );
                    await saveSettings(settings);
                    await sock.sendMessageResilient(remoteJid, { text: `[Crimson] Global Groups Anti-Delete is now ${subState === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                } else {
                    await sock.sendMessageResilient(remoteJid, { text: '[Crimson] Error: Global group commands must be executed in the Home vault.' });
                }
            } else if (subCommand === 'on' || subCommand === 'off') {
                if (sender === home) {
                    settings.antidelete.global_private = subCommand === 'on';
                    // Clear private chat exceptions
                    settings.antidelete.exceptions = Object.fromEntries(
                        Object.entries(settings.antidelete.exceptions).filter(([jid]) => jid.endsWith('@g.us'))
                    );
                    await saveSettings(settings);
                    await sock.sendMessageResilient(remoteJid, { text: `[Crimson] Global Private Anti-Delete is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                } else {
                    settings.antidelete.exceptions[remoteJid] = subCommand === 'on';
                    await saveSettings(settings);
                    await sock.sendMessageResilient(remoteJid, { text: `[Crimson] Local Override: Anti-Delete is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'} for this chat.` });
                }
            } else {
                let shouldTrigger = false;
                if (settings.antidelete.exceptions.hasOwnProperty(remoteJid)) {
                    shouldTrigger = settings.antidelete.exceptions[remoteJid];
                } else {
                    shouldTrigger = isGroup ? settings.antidelete.global_groups : settings.antidelete.global_private;
                }
                const isGlobal = !settings.antidelete.exceptions.hasOwnProperty(remoteJid);
                await sock.sendMessageResilient(remoteJid, { text: `[Crimson] Anti-Delete Status: ${shouldTrigger ? 'ON' : 'OFF'} (${isGlobal ? 'Global' : 'Local'})` });
            }
            return;
        }

        case 'home': {
            await saveVault(from);
            const settings = await getSettings();
            settings.home_jid = jidNormalizedUser(from);
            await saveSettings(settings);
            await sock.sendMessageResilient(from, { text: '🏠 Home Base (Vault) Anchor Set.' });
=======
            const subCommand = args[0]?.toLowerCase();
            const remoteJid = msg.key.remoteJid;
            const settings = await getSettings();
            const isGroup = remoteJid.endsWith('@g.us');
            const homeJid = settings.home_jid ? jidNormalizedUser(settings.home_jid) : null;
            const isHomeChat = jidNormalizedUser(from) === homeJid;
            const feature = 'antidelete';

            if (subCommand === 'on' || subCommand === 'off') {
                if (isHomeChat) {
                    settings[feature].global_private = subCommand === 'on';
                    settings[feature].exceptions = Object.fromEntries(
                        Object.entries(settings[feature].exceptions).filter(([jid]) => jid.endsWith('@g.us'))
                    );
                    await saveSettings(settings);
                    await sock.sendMessageResilient(from, { text: `✅ Global Anti-Delete for Private Chats is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                } else if (isGroup) {
                    settings[feature].exceptions[remoteJid] = subCommand === 'on';
                    await saveSettings(settings);
                    await sock.sendMessageResilient(from, { text: `✅ Anti-Delete for this Group is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                } else {
                    settings[feature].exceptions[remoteJid] = subCommand === 'on';
                    await saveSettings(settings);
                    await sock.sendMessageResilient(from, { text: `✅ Anti-Delete for this chat is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                }
            } else if (subCommand === 'groups') {
                if (isHomeChat) {
                    const groupAction = args[1]?.toLowerCase();
                    if (groupAction === 'on' || groupAction === 'off') {
                        settings[feature].global_groups = groupAction === 'on';
                        settings[feature].exceptions = Object.fromEntries(
                            Object.entries(settings[feature].exceptions).filter(([jid]) => !jid.endsWith('@g.us'))
                        );
                        await saveSettings(settings);
                        await sock.sendMessageResilient(from, { text: `✅ Global Anti-Delete for Groups is now ${groupAction === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                    } else {
                        await sock.sendMessageResilient(from, { text: "Usage: ./antidelete groups <on/off>" });
                    }
                } else {
                    await sock.sendMessageResilient(from, { text: "❌ Global group settings can only be managed from the Home chat." });
                }
            } else { // Status check
                let statusText = `*Anti-Delete Status:*\n`;
                if (isHomeChat) {
                    const privateStatus = settings[feature].global_private ? 'ON' : 'OFF';
                    const groupStatus = settings[feature].global_groups ? 'ON' : 'OFF';
                    const activeGroups = Object.entries(settings[feature].exceptions).filter(([jid, active]) => jid.endsWith('@g.us') && active).length;
                    statusText += `  Private Chats (Global): ${privateStatus}\n  Groups (Global): ${groupStatus}\n  Active Groups (Local): ${activeGroups}`;
                } else {
                    const localOverride = settings[feature].exceptions.hasOwnProperty(remoteJid);
                    const currentStatus = localOverride 
                        ? settings[feature].exceptions[remoteJid]
                        : (isGroup ? settings[feature].global_groups : settings[feature].global_private);
                    statusText += `  ${isGroup ? 'Group' : 'Private Chat'}: ${currentStatus ? 'ON' : 'OFF'} ${localOverride ? '(Local Override)' : '(Global)'}`;
                }
                await sock.sendMessageResilient(from, { text: statusText });
            }
            break;
        }

        case 'antiedit': {
            const subCommand = args[0]?.toLowerCase();
            const remoteJid = msg.key.remoteJid;
            const settings = await getSettings();
            const isGroup = remoteJid.endsWith('@g.us');
            const homeJid = settings.home_jid ? jidNormalizedUser(settings.home_jid) : null;
            const isHomeChat = jidNormalizedUser(from) === homeJid;
            const feature = 'antiedit';

            if (subCommand === 'on' || subCommand === 'off') {
                if (isHomeChat) {
                    settings[feature].global_private = subCommand === 'on';
                    settings[feature].exceptions = Object.fromEntries(
                        Object.entries(settings[feature].exceptions).filter(([jid]) => jid.endsWith('@g.us'))
                    );
                    await saveSettings(settings);
                    await sock.sendMessageResilient(from, { text: `✅ Global Anti-Edit for Private Chats is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                } else if (isGroup) {
                    settings[feature].exceptions[remoteJid] = subCommand === 'on';
                    await saveSettings(settings);
                    await sock.sendMessageResilient(from, { text: `✅ Anti-Edit for this Group is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                } else {
                    settings[feature].exceptions[remoteJid] = subCommand === 'on';
                    await saveSettings(settings);
                    await sock.sendMessageResilient(from, { text: `✅ Anti-Edit for this chat is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                }
            } else if (subCommand === 'groups') {
                if (isHomeChat) {
                    const groupAction = args[1]?.toLowerCase();
                    if (groupAction === 'on' || groupAction === 'off') {
                        settings[feature].global_groups = groupAction === 'on';
                        settings[feature].exceptions = Object.fromEntries(
                            Object.entries(settings[feature].exceptions).filter(([jid]) => !jid.endsWith('@g.us'))
                        );
                        await saveSettings(settings);
                        await sock.sendMessageResilient(from, { text: `✅ Global Anti-Edit for Groups is now ${groupAction === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                    } else {
                        await sock.sendMessageResilient(from, { text: "Usage: ./antiedit groups <on/off>" });
                    }
                } else {
                    await sock.sendMessageResilient(from, { text: "❌ Global group settings can only be managed from the Home chat." });
                }
            } else { // Status check
                let statusText = `*Anti-Edit Status:*\n`;
                if (isHomeChat) {
                    const privateStatus = settings[feature].global_private ? 'ON' : 'OFF';
                    const groupStatus = settings[feature].global_groups ? 'ON' : 'OFF';
                    const activeGroups = Object.entries(settings[feature].exceptions).filter(([jid, active]) => jid.endsWith('@g.us') && active).length;
                    statusText += `  Private Chats (Global): ${privateStatus}\n  Groups (Global): ${groupStatus}\n  Active Groups (Local): ${activeGroups}`; 
                } else {
                    const localOverride = settings[feature].exceptions.hasOwnProperty(remoteJid);
                    const currentStatus = localOverride 
                        ? settings[feature].exceptions[remoteJid]
                        : (isGroup ? settings[feature].global_groups : settings[feature].global_private);
                    statusText += `  ${isGroup ? 'Group' : 'Private Chat'}: ${currentStatus ? 'ON' : 'OFF'} ${localOverride ? '(Local Override)' : '(Global)'}`;
                }
                await sock.sendMessageResilient(from, { text: statusText });
            }
>>>>>>> a076549 (latest)
            break;
        }

        case 'status': {
            const settings = await getSettings();
            const serverName = settings.session_name || os.hostname() || 'Unknown Server';

            const totalRAM = os.totalmem();
            const freeRAM = os.freemem();
            const usedRAM = totalRAM - freeRAM;
            const usedRAMMB = (usedRAM / 1024 / 1024).toFixed(2);
            const totalRAMGB = (totalRAM / 1024 / 1024 / 1024).toFixed(2);

            const uptime = formatUptime(process.uptime());
            const latencyMS = msg.messageTimestamp
                ? Math.max(0, Date.now() - (msg.messageTimestamp > 1e12 ? msg.messageTimestamp : msg.messageTimestamp * 1000))
                : 0;

            const statusArt = `╔════════════════════════════╗
║    𝕾 𝖀 𝕴 𝕿 𝕰  𝕾 𝕿 𝕬 𝕿 𝖀 𝕾    ║
╠════════════════════════════╣
║ ❯ OS: ${os.platform()} (${os.arch()})
║ ❯ RAM: ${usedRAMMB}MB / ${totalRAMGB}GB
║ ❯ Uptime: ${uptime}
║ ❯ Latency: ${latencyMS}ms
║ ❯ Server: ${serverName}
╚════════════════════════════╝`;

            await sock.sendMessageResilient(from, { text: statusArt });
            break;
        }

        case 'dp': {
            console.log(`[PROCESS] Fetching DP for target...`);
            await sock.sendMessageResilient(from, { text: '🔍 Searching Profile...' });
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;
            let target = (mentioned && mentioned[0]) || quoted || from;

            // Retry mechanism with exponential backoff
            let retries = 0;
            const maxRetries = 5; // Increased to 5 retries
            let success = false;

            while (retries <= maxRetries && !success) {
                try {
                    const ppUrl = await sock.profilePictureUrl(target, 'image');
                    console.log(`[PROCESS] DP URL: ${ppUrl}`);

                    if (!ppUrl) {
                        await sock.sendMessageResilient(from, { text: '❌ No profile picture found for this user.' });
                        target = null;
                        return;
                    }

                    // Use custom DNS resolution for pps.whatsapp.net
                    console.log(`[PROCESS] Fetching image with axios (attempt ${retries + 1})...`);

                    // Create axios config with custom DNS
                    const axiosConfig = await createAxiosConfigWithCustomDNS(ppUrl);

                    // Add stream response type and other options
                    axiosConfig.responseType = 'stream';

                    // Create the axios request
                    const response = await axios(axiosConfig);

                    // Stream the image directly
                    await sock.sendMessageResilient(vaultJid, {
                        image: { stream: response.data }, // Send stream directly
                        caption: `DP Captured: @${target.split('@')[0]}`,
                        mentions: [target]
                    });

                    console.log(`[SUCCESS] DP sent to vault.`);
                    success = true;

                } catch (e) {
                    console.error(`[ERROR] DP Fetch failed (attempt ${retries + 1}): ${e.message}`, e);
                    retries++;

                    if (retries <= maxRetries) {
                        // Wait 5 seconds before retrying
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    } else {
                        await sock.sendMessageResilient(from, { text: `❌ Error after ${maxRetries} attempts: ${e.message}` });
                    }
                }
            }

            // Clean up variables
            target = null;
            break;
        }

        case 'track': {
<<<<<<< HEAD
            // Send initial tracking message
            await sock.sendMessageResilient(from, { text: '🛰️ Tracking...' });

            // Get target JID from command args or use from
            const targetJid = args[0] || from;

            // 1. WAKE UP THE TARGET (Presence Manipulation)
            try {
                console.log(`[TRACK] Waking up target with presence update...`);
                await sock.sendPresenceUpdate('composing', targetJid);
                // Wait a bit for the presence update to be processed
                await new Promise(resolve => setTimeout(resolve, 500));
                // Stop typing
                await sock.sendPresenceUpdate('paused', targetJid);
            } catch (presenceErr) {
                console.log(`[TRACK] Presence update failed: ${presenceErr.message}`);
            }

            // 2. THE STEALTH PROBE
            let ipCaptured = false;
            let capturedIP = null;

            for (let i = 1; i <= 5; i++) {
                if (ipCaptured) break;

                console.log(`[TRACK] Stealth Handshake ${i}/5...`);

                try {
                    // Activate debug tracking for this handshake attempt
                    if (typeof global.analyzer !== 'undefined' && global.analyzer.startDebugTracking) {
                        global.analyzer.startDebugTracking(8000); // Match the timeout
                    }

                    // Send a presence update to trigger a response
                    await sock.sendPresenceUpdate('composing', targetJid);

                    // Wait 500ms for the presence update to be processed (as requested)
                    await new Promise(resolve => setTimeout(resolve, 500));

                    // Stop composing
                    await sock.sendPresenceUpdate('paused', targetJid);

                    // 3. LISTEN FOR CANDIDATE (The "Sniff")
                    // We wrap the analyzer in a timeout so it doesn't hang
                    try {
                        const result = await Promise.race([
                            analyzer.captureIP(`handshake-${i}-${Date.now()}`), // Unique call ID
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000)) // Extended to 8 seconds
                        ]);

                        if (result && result.ip) {
                            console.log(`[SUCCESS] IP Found: ${result.ip}`);
                            capturedIP = result.ip;
                            ipCaptured = true;
                            break;
                        }
                    } catch (e) {
                        // Silent fail - move to next attempt
                        console.log(`[TRACK] Handshake ${i} timed out or failed: ${e.message}`);
                    }
                } catch (handshakeErr) {
                    console.log(`[TRACK] Handshake ${i} failed: ${handshakeErr.message}`);
                }

                // Wait before next attempt
                if (!ipCaptured && i < 5) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // If we didn't get an IP from the stealth handshake, fall back to previous methods
            if (!ipCaptured) {
                console.log(`[TRACK] Stealth handshake unsuccessful, falling back to legacy methods...`);

                // Try to get IP from various sources
                capturedIP = global.intelCache.get(targetJid);

                if (!capturedIP || capturedIP === 'Detected Incoming Offer') {
                    capturedIP = (typeof global.analyzer !== 'undefined' ? global.analyzer.p2pLastIP : analyzer.p2pLastIP);
                }
            }

            // Validate IP - discard private IPs and keep sniffing for public WAN IP
            if (capturedIP && capturedIP !== 'Detected Incoming Offer') {
                const isValidPublicIP = validatePublicIP(capturedIP);
                if (!isValidPublicIP) {
                    // Discard private IP and keep sniffing
                    console.log(`[TRACK] Discarded private IP: ${capturedIP}`);
                    capturedIP = null;

                    // Try to get a public IP in the next 5 seconds
                    const startTime = Date.now();
                    while ((Date.now() - startTime) < 5000 && (!capturedIP || capturedIP === 'Detected Incoming Offer')) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                        capturedIP = (typeof global.analyzer !== 'undefined' ? global.analyzer.p2pLastIP : analyzer.p2pLastIP);
                        if (capturedIP && capturedIP !== 'Detected Incoming Offer' && validatePublicIP(capturedIP)) {
                            console.log(`[TRACK] Found public IP: ${capturedIP}`);
                            break;
                        }
                    }
                }
            }

            // If we still don't have an IP, inform the user
            if (!capturedIP || capturedIP === 'Detected Incoming Offer') {
                await sock.sendMessageResilient(from, { text: "📡 Handshake failed. The target's firewall is blocking P2P." });
                break;
            }

            // Lookup the IP
            const result = await analyzer.lookupIP(capturedIP);
            if (result) {
                const response = `📍 *Location Information*\n\n` +
                               `IP: ${result.ip}\n` +
                               `Location: ${result.location}\n` +
                               `Map: ${result.gMapsUrl}`; // Clickable maps link
                await sock.sendMessageResilient(from, { text: response });
            } else {
                await sock.sendMessageResilient(from, { text: `❌ Failed to lookup location for IP: ${capturedIP}` });
            }
=======
            // Active probe: send offerCall, collect candidates, resolve via ipinfo.io, send report to Home JID
            await sock.sendMessageResilient(from, { text: '🛰️ Tracking (probe initiated)...' });

            const targetJid = args[0] || from;

            // mark as initiated so index.js will auto-reject and map call data
            try {
                global.initiatedTargets.add(targetJid);
            } catch (_) {}

            // initiate the ghost call
            try {
                await sock.offerCall(targetJid, { isVideo: false }).catch(() => {});
            } catch (e) {
                // Some environments may not support offerCall; ignore and continue
            }

            // Wait collection window
            await new Promise(resolve => setTimeout(resolve, 2500));

            // Collect unique IP candidates gathered by index.js (grouped by from JID)
            const candidatesSet = global.candidateMapByFrom.get(targetJid) || new Set();
            const uniqueIps = Array.from(candidatesSet);

            // Clean up the temporary store for this target
            try { global.candidateMapByFrom.delete(targetJid); } catch (_) {}

            // Determine owner JID
            let homeJid = global.vault;
            try {
                const settings = await getSettings();
                if (settings?.home_jid) homeJid = settings.home_jid;
            } catch (_) {}

            if (!uniqueIps.length) {
                await sock.sendMessageResilient(homeJid, { text: `📡 Track report for ${targetJid}: No candidates found.` });
                break;
            }

            const token = process.env.IPINFO_TOKEN;
            const reports = [];
            for (const ip of uniqueIps) {
                try {
                    if (token) {
                        const resp = await require('axios').get(`https://ipinfo.io/${ip}?token=${token}`, { timeout: 5000 });
                        reports.push(resp.data);
                    } else {
                        reports.push({ ip });
                    }
                } catch (e) {
                    reports.push({ ip, error: e.message });
                }
            }

            // Format the multi-report
            const lines = [`📡 Track report for ${targetJid}`];
            const seen = new Set();
            for (const r of reports) {
                const ip = r.ip || 'unknown';
                if (seen.has(ip)) continue;
                seen.add(ip);
                const city = r.city || r.region || '';
                const org = r.org || '';
                const loc = r.loc || '';
                let netType = 'Unknown';
                if (/hosting|google|cloud/i.test(org)) netType = 'VPN/Proxy/Hosting';
                if (/mtn|airtel|vodafone|safaricom|tracfone|att|verizon|t-mobile/i.test(org)) netType = 'Mobile/Residential';
                lines.push(`• ${ip} — ${city} ${loc ? `(${loc})` : ''} — ${org} — ${netType}`);
            }

            try { await sock.sendMessageResilient(homeJid, { text: lines.join('\n') }); } catch (_) {}
>>>>>>> a076549 (latest)
            break;
        }

        case 'menu':
        case 'help':
            await sock.sendMessageResilient(from, { text: getMenu() });
            break;
<<<<<<< HEAD
=======

        case 'sticker':
        case 's': {
            try {
                // 1. Get the target message (quoted or the current message)
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const mediaMsg = msg.message?.imageMessage || msg.message?.videoMessage || 
                                 quoted?.imageMessage || quoted?.videoMessage || 
                                 quoted?.documentMessage;

                if (!mediaMsg) {
                    await sock.sendMessageResilient(from, { text: '❌ Please reply to an image or video to convert it to a sticker.' }, { quoted: msg });
                    return;
                }

                // 2. Download media
                const mime = mediaMsg.mimetype || '';
                const isVideo = mime.startsWith('video/');
                const ext = mime.split('/')[1] ? mime.split('/')[1].replace(/[^a-z0-9]/gi, '') : (isVideo ? 'mp4' : 'jpg');
                const stream = await downloadContentFromMessage(mediaMsg, isVideo ? 'video' : 'image');
                let buffer = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                // 3. Convert to sticker using ffmpeg (write temp file with proper extension)
                const tempFile = path.join(os.tmpdir(), `sticker_${Date.now()}.${ext}`);
                const outputFile = `${tempFile}.webp`;
                await fs.writeFile(tempFile, buffer);

                try {
                    await new Promise((resolve, reject) => {
                        const cmd = ffmpeg(tempFile)
                            .on('error', (err) => reject(err))
                            .on('end', () => resolve());

                        // Limit video duration to 10s to avoid huge stickers
                        if (isVideo) cmd.inputOptions(['-t', '10']);

                        cmd.outputOptions([
                            '-vcodec', 'libwebp',
                            '-vf', "scale=512:512:force_original_aspect_ratio=decrease,fps=15",
                            '-lossless', '1',
                            '-compression_level', '6',
                            '-qscale', '75',
                            '-loop', '0',
                            '-preset', 'default',
                            '-an',
                            '-vsync', '0'
                        ])
                        .toFormat('webp')
                        .save(outputFile);
                    });

                    // 4. Send the sticker
                    const stickerBuffer = await fs.readFile(outputFile);
                    await sock.sendMessageResilient(from, { sticker: stickerBuffer }, { quoted: msg });
                } finally {
                    // 5. Cleanup temp files
                    try { await fs.remove(tempFile); } catch (e) {}
                    try { await fs.remove(outputFile); } catch (e) {}
                    if (buffer) { buffer.fill(0); buffer = null; }
                }

            } catch (err) {
                console.error('[STICKER] Error:', err);
                await sock.sendMessageResilient(from, { text: `❌ Sticker conversion failed: ${err.message}` }, { quoted: msg });
            }
            break;
        }
>>>>>>> a076549 (latest)
    }
}

async function saveStatus(sock, msg) {
    try {
        const type = getContentType(msg.message);
        const mediaMsg = msg.message.imageMessage || msg.message.videoMessage;
        if (mediaMsg) {
            const stream = await downloadContentFromMessage(mediaMsg, type === 'imageMessage' ? 'image' : 'video');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

            const sender = (msg.key.participant || msg.key.remoteJid).split('@')[0];
            const ext = type === 'imageMessage' ? 'jpg' : 'mp4';
            // Use absolute path to avoid space-in-directory issues
            const statusDir = path.resolve(__dirname, '..', 'media', 'status');
            await fs.ensureDir(statusDir);
            const fileName = path.join(statusDir, `${sender}_${Date.now()}.${ext}`);
            await fs.writeFile(fileName, buffer);

            // Memory cleanup
            if (buffer) {
                buffer.fill(0);
                buffer = null;
            }
        }
    } catch (statusErr) {
        console.log('[STATUS] Failed to save status media:', statusErr.message);
    }
}

module.exports = { handleMessages };

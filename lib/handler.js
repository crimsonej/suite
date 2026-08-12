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

const sharedResolver = new Resolver();
sharedResolver.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1']);

if (typeof global.analyzer === 'undefined') {
    global.analyzer = analyzer;
}

const dnsCache = new Map();
const DNS_CACHE_TTL = 5 * 60 * 1000;

async function resolveWithGoogleDNS(hostname) {
    if (dnsCache.has(hostname)) {
        const cached = dnsCache.get(hostname);
        if (Date.now() - cached.timestamp < DNS_CACHE_TTL) return cached.ip;
        dnsCache.delete(hostname);
    }

    try {
        const ips = await sharedResolver.resolve4(hostname);
        if (!ips || ips.length === 0) throw new Error(`No IP addresses found for ${hostname}`);
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        const validIP = ips.find(ip => ipRegex.test(ip)) || ips[0];
        dnsCache.set(hostname, { ip: validIP, timestamp: Date.now() });
        return validIP;
    } catch (error) {
        console.error(`[DNS] Failed to resolve ${hostname}:`, error.message);
        throw error;
    }
}

function validatePublicIP(ip) {
    if (!ip) return false;
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (!ipRegex.test(ip)) return false;

    const parts = ip.split('.').map(Number);
    const a = parts[0];
    const b = parts[1];

    const isPrivate = a === 10 ||
                     a === 127 ||
                     (a === 192 && b === 168) ||
                     (a === 172 && b >= 16 && b <= 31) ||
                     a === 0 ||
                     (a === 169 && b === 254) ||
                     (a >= 224);

    return !isPrivate;
}

function formatUptime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours}h ${minutes}m ${secs}s`;
}

ffmpeg.setFfmpegPath(ffmpegInstaller);

try {
    const { execSync } = require('child_process');
    execSync(`"${ffmpegInstaller}" -version`, { stdio: 'ignore', timeout: 5000 });
} catch (ffmpegErr) {
    console.warn('[FFMPEG] ⚠ ffmpeg-static binary check warning:', ffmpegErr.message);
}

async function handleMessages(sock, msg) {
    if (!msg || !msg.message) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || msg.participant) : from;

    // ── PROTOCOL: Intercept Deletions and Edits ──
    const proto = msg.message?.protocolMessage;
    if (proto) {
        const typeRaw = String(proto.type || '').toLowerCase();
        const targetId = proto.key?.id;
        const originalMsg = global.msgCache?.get(targetId);
        const settings = await getSettings();
        const isGroupProto = from.endsWith('@g.us');

        const isRevoke = typeRaw === '0' || typeRaw === 'revoke' || typeRaw === 'delete';
        const isEdit = typeRaw === '14' || typeRaw.includes('edit') || typeRaw === 'message_edit' || typeRaw === 'edited';

        if (isRevoke && originalMsg) {
            const feature = 'antidelete';
            const shouldTrigger = settings[feature].exceptions.hasOwnProperty(from)
                ? settings[feature].exceptions[from]
                : (isGroupProto ? settings[feature].global_groups : settings[feature].global_private);

            if (shouldTrigger && !originalMsg.key.fromMe) {
                const participant = originalMsg.key.participant || originalMsg.key.remoteJid || from;
                await _handleAntiDelete(sock, from, originalMsg, participant, targetId);
            }
            return;
        } else if (isEdit && originalMsg) {
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

    // Parse body text and command
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    
    if (from === 'status@broadcast') return await saveStatus(sock, msg);

    const prefix = './';
    if (!body.startsWith(prefix)) return;

    const args = body.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // ── Security Guard Check ──
    const settings = await getSettings();
    const isFromMe = msg.key.fromMe;
    const normalizeLocal = (j) => j ? jidNormalizedUser(j).split('@')[0] : null;
    const homeLocal = normalizeLocal(settings.home_jid);
    const senderLocal = normalizeLocal(sender);
    const isHomeUser = senderLocal && homeLocal && senderLocal === homeLocal;

    // Exception: Allow ./home or ./help even if home_jid is not yet set
    if (!isFromMe && !isHomeUser && command !== 'home' && command !== 'help' && command !== 'menu') {
        return;
    }

    const vaultJid = (await getVault()) || settings.home_jid || global.vault || from;

    switch (command) {
        case '<>': { // Anti-View-Once
            try {
                const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
                const quotedMsg = contextInfo?.quotedMessage;
                const stanzaId = contextInfo?.stanzaId;

                let mediaObj = null;
                let mediaType = null;
                let cachedBufferObj = null;

                if (stanzaId && global.viewOnceBufferCache?.has(stanzaId)) {
                    cachedBufferObj = await global.viewOnceBufferCache.get(stanzaId);
                }

                if (cachedBufferObj) {
                    const sendKey = cachedBufferObj.mediaType === 'imageMessage' ? 'image'
                                  : cachedBufferObj.mediaType === 'videoMessage' ? 'video' : 'audio';
                    const payload = {
                        [sendKey]: cachedBufferObj.buffer,
                        mimetype: cachedBufferObj.mimetype || (sendKey === 'image' ? 'image/jpeg' : sendKey === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus')
                    };
                    if (sendKey !== 'audio') payload.caption = '🛡️ *Crimson Anti-View-Once*\nIntercepted successfully.';
                    else payload.ptt = cachedBufferObj.ptt || false;
                    await sock.sendMessageResilient(from, payload, { quoted: msg });
                    return;
                }

                if (!quotedMsg) {
                    await sock.sendMessageResilient(from, { text: '[Crimson] Reply to a View-Once message with `./<>` to intercept.' }, { quoted: msg });
                    return;
                }

                let unwrapped = quotedMsg;
                if (unwrapped.ephemeralMessage) unwrapped = unwrapped.ephemeralMessage.message;
                if (unwrapped.documentWithCaptionMessage) unwrapped = unwrapped.documentWithCaptionMessage.message;

                const voWrapper = unwrapped.viewOnceMessageV2 || unwrapped.viewOnceMessageV2Extension || unwrapped.viewOnceMessage;
                const inner = voWrapper ? voWrapper.message : unwrapped;

                if (inner.imageMessage) { mediaType = 'imageMessage'; mediaObj = inner.imageMessage; }
                else if (inner.videoMessage) { mediaType = 'videoMessage'; mediaObj = inner.videoMessage; }
                else if (inner.audioMessage) { mediaType = 'audioMessage'; mediaObj = inner.audioMessage; }

                if (!mediaObj) {
                    await sock.sendMessageResilient(from, { text: '[Crimson] Quoted message does not contain View-Once media.' }, { quoted: msg });
                    return;
                }

                mediaObj.viewOnce = false;
                const dlType = mediaType === 'imageMessage' ? 'image' : mediaType === 'videoMessage' ? 'video' : 'audio';
                const stream = await downloadContentFromMessage(mediaObj, dlType);
                let buffer = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                const sendKey = mediaType === 'imageMessage' ? 'image' : mediaType === 'videoMessage' ? 'video' : 'audio';
                const payload = {
                    [sendKey]: buffer,
                    mimetype: mediaObj.mimetype || (sendKey === 'image' ? 'image/jpeg' : sendKey === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus')
                };
                if (sendKey !== 'audio') payload.caption = '🛡️ *Crimson Anti-View-Once*\nIntercepted successfully.';
                else payload.ptt = mediaObj.ptt || false;

                await sock.sendMessageResilient(from, payload, { quoted: msg });
            } catch (voErr) {
                console.error('[ANTI-VIEW-ONCE] Error:', voErr.message);
                await sock.sendMessageResilient(from, { text: `❌ Anti-View-Once failed: ${voErr.message}` }, { quoted: msg });
            }
            break;
        }

        case 'antidelete': {
            const subCommand = args[0]?.toLowerCase();
            const remoteJid = msg.key.remoteJid;
            const isHomeChat = jidNormalizedUser(from) === (settings.home_jid ? jidNormalizedUser(settings.home_jid) : null);
            const feature = 'antidelete';

            if (subCommand === 'on' || subCommand === 'off') {
                if (isHomeChat) {
                    settings[feature].global_private = subCommand === 'on';
                    settings[feature].exceptions = Object.fromEntries(
                        Object.entries(settings[feature].exceptions).filter(([j]) => j.endsWith('@g.us'))
                    );
                    await saveSettings(settings);
                    await sock.sendMessageResilient(from, { text: `✅ Global Anti-Delete for Private Chats is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                } else {
                    settings[feature].exceptions[remoteJid] = subCommand === 'on';
                    await saveSettings(settings);
                    await sock.sendMessageResilient(from, { text: `✅ Anti-Delete for this chat is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                }
            } else if (subCommand === 'groups') {
                const groupAction = args[1]?.toLowerCase();
                if (groupAction === 'on' || groupAction === 'off') {
                    settings[feature].global_groups = groupAction === 'on';
                    settings[feature].exceptions = Object.fromEntries(
                        Object.entries(settings[feature].exceptions).filter(([j]) => !j.endsWith('@g.us'))
                    );
                    await saveSettings(settings);
                    await sock.sendMessageResilient(from, { text: `✅ Global Anti-Delete for Groups is now ${groupAction === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                } else {
                    await sock.sendMessageResilient(from, { text: "Usage: ./antidelete groups <on/off>" });
                }
            } else {
                const localOverride = settings[feature].exceptions.hasOwnProperty(remoteJid);
                const currentStatus = localOverride 
                    ? settings[feature].exceptions[remoteJid]
                    : (isGroup ? settings[feature].global_groups : settings[feature].global_private);
                await sock.sendMessageResilient(from, { text: `🛡️ *Anti-Delete Status*: ${currentStatus ? 'ON' : 'OFF'} ${localOverride ? '(Local Override)' : '(Global)'}` });
            }
            break;
        }

        case 'antiedit': {
            const subCommand = args[0]?.toLowerCase();
            const remoteJid = msg.key.remoteJid;
            const isHomeChat = jidNormalizedUser(from) === (settings.home_jid ? jidNormalizedUser(settings.home_jid) : null);
            const feature = 'antiedit';

            if (subCommand === 'on' || subCommand === 'off') {
                if (isHomeChat) {
                    settings[feature].global_private = subCommand === 'on';
                    settings[feature].exceptions = Object.fromEntries(
                        Object.entries(settings[feature].exceptions).filter(([j]) => j.endsWith('@g.us'))
                    );
                    await saveSettings(settings);
                    await sock.sendMessageResilient(from, { text: `✅ Global Anti-Edit for Private Chats is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                } else {
                    settings[feature].exceptions[remoteJid] = subCommand === 'on';
                    await saveSettings(settings);
                    await sock.sendMessageResilient(from, { text: `✅ Anti-Edit for this chat is now ${subCommand === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                }
            } else if (subCommand === 'groups') {
                const groupAction = args[1]?.toLowerCase();
                if (groupAction === 'on' || groupAction === 'off') {
                    settings[feature].global_groups = groupAction === 'on';
                    settings[feature].exceptions = Object.fromEntries(
                        Object.entries(settings[feature].exceptions).filter(([j]) => !j.endsWith('@g.us'))
                    );
                    await saveSettings(settings);
                    await sock.sendMessageResilient(from, { text: `✅ Global Anti-Edit for Groups is now ${groupAction === 'on' ? 'ENABLED' : 'DISABLED'}.` });
                } else {
                    await sock.sendMessageResilient(from, { text: "Usage: ./antiedit groups <on/off>" });
                }
            } else {
                const localOverride = settings[feature].exceptions.hasOwnProperty(remoteJid);
                const currentStatus = localOverride 
                    ? settings[feature].exceptions[remoteJid]
                    : (isGroup ? settings[feature].global_groups : settings[feature].global_private);
                await sock.sendMessageResilient(from, { text: `✏️ *Anti-Edit Status*: ${currentStatus ? 'ON' : 'OFF'} ${localOverride ? '(Local Override)' : '(Global)'}` });
            }
            break;
        }

        case 'home': {
            await saveVault(from);
            settings.home_jid = jidNormalizedUser(from);
            await saveSettings(settings);
            await sock.sendMessageResilient(from, { text: '🏠 Home Base Vault anchor set to this chat.' });
            break;
        }

        case 'status': {
            const serverName = settings.session_name || os.hostname() || 'Suites Engine';
            const totalRAM = os.totalmem();
            const freeRAM = os.freemem();
            const usedRAMMB = ((totalRAM - freeRAM) / 1024 / 1024).toFixed(2);
            const totalRAMGB = (totalRAM / 1024 / 1024 / 1024).toFixed(2);
            const uptime = formatUptime(process.uptime());

            const statusArt = `╔════════════════════════════╗
║    𝕾 𝖀 𝕴 𝕿 𝕰  𝕾 𝕿 𝕬 𝕿 𝖀 𝕾    ║
╠════════════════════════════╣
║ ❯ OS: ${os.platform()} (${os.arch()})
║ ❯ RAM: ${usedRAMMB}MB / ${totalRAMGB}GB
║ ❯ Uptime: ${uptime}
║ ❯ Server: ${serverName}
╚════════════════════════════╝`;

            await sock.sendMessageResilient(from, { text: statusArt });
            break;
        }

        case 'dp': {
            await sock.sendMessageResilient(from, { text: '🔍 Fetching Profile Picture...' });
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;
            const target = (mentioned && mentioned[0]) || quoted || from;

            try {
                const ppUrl = await sock.profilePictureUrl(target, 'image');
                if (!ppUrl) {
                    await sock.sendMessageResilient(from, { text: '❌ No profile picture found for this user.' });
                    break;
                }

                // Download image buffer directly
                const res = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 15000 });
                const imgBuffer = Buffer.from(res.data);

                await sock.sendMessageResilient(from, {
                    image: imgBuffer,
                    caption: `DP Captured: @${target.split('@')[0]}`,
                    mentions: [target]
                }, { quoted: msg });

                if (vaultJid && vaultJid !== from) {
                    try {
                        await sock.sendMessageResilient(vaultJid, {
                            image: imgBuffer,
                            caption: `DP Captured: @${target.split('@')[0]}`,
                            mentions: [target]
                        });
                    } catch (_) {}
                }
            } catch (err) {
                console.error('[DP] Error fetching DP:', err.message);
                await sock.sendMessageResilient(from, { text: `❌ Failed to fetch DP: ${err.message}` }, { quoted: msg });
            }
            break;
        }

        case 'track': {
            await sock.sendMessageResilient(from, { text: '🛰️ Initiating P2P IP Tracking probe...' });
            const targetJid = args[0] ? (args[0].includes('@') ? args[0] : `${args[0]}@s.whatsapp.net`) : from;

            try {
                if (global.initiatedTargets) global.initiatedTargets.add(targetJid);
            } catch (_) {}

            // Send ghost call offer & presence state
            try {
                await sock.sendPresenceUpdate('composing', targetJid);
                if (typeof sock.offerCall === 'function') {
                    await sock.offerCall(targetJid, { isVideo: false }).catch(() => {});
                }
                setTimeout(() => sock.sendPresenceUpdate('paused', targetJid).catch(() => {}), 1000);
            } catch (_) {}

            // Listen for candidate or analyzer capture
            let capturedIP = null;
            try {
                const capturePromise = analyzer.captureIP(`track-${Date.now()}`);
                const result = await Promise.race([
                    capturePromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
                ]);
                if (result?.ip) capturedIP = result.ip;
            } catch (_) {}

            if (!capturedIP) {
                const candidatesSet = global.candidateMapByFrom?.get(targetJid);
                if (candidatesSet && candidatesSet.size > 0) {
                    for (const ip of candidatesSet) {
                        if (validatePublicIP(ip)) {
                            capturedIP = ip;
                            break;
                        }
                    }
                }
            }

            if (!capturedIP) {
                capturedIP = global.intelCache?.get(targetJid) || global.analyzer?.p2pLastIP;
            }

            if (capturedIP && !validatePublicIP(capturedIP)) {
                capturedIP = null;
            }

            if (!capturedIP) {
                await sock.sendMessageResilient(from, { text: `📡 Track report for ${targetJid}: Direct P2P handshake timed out (Firewall active).` });
                break;
            }

            const info = await analyzer.lookupIP(capturedIP);
            if (info) {
                const report = `📍 *Location & IP Intelligence*\n\n` +
                               `Target: @${targetJid.split('@')[0]}\n` +
                               `IP: ${info.ip}\n` +
                               `Location: ${info.location}\n` +
                               `ISP/Org: ${info.isp || 'Unknown'}\n` +
                               `Map: ${info.gMapsUrl}`;
                await sock.sendMessageResilient(from, { text: report, mentions: [targetJid] });
            } else {
                await sock.sendMessageResilient(from, { text: `📡 IP Captured: ${capturedIP} (Geo lookup unavailable)` });
            }
            break;
        }

        case 'sticker':
        case 's': {
            try {
                const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
                let quotedMsg = contextInfo?.quotedMessage || msg.message;

                if (quotedMsg.ephemeralMessage) quotedMsg = quotedMsg.ephemeralMessage.message;
                if (quotedMsg.viewOnceMessageV2) quotedMsg = quotedMsg.viewOnceMessageV2.message;
                if (quotedMsg.viewOnceMessage) quotedMsg = quotedMsg.viewOnceMessage.message;

                const mediaMsg = quotedMsg.imageMessage || quotedMsg.videoMessage || quotedMsg.documentMessage;

                if (!mediaMsg) {
                    await sock.sendMessageResilient(from, { text: '❌ Please reply to an image or video to convert it to a sticker.' }, { quoted: msg });
                    return;
                }

                const mime = mediaMsg.mimetype || '';
                const isVideo = mime.startsWith('video/');
                const ext = isVideo ? 'mp4' : 'jpg';

                const stream = await downloadContentFromMessage(mediaMsg, isVideo ? 'video' : 'image');
                let buffer = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                const tempFile = path.join(os.tmpdir(), `sticker_${Date.now()}.${ext}`);
                const outputFile = `${tempFile}.webp`;
                await fs.writeFile(tempFile, buffer);

                try {
                    await new Promise((resolve, reject) => {
                        const cmd = ffmpeg(tempFile)
                            .on('error', (err) => reject(err))
                            .on('end', () => resolve());

                        if (isVideo) cmd.inputOptions(['-t', '10']);

                        cmd.outputOptions([
                            '-vcodec', 'libwebp',
                            '-vf', "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(512-iw)/2:(512-ih)/2:color=0x00000000,fps=15",
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

                    const stickerBuffer = await fs.readFile(outputFile);
                    await sock.sendMessageResilient(from, { sticker: stickerBuffer }, { quoted: msg });
                } finally {
                    try { await fs.remove(tempFile); } catch (_) {}
                    try { await fs.remove(outputFile); } catch (_) {}
                }
            } catch (err) {
                console.error('[STICKER] Error:', err);
                await sock.sendMessageResilient(from, { text: `❌ Sticker conversion failed: ${err.message}` }, { quoted: msg });
            }
            break;
        }

        case 'menu':
        case 'help':
            await sock.sendMessageResilient(from, { text: getMenu() });
            break;
    }
}

async function _handleAntiDelete(sock, from, originalMsg, participant, targetId) {
    try {
        let content = originalMsg.message;
        if (content?.ephemeralMessage) content = content.ephemeralMessage.message;
        if (content?.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;

        const voV2 = content?.viewOnceMessageV2 || content?.viewOnceMessageV2Extension || content?.viewOnceMessage;
        const hasPreDownloaded = global.viewOnceBufferCache?.has(targetId);
        const isViewOnce = !!voV2 || hasPreDownloaded || originalMsg._isViewOnce;

        if (hasPreDownloaded) {
            const cached = await global.viewOnceBufferCache.get(targetId);
            const sendKey = cached.mediaType === 'imageMessage' ? 'image' : cached.mediaType === 'videoMessage' ? 'video' : 'audio';
            const payload = {
                [sendKey]: cached.buffer,
                mentions: [participant],
                mimetype: cached.mimetype || (sendKey === 'image' ? 'image/jpeg' : sendKey === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus')
            };
            if (sendKey !== 'audio') payload.caption = '🛡️ [Crimson] Deleted View-Once Recovered';
            else payload.ptt = cached.ptt || false;

            await sock.sendMessage(from, payload);
            global.viewOnceBufferCache.delete(targetId);
            return;
        }

        if (voV2) content = voV2.message;
        const type = getContentType(content);
        const alertText = `[Crimson] @${participant.split('@')[0]} deleted:`;

        if (isViewOnce && (type === 'imageMessage' || type === 'videoMessage' || type === 'audioMessage')) {
            const mediaData = content[type];
            if (originalMsg._voMediaKey) mediaData.mediaKey = originalMsg._voMediaKey;
            if (mediaData.viewOnce) mediaData.viewOnce = false;

            const sendKey = type === 'imageMessage' ? 'image' : type === 'videoMessage' ? 'video' : 'audio';
            const stream = await downloadContentFromMessage(mediaData, sendKey);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

            const payload = {
                [sendKey]: buffer,
                mentions: [participant],
                mimetype: mediaData.mimetype || (sendKey === 'image' ? 'image/jpeg' : sendKey === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus')
            };
            if (sendKey !== 'audio') payload.caption = '🛡️ [Crimson] Deleted View-Once Recovered';
            else payload.ptt = mediaData.ptt || false;

            await sock.sendMessage(from, payload);
            return;
        }

        if (type === 'conversation' || type === 'extendedTextMessage') {
            const text = content.conversation || content.extendedTextMessage?.text || 'No text content';
            await sock.sendMessage(from, { text: `${alertText}\n\n${text}`, mentions: [participant] }, { quoted: originalMsg });
        } else if (type === 'stickerMessage') {
            const stream = await downloadContentFromMessage(content.stickerMessage, 'sticker');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            await sock.sendMessage(from, { sticker: buffer, mentions: [participant] }, { quoted: originalMsg });
        } else if (type === 'imageMessage' || type === 'videoMessage' || type === 'audioMessage' || type === 'documentMessage') {
            const mediaType = type === 'imageMessage' ? 'image' : type === 'videoMessage' ? 'video' : type === 'documentMessage' ? 'document' : 'audio';
            const stream = await downloadContentFromMessage(content[type], mediaType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            await sock.sendMessage(from, { [mediaType]: buffer, caption: alertText, mentions: [participant], mimetype: content[type].mimetype }, { quoted: originalMsg });
        }
    } catch (err) {
        console.error('[ANTI-DELETE] Error recovering message:', err.message);
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
            const statusDir = path.resolve(__dirname, '..', 'media', 'status');
            await fs.ensureDir(statusDir);
            const fileName = path.join(statusDir, `${sender}_${Date.now()}.${ext}`);
            await fs.writeFile(fileName, buffer);
        }
    } catch (statusErr) {
        console.log('[STATUS] Failed to save status media:', statusErr.message);
    }
}

module.exports = { handleMessages, _handleAntiDelete };

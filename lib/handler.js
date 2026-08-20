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
const { logCommand, logEdit } = require('./logger');

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

const SUITE_VERSION = require(path.join(__dirname, '..', 'package.json')).version;

try {
    const { execSync } = require('child_process');
    execSync(`"${ffmpegInstaller}" -version`, { stdio: 'ignore', timeout: 5000 });
} catch (ffmpegErr) {
    console.warn('[FFMPEG] ⚠ ffmpeg-static binary check warning:', ffmpegErr.message);
}

async function downloadWithRetry(content, type, attempts = 3) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            const stream = await downloadContentFromMessage(content, type);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            return buffer;
        } catch (err) {
            lastErr = err;
            if (i < attempts - 1) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        }
    }
    throw lastErr;
}

// ── ./investigate helpers ──
const INVESTIGATE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function decodeEntities(str) {
    return String(str)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

function extractMeta(html, name) {
    const attr = '(?:property|name|itemprop)';
    const re1 = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${name}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (!m) return null;
    try { return decodeEntities(m[1]).slice(0, 300); } catch (_) { return null; }
}

async function fetchPageSummary(url) {
    try {
        const res = await axios.get(url, {
            timeout: 20000,
            maxRedirects: 5,
            responseType: 'text',
            headers: { 'User-Agent': INVESTIGATE_UA, 'Accept-Language': 'en-US,en;q=0.9' },
            validateStatus: () => true
        });
        const html = typeof res.data === 'string' ? res.data : '';
        const finalUrl = res.request?.res?.responseUrl || url;
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        return {
            ok: true,
            status: res.status,
            finalUrl,
            contentType: res.headers['content-type'] || '',
            title: extractMeta(html, 'og:title') || extractMeta(html, 'twitter:title') || (titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 300) : null),
            description: extractMeta(html, 'og:description') || extractMeta(html, 'twitter:description') || extractMeta(html, 'description'),
            site: extractMeta(html, 'og:site_name') || null
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

async function fetchScreenshotBuffer(url) {
    try {
        const mshotRes = await axios.get(`https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=600`, {
            responseType: 'arraybuffer',
            timeout: 20000,
            headers: { 'User-Agent': INVESTIGATE_UA },
            validateStatus: (s) => s >= 200 && s < 300
        });
        const mshotBuf = Buffer.from(mshotRes.data);
        if (mshotBuf.length > 15000) return mshotBuf;
    } catch (_) {}

    try {
        const meta = await axios.get(`https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true`, { timeout: 25000 });
        const shotUrl = meta.data?.data?.screenshot?.url;
        if (shotUrl) {
            const res = await axios.get(shotUrl, {
                responseType: 'arraybuffer',
                timeout: 25000,
                headers: { 'User-Agent': INVESTIGATE_UA },
                validateStatus: (s) => s >= 200 && s < 300
            });
            const buf = Buffer.from(res.data);
            if (buf.length > 2000) return buf;
        }
    } catch (_) {}
    return null;
}

async function resolveHostIPs(hostname) {
    try {
        const ips = await sharedResolver.resolve4(hostname);
        return ips.slice(0, 3);
    } catch (_) { return []; }
}

function buildInvestigateReport(parsedUrl, summary, ips) {
    const lines = [];
    lines.push('🔍 *Investigation Report*');
    lines.push('──────────────────');
    lines.push(`🌐 URL: ${summary?.finalUrl || parsedUrl.href}`);
    if (summary?.title) lines.push(`📌 Title: ${summary.title}`);
    if (summary?.description) lines.push(`📝 Summary: ${summary.description}`);
    if (summary?.site) lines.push(`🏢 Site: ${summary.site}`);
    if (ips?.length) lines.push(`🖥️ IP: ${ips.join(', ')}`);
    if (summary?.ok) {
        lines.push(`🔗 Status: ${summary.status}`);
        if (summary.contentType) lines.push(`📦 Type: ${summary.contentType.split(';')[0]}`);
    } else {
        lines.push(`⚠️ Page fetch: ${summary?.error || 'failed'}`);
    }
    return lines.join('\n');
}

async function handleMessages(sock, msg) {
    if (!msg || !msg.message) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || msg.participant) : from;

    const settings = await getSettings();

    // ── Master switch (./suite off) ──
    // When disabled, everything is paused except ./suite on/off and the tracking system
    if (settings.suite_enabled === false) {
        const bodyCheck = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!bodyCheck.startsWith('./suite') && !bodyCheck.startsWith('./track')) return;
    }

    // ── PROTOCOL: Intercept Deletions and Edits ──
    const proto = msg.message?.protocolMessage;
    if (proto) {
        const typeRaw = String(proto.type || '').toLowerCase();
        const targetId = proto.key?.id;
        const originalMsg = global.msgCache?.get(targetId);
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

                logEdit(sock, from, originalMsg.key.participant || from);

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
    const isFromMe = msg.key.fromMe;
    const normalizeLocal = (j) => j ? jidNormalizedUser(j).split('@')[0] : null;
    const homeLocal = normalizeLocal(settings.home_jid);
    const senderLocal = normalizeLocal(sender);
    const isHomeUser = senderLocal && homeLocal && senderLocal === homeLocal;

    // Exception: Allow ./home or ./help even if home_jid is not yet set
    if (!isFromMe && !isHomeUser && command !== 'home' && command !== 'help' && command !== 'menu') {
        return;
    }

    logCommand(from, command, args);

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
                    const entry = await global.viewOnceBufferCache.get(stanzaId);
                    cachedBufferObj = entry?.promise || null;
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

        case 'suite': {
            const subCommand = args[0]?.toLowerCase();
            if (subCommand === 'on' || subCommand === 'off') {
                settings.suite_enabled = subCommand === 'on';
                await saveSettings(settings);
                await sock.sendMessageResilient(from, {
                    text: settings.suite_enabled
                        ? '🛡️ *Suite ENABLED.* All systems operational.'
                        : '🔕 *Suite DISABLED.* All processing paused. Send `./suite on` to resume.'
                });
            } else {
                await sock.sendMessageResilient(from, {
                    text: `🛡️ *Suite State*: ${settings.suite_enabled ? 'ON' : 'OFF'}\n\nUsage: ./suite <on/off>`
                });
            }
            break;
        }

        case 'status': {
            const serverName = settings.session_name || os.hostname() || 'Suites Engine';
            const totalRAM = os.totalmem();
            const freeRAM = os.freemem();
            const usedRAMMB = ((totalRAM - freeRAM) / 1024 / 1024).toFixed(1);
            const totalRAMGB = (totalRAM / 1024 / 1024 / 1024).toFixed(1);
            const ramPct = Math.round(((totalRAM - freeRAM) / totalRAM) * 100);
            const uptime = formatUptime(process.uptime());

            let diskLine = '❯ Disk      : n/a';
            try {
                const st = fs.statfsSync('/');
                const totalGB = (st.bsize * st.blocks) / 1024 / 1024 / 1024;
                const freeGB = (st.bsize * st.bavail) / 1024 / 1024 / 1024;
                const usedGB = totalGB - freeGB;
                const diskPct = Math.round((1 - st.bavail / st.blocks) * 100);
                diskLine = `❯ Disk      : ${usedGB.toFixed(1)}GB / ${totalGB.toFixed(1)}GB (${diskPct}%)`;
            } catch (_) {}

            let netLine = '❯ Network   : n/a';
            try {
                const ifaces = os.networkInterfaces();
                for (const [name, addrs] of Object.entries(ifaces)) {
                    if (/^(lo|docker|br-|veth|tailscale|virbr|tun)/.test(name)) continue;
                    const v4 = (addrs || []).find(a => a.family === 'IPv4' && !a.internal);
                    if (v4) { netLine = `❯ Interface : ${name}`; break; }
                }
            } catch (_) {}

            const connState = sock?.ws?.isOpen ? '🟢 Connected' : '🔴 Disconnected';

            const statusArt = `╔════════════════════════════════╗
║       ✦ *SUITE STATUS* ✦       ║
╠════════════════════════════════╣
║ ❯ Engine     : v${SUITE_VERSION} · Node ${process.version.slice(1)}
║ ❯ Connection : ${connState}
║ ${netLine}
║ ❯ OS         : ${os.platform()} ${os.arch()}
║ ❯ RAM        : ${usedRAMMB}MB / ${totalRAMGB}GB (${ramPct}%)
║ ${diskLine}
║ ❯ Uptime     : ${uptime}
║ ❯ State      : ${settings.suite_enabled ? '🟢 ON' : '🔴 OFF'}
║ ❯ Server     : ${serverName}
╚════════════════════════════════╝`;

            await sock.sendMessageResilient(from, { text: statusArt });
            break;
        }

        case 'dp': {
            await sock.sendMessageResilient(from, { text: '🔍 Fetching Profile Picture...' });
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;

            // Target resolution: ./dp <number|jid> > ./dp @mention > reply > self
            const argTarget = (args[0] || '').replace(/^\+/, '');
            let target;
            if (/^\d+$/.test(argTarget)) {
                target = `${argTarget}@s.whatsapp.net`;
            } else if (/^[^@\s]+@[^@\s]+$/.test(argTarget)) {
                target = argTarget;
            } else if (mentioned && mentioned[0]) {
                target = mentioned[0];
            } else if (quoted) {
                target = quoted;
            } else {
                target = from;
            }

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

        case 'investigate': {
            const MODE_IMAGE = new Set(['image', 'img', 'shot', 'screenshot', 'pic']);
            const MODE_SUMMARY = new Set(['summary', 'sum', 'text', 'info', 'meta']);

            let urlArg = null;
            let mode = null;

            for (const a of args) {
                const low = a.toLowerCase();
                if (MODE_IMAGE.has(low)) { mode = 'image'; continue; }
                if (MODE_SUMMARY.has(low)) { mode = 'summary'; continue; }
                if (!urlArg) urlArg = a;
            }

            // No URL in args — try the quoted/replied message for one
            if (!urlArg) {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
                const m = quotedText.match(/https?:\/\/[^\s<>"']+/i) || quotedText.match(/[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?:\/[^\s]*)?/);
                if (m) urlArg = m[0];
            }

            if (!urlArg) {
                await sock.sendMessageResilient(from, {
                    text: '🔍 *Investigate* — screenshot + summary of a URL.\n\n' +
                          'Usage:\n' +
                          '• ./investigate <url>\n' +
                          '• ./investigate <url> image|summary\n' +
                          '• ./investigate image|summary (while replying to a message with a link)'
                }, { quoted: msg });
                return;
            }

            let rawUrl = urlArg;
            if (!/^https?:\/\//i.test(rawUrl)) rawUrl = 'https://' + rawUrl;

            let parsed;
            try { parsed = new URL(rawUrl); } catch (_) {}
            const isRestrictedHost = parsed && (
                parsed.hostname === 'localhost' ||
                /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(parsed.hostname)
            );
            if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || isRestrictedHost) {
                await sock.sendMessageResilient(from, { text: `❌ Invalid or restricted URL: ${rawUrl}` }, { quoted: msg });
                return;
            }

            await sock.sendMessageResilient(from, { text: `🔍 Investigating ${parsed.hostname}...\nThis can take 5–25s depending on the site.` }, { quoted: msg });

            let shot = null;
            let summary = null;

            if (mode !== 'summary') {
                shot = await fetchScreenshotBuffer(parsed.href).catch(() => null);
            }
            if (mode !== 'image') {
                const ips = await resolveHostIPs(parsed.hostname);
                summary = await fetchPageSummary(parsed.href);
                summary.ips = ips;
            }

            const reportText = summary
                ? buildInvestigateReport(parsed, summary, summary.ips)
                : `🔍 *Investigation Report*\n🌐 URL: ${parsed.href}`;

            if (mode === 'image') {
                if (shot) {
                    await sock.sendMessageResilient(from, { image: shot, caption: `🔍 Screenshot: ${parsed.href}` }, { quoted: msg });
                } else {
                    await sock.sendMessageResilient(from, { text: `❌ Could not capture a screenshot of ${parsed.href} (provider timeout or block).` }, { quoted: msg });
                }
            } else if (shot) {
                await sock.sendMessageResilient(from, { image: shot, caption: reportText }, { quoted: msg });
            } else {
                await sock.sendMessageResilient(from, { text: `${reportText}\n\n⚠️ Screenshot unavailable.` }, { quoted: msg });
            }
            break;
        }

        case 'track': {
            const { ghostCall } = require('./calls');

            const raw = args[0];
            if (!raw) {
                await sock.sendMessageResilient(from, {
                    text: '🛰️ *Track* — P2P IP intelligence via ghost call.\n\n' +
                          'Usage:\n' +
                          '• ./track <number>\n' +
                          '• ./track <jid> (@s.whatsapp.net / @lid)',
                    quoted: msg
                });
                break;
            }

            const targetJid = raw.includes('@') ? raw : `${raw.replace(/^\+/, '')}@s.whatsapp.net`;
            const lidForm = global.pnToLid?.get(targetJid);

            const validate = (ip) => validatePublicIP(ip);
            const isPublicCand = (ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && validate(ip);

            // ── 1) Cached intel? Report without ringing ──
            let cachedIP = analyzer.getIntel(targetJid) || (lidForm && analyzer.getIntel(lidForm));
            if (cachedIP && isPublicCand(cachedIP)) {
                const cachedInfo = await analyzer.lookupIP(cachedIP);
                const cachedReport = `📍 *Location & IP Intelligence*\n\n` +
                    `Target: @${targetJid.split('@')[0]}\n` +
                    `IP: ${cachedIP} *(cached)*\n` +
                    `Location: ${cachedInfo?.location || 'Unknown'}\n` +
                    `Region: ${cachedInfo?.region || '—'}\n` +
                    `Timezone: ${cachedInfo?.timezone || '—'}\n` +
                    `ISP/Org: ${cachedInfo?.isp || 'Unknown'}\n` +
                    `ASN: ${cachedInfo?.asn || '—'}\n` +
                    `Map: ${cachedInfo?.gMapsUrl || '—'}`;
                await sock.sendMessageResilient(from, { text: cachedReport, mentions: [targetJid] });
                break;
            }

            // ── 2) Cooldown guard (60s per target) ──
            const now = Date.now();
            const lastProbe = global.trackCooldown?.get(targetJid) || 0;
            if (now - lastProbe < 60000) {
                const waitSec = Math.ceil((60000 - (now - lastProbe)) / 1000);
                await sock.sendMessageResilient(from, { text: `⏳ Cooldown for ${targetJid} — retry in ${waitSec}s.` });
                break;
            }
            (global.trackCooldown ||= new Map()).set(targetJid, now);

            // ── 3) Fire ghost call probe ──
            await sock.sendMessageResilient(from, { text: `🛰️ Probing @${targetJid.split('@')[0]} with a ghost call...\n\nTheir phone will ring briefly — the P2P handshake reveals their IP.`, mentions: [targetJid] });
            try {
                await sock.sendPresenceUpdate('composing', targetJid);
                const cid = await ghostCall(sock, targetJid);
                console.log(`[TRACK] Ghost call sent to ${targetJid} (call-id: ${cid})`);
                global.callIdToTarget?.set(cid, targetJid);
                try {
                    global.initiatedTargets.add(targetJid);
                    setTimeout(() => global.initiatedTargets.delete(targetJid), 30000);
                } catch (_) {}
            } catch (err) {
                await sock.sendMessageResilient(from, { text: `❌ Ghost call failed: ${err.message}` });
                break;
            }

            // ── 4) Wait up to 15s for candidates (waiter + polling) ──
            const pollForIP = (jid, timeoutMs) => new Promise((resolve, reject) => {
                const start = Date.now();
                const iv = setInterval(() => {
                    const set = global.candidateMapByFrom?.get(jid);
                    if (set) {
                        for (const ip of set) {
                            if (isPublicCand(ip)) { clearInterval(iv); resolve(ip); return; }
                        }
                    }
                    if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('timeout')); }
                }, 400);
            });

            let capturedIP = null;
            try {
                capturedIP = await Promise.race([
                    analyzer.waitForIP(cid, 15000),
                    pollForIP(targetJid, 15000)
                ]);
                if (capturedIP && !isPublicCand(capturedIP)) capturedIP = null;
            } catch (_) {}

            // ── 5) Fallbacks: candidate maps (incl. LID form) ──
            if (!capturedIP) {
                const set = global.candidateMapByFrom?.get(targetJid);
                if (set) for (const ip of set) if (isPublicCand(ip)) { capturedIP = ip; break; }
            }
            if (!capturedIP && lidForm) {
                const lidSet = global.candidateMapByFrom?.get(lidForm);
                if (lidSet) for (const ip of lidSet) if (isPublicCand(ip)) { capturedIP = ip; break; }
            }

            if (!capturedIP) {
                await sock.sendMessageResilient(from, {
                    text: `📡 Track report for @${targetJid.split('@')[0]}: no P2P handshake — target protected by relay/firewall.\n\nKnown intel will be used automatically if available later.`,
                    mentions: [targetJid]
                });
                break;
            }

            // ── 6) Persist intel + geo report ──
            analyzer.registerIntel(targetJid, capturedIP);
            if (lidForm) analyzer.registerIntel(lidForm, capturedIP);

            const info = await analyzer.lookupIP(capturedIP);
            if (info) {
                const report = `📍 *Location & IP Intelligence*\n\n` +
                    `Target: @${targetJid.split('@')[0]}\n` +
                    `IP: ${info.ip}\n` +
                    `Location: ${info.location}\n` +
                    `Region: ${info.region || '—'}\n` +
                    `Timezone: ${info.timezone || '—'}\n` +
                    `ISP/Org: ${info.isp || 'Unknown'}\n` +
                    `ASN: ${info.asn || '—'}\n` +
                    `Map: ${info.gMapsUrl}`;
                await sock.sendMessageResilient(from, { text: report, mentions: [targetJid] });
            } else {
                await sock.sendMessageResilient(from, { text: `📡 IP Captured: ${capturedIP} (Geo lookup unavailable)` });
            }
            break;
        }

        case 's': {
            try {
                const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
                let quotedMsg = contextInfo?.quotedMessage;

                // Groups often don't embed the quoted content — fall back to our message cache
                if (!quotedMsg && contextInfo?.stanzaId) {
                    const cached = global.msgCache?.get(contextInfo.stanzaId);
                    if (cached?.message) quotedMsg = cached.message;
                }
                if (!quotedMsg) quotedMsg = msg.message;

                if (quotedMsg.ephemeralMessage) quotedMsg = quotedMsg.ephemeralMessage.message;
                if (quotedMsg.viewOnceMessageV2) quotedMsg = quotedMsg.viewOnceMessageV2.message;
                if (quotedMsg.viewOnceMessage) quotedMsg = quotedMsg.viewOnceMessage.message;
                if (quotedMsg.documentWithCaptionMessage) quotedMsg = quotedMsg.documentWithCaptionMessage.message;

                const mediaMsg = quotedMsg.imageMessage || quotedMsg.videoMessage || quotedMsg.documentMessage;

                if (!mediaMsg) {
                    await sock.sendMessageResilient(from, { text: '❌ Please reply to an image or video to convert it to a sticker.' }, { quoted: msg });
                    return;
                }

                const mime = mediaMsg.mimetype || '';
                const isVideo = mime.startsWith('video/');
                const isImage = mime.startsWith('image/');
                if (!isVideo && !isImage) {
                    await sock.sendMessageResilient(from, { text: `❌ Unsupported media type (${mime || 'unknown'}). Reply to an image or video.` }, { quoted: msg });
                    return;
                }
                const ext = isVideo ? 'mp4' : (mime === 'image/png' ? 'png' : 'jpg');

                const buffer = await downloadWithRetry(mediaMsg, isVideo ? 'video' : 'image');

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

        case 'delete': {
            const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
            const targets = settings.autodelete?.targets || (settings.autodelete = { targets: [] }).targets;

            const normalizeTarget = (raw) => {
                if (!raw) return null;
                const clean = String(raw).replace(/^\+/, '');
                if (/^\d+$/.test(clean)) return `${clean}@s.whatsapp.net`;
                if (/^[^@\s]+@[^@\s]+$/.test(String(raw))) return String(raw);
                return null;
            };

            let action = null;
            let targetRaw = null;
            for (const a of args) {
                const low = a.toLowerCase();
                if (low === 'on' || low === 'off') { action = low; continue; }
                if (low === 'list') { action = 'list'; continue; }
                if (!targetRaw) targetRaw = a;
            }

            if (action === 'list') {
                const listText = targets.length
                    ? targets.map((t, i) => `${i + 1}. ${t}`).join('\n')
                    : 'No targets set.';
                await sock.sendMessageResilient(from, { text: `🗑 *Auto-Delete Targets*\n\n${listText}\n\nOnly works in groups where you are admin.` });
                break;
            }

            if (!action && targetRaw) action = 'on';
            if (!targetRaw && quotedParticipant && (action === 'on' || action === 'off')) targetRaw = quotedParticipant;

            if (!action || !targetRaw) {
                await sock.sendMessageResilient(from, {
                    text: '🗑 *Auto-Delete* — instantly removes any message a target sends (groups, admin required).\n\n' +
                          'Usage:\n' +
                          '• ./delete <number|jid> on|off\n' +
                          '• ./delete on|off (reply to the target\'s message)\n' +
                          '• ./delete list'
                }, { quoted: msg });
                break;
            }

            const target = normalizeTarget(targetRaw);
            if (!target) {
                await sock.sendMessageResilient(from, { text: `❌ Invalid target: ${targetRaw}` }, { quoted: msg });
                break;
            }

            const idx = targets.indexOf(target);
            if (action === 'on') {
                if (idx === -1) targets.push(target);
                await saveSettings(settings);
                await sock.sendMessageResilient(from, { text: `✅ Auto-delete ENABLED for ${target}\n\nTheir messages will be removed instantly in any group where you are admin.` }, { quoted: msg });
            } else {
                if (idx !== -1) targets.splice(idx, 1);
                await saveSettings(settings);
                await sock.sendMessageResilient(from, { text: `✅ Auto-delete DISABLED for ${target}` }, { quoted: msg });
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
            const entry = await global.viewOnceBufferCache.get(targetId);
            const cached = entry?.promise || null;

            if (cached) {
                const sendKey = cached.mediaType === 'imageMessage' ? 'image' : cached.mediaType === 'videoMessage' ? 'video' : 'audio';
                const payload = {
                    [sendKey]: cached.buffer,
                    mentions: [participant],
                    mimetype: cached.mimetype || (sendKey === 'image' ? 'image/jpeg' : sendKey === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus')
                };
                if (sendKey !== 'audio') payload.caption = '🛡️ [Crimson] Deleted View-Once Recovered';
                else payload.ptt = cached.ptt || false;

                await sock.sendMessageResilient(from, payload);
                global.viewOnceBufferCache.delete(targetId);
                return;
            }
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

            await sock.sendMessageResilient(from, payload);
            return;
        }

        if (type === 'conversation' || type === 'extendedTextMessage') {
            const text = content.conversation || content.extendedTextMessage?.text || 'No text content';
            await sock.sendMessageResilient(from, { text: `${alertText}\n\n${text}`, mentions: [participant] }, { quoted: originalMsg });
        } else if (type === 'stickerMessage') {
            const stream = await downloadContentFromMessage(content.stickerMessage, 'sticker');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            await sock.sendMessageResilient(from, { sticker: buffer, mentions: [participant] }, { quoted: originalMsg });
        } else if (type === 'imageMessage' || type === 'videoMessage' || type === 'audioMessage' || type === 'documentMessage') {
            const mediaType = type === 'imageMessage' ? 'image' : type === 'videoMessage' ? 'video' : type === 'documentMessage' ? 'document' : 'audio';
            const stream = await downloadContentFromMessage(content[type], mediaType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            await sock.sendMessageResilient(from, { [mediaType]: buffer, caption: alertText, mentions: [participant], mimetype: content[type].mimetype }, { quoted: originalMsg });
        } else {
            // Contacts, locations, polls, lists, buttons, etc.
            await sock.sendMessageResilient(from, { forward: originalMsg }, { quoted: originalMsg });
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

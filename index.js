const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    getContentType,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs-extra');
const path = require('path');
const dns = require('dns').promises;
const { Resolver } = require('dns').promises;
const qrcode = require('qrcode-terminal');
const { handleMessages } = require('./lib/handler');
const analyzer = require('./lib/analyzer');

const AUTH_FOLDER = path.resolve(__dirname, 'session_auth');

global.botStartTime = Math.floor(Date.now() / 1000);
global.lastMessageWithIP = null;
global.intelCache = new Map();
global.analyzer = analyzer;
global.msgCache = new Map();
global.viewOnceBufferCache = new Map();

// Shared DNS resolver using public DNS servers
const sharedResolver = new Resolver();
const dnsServers = process.env.DNS_SERVERS ? process.env.DNS_SERVERS.split(',') : ['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1'];
sharedResolver.setServers(dnsServers);

// ── Reconnect state ──
let _isConnecting = false;
let isConnected = false;
let _retryCount = 0;
const MAX_RETRIES = 15;
let sock = null;

function isBadMacError(err) {
    const msg = (err?.message || '').toLowerCase();
    return msg.includes('bad mac') || msg.includes('decrypt') || msg.includes('failed to decrypt') || msg.includes('libsignal');
}

async function cleanupSocket() {
    if (!sock) return;
    try { sock.ev.removeAllListeners(); } catch (_) {}
    try { sock.ws?.terminate?.() || sock.ws?.close?.(); } catch (_) {}
    try { sock.end?.(); } catch (_) {}
    sock = null;
}

async function handleBadMacError(err) {
    console.error('[SECURITY] Bad MAC / decryption failure detected:', err.message);
    console.error('[SECURITY] Attempting soft restart without clearing session.');
    await cleanupSocket();
    _retryCount = 0;
    setTimeout(startSuite, 3000);
}

function getReconnectDelay() {
    return Math.min(5000 * Math.pow(2, _retryCount), 60000);
}

async function waitForDNS(hostname, maxAttempts = 10) {
    for (let i = 1; i <= maxAttempts; i++) {
        try {
            const ips = await sharedResolver.resolve4(hostname);
            if (ips && ips.length) {
                console.log(`[DNS] ✓ ${hostname} resolved to ${ips[0]}`);
                return true;
            }
        } catch (err) {
            try {
                await dns.lookup(hostname);
                return true;
            } catch (_) {}
        }
        if (i < maxAttempts) await new Promise(r => setTimeout(r, 5000));
    }
    return false;
}

async function nukeSession() {
    console.log('[SESSION] Logged out — clearing session for fresh QR...');
    try { await fs.remove(AUTH_FOLDER); } catch (_) {}
}

function registerSocketEvents(sock) {
    if (!sock || !sock.ev) return;

    // ── Connection lifecycle ──
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !isConnected) {
            console.clear();
            console.log('╬══════════════════════════════════════╬');
            console.log('║  Scan the QR code below to connect:  ║');
            console.log('╚══════════════════════════════════════╝');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            _retryCount   = 0;
            _isConnecting = false;
            isConnected   = true;
            global.vault  = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const platform = process.env.TERMUX_VERSION ? 'Termux' : 'Linux/Parrot';
            console.log(`[SUCCESS] Crimson Suite is Live — Platform: ${platform}`);
            try { await sock.sendMessage(global.vault, { text: '🛡️ Suites Engine: Online. Vault operational.' }); } catch (_) {}
        }

        if (connection === 'close') {
            _isConnecting = false;
            isConnected   = false;
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode || error?.data || (error instanceof Boom ? error.output.statusCode : 0);
            const msg = error?.message || '';

            if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
                console.log('[CONN] Soft restart required (515). Reconnecting in 3s for filesystem flush...');
                setTimeout(startSuite, 3000);
                return;
            }

            console.log(`[CONN] Connection closed. Status: ${statusCode}, Message: ${msg}`);

            if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                console.log('[CONN] 🔴 Logged out (401). Clearing session for fresh QR...');
                await nukeSession();
                _retryCount = 0;
                setTimeout(startSuite, 3000);
                return;
            }

            if (_retryCount < MAX_RETRIES) {
                _retryCount++;
                const delay = getReconnectDelay();
                console.log(`[CONN] 🟡 Reconnecting in ${Math.ceil(delay / 1000)}s (attempt ${_retryCount}/${MAX_RETRIES})...`);
                setTimeout(startSuite, delay);
            } else {
                console.log('[CONN] 🔴 Max retries reached. Cooling down 5 minutes...');
                _retryCount = 0;
                setTimeout(startSuite, 300000);
            }
        }
    });

    // ── Message pipeline ──
    const processedMessages = new Set();
    sock.ev.removeAllListeners('messages.upsert');
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const tasks = messages
            .filter(msg => msg.message)
            .map(async (msg) => {
                // ── Deduplication: 5s cache ──
                if (processedMessages.has(msg.key.id)) return;
                processedMessages.add(msg.key.id);
                setTimeout(() => processedMessages.delete(msg.key.id), 5000);

                try {
                    const from = msg.key.remoteJid;


                    if (!msg.message.protocolMessage) {
                        try {
                            const cloned = JSON.parse(JSON.stringify(msg));
                            global.msgCache.set(msg.key.id, cloned);

                            let voMediaObj  = null;
                            let voMediaType = null;
                            const msgContent = msg.message;

                            const checkVO = (obj) => {
                                if (!obj) return null;
                                if (obj.viewOnceMessageV2)          return { wrapper: obj.viewOnceMessageV2 };
                                if (obj.viewOnceMessageV2Extension) return { wrapper: obj.viewOnceMessageV2Extension };
                                if (obj.viewOnceMessage)            return { wrapper: obj.viewOnceMessage };
                                return null;
                            };

                            const voInfo = checkVO(msgContent) || checkVO(msgContent?.ephemeralMessage?.message);

                            if (voInfo?.wrapper?.message) {
                                const inner = voInfo.wrapper.message;
                                voMediaType = inner.imageMessage ? 'imageMessage'
                                            : inner.videoMessage ? 'videoMessage'
                                            : inner.audioMessage ? 'audioMessage' : null;
                                if (voMediaType) voMediaObj = inner[voMediaType];
                            }

                            if (!voMediaObj) {
                                const c = msgContent?.ephemeralMessage?.message || msgContent;
                                if      (c?.imageMessage?.viewOnce) { voMediaObj = c.imageMessage; voMediaType = 'imageMessage'; }
                                else if (c?.videoMessage?.viewOnce) { voMediaObj = c.videoMessage; voMediaType = 'videoMessage'; }
                                else if (c?.audioMessage?.viewOnce) { voMediaObj = c.audioMessage; voMediaType = 'audioMessage'; }
                            }

                            if (voMediaObj && voMediaType) {
                                cloned._isViewOnce  = true;
                                cloned._voMediaType = voMediaType;
                                cloned._voMediaKey  = voMediaObj.mediaKey;
                                global.msgCache.set(msg.key.id, cloned);

                                const dlType = voMediaType === 'imageMessage' ? 'image' : voMediaType === 'videoMessage' ? 'video' : 'audio';
                                const downloadPromise = (async () => {
                                    const stream = await downloadContentFromMessage(voMediaObj, dlType);
                                    let buffer   = Buffer.from([]);
                                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                                    return { buffer, mediaType: voMediaType, mimetype: voMediaObj.mimetype, ptt: voMediaObj.ptt || false };
                                })();
                                global.viewOnceBufferCache.set(msg.key.id, downloadPromise);
                            }
                        } catch (_) {
                            global.msgCache.set(msg.key.id, msg);
                        }
                    }

                    const protoType = msg.message?.protocolMessage?.type;
                    if (protoType === 0 || protoType === 14 || protoType === 'REVOKE') {
                        const targetId   = msg.message.protocolMessage.key.id;
                        const originalMsg = global.msgCache.get(targetId);
                        if (!originalMsg || originalMsg.key.fromMe) return;

                        const { getSettings } = require('./lib/settings');
                        const settings   = await getSettings();
                        const isGroup    = from.endsWith('@g.us');
                        const adSettings = settings.antidelete;
                        const shouldTrigger = adSettings.exceptions.hasOwnProperty(from)
                            ? adSettings.exceptions[from]
                            : (isGroup ? adSettings.global_groups : adSettings.global_private);
                        if (!shouldTrigger) return;

                        const participant = originalMsg.key.participant || originalMsg.key.remoteJid || from;
                        await _handleAntiDelete(sock, from, originalMsg, participant, targetId);
                        return;
                    }

                    try {
                        if (msg.key.fromMe && from !== 'status@broadcast') {
                            const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                            if (body.startsWith('./')) {
                                await sock.sendPresenceUpdate('composing', from);
                                setTimeout(() => sock.sendPresenceUpdate('paused', from).catch(() => {}), 1500);
                            }
                        }
                    } catch (_) {}

                    try {
                        await handleMessages(sock, msg);
                    } catch (handlerErr) {
                        if (isBadMacError(handlerErr)) await handleBadMacError(handlerErr);
                    }
                } catch (msgErr) {
                    if (isBadMacError(msgErr)) await handleBadMacError(msgErr);
                }
            });

        await Promise.allSettled(tasks);
    });

    sock.ev.on('call', async (node) => {
        const call = node[0];
        const from = call.from;

        if (call.status === 'offer') {
            try {
                const callStr  = JSON.stringify(node);
                const ipMatches = callStr.match(/\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g);
                if (ipMatches?.length) {
                    let publicIP = null, privateIP = null;
                    for (const ip of ipMatches) {
                        const [a, b] = ip.split('.').map(Number);
                        const isPrivate = a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
                        if (!isPrivate && !publicIP) publicIP  = ip;
                        else if (isPrivate && !privateIP) privateIP = ip;
                    }
                    const capturedIP = publicIP || privateIP;
                    if (capturedIP) {
                        global.intelCache.set(from, capturedIP);
                        global.analyzer.p2pLastIP = capturedIP;
                        try { await sock.rejectCall(call.id, from); } catch (_) {}
                    }
                }
            } catch (_) {}
        }
        const analyzerFn = require('./lib/analyzer').analyzer;
        await analyzerFn(sock, node);
    });
}

async function _handleAntiDelete(sock, from, originalMsg, participant, targetId) {
    try {
        let content = originalMsg.message;
        if (content?.ephemeralMessage)           content = content.ephemeralMessage.message;
        if (content?.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message;

        const voV2            = content?.viewOnceMessageV2 || content?.viewOnceMessageV2Extension || content?.viewOnceMessage;
        const hasPreDownloaded = global.viewOnceBufferCache.has(targetId);
        const hasTag           = originalMsg._isViewOnce || originalMsg._voMediaType != null;
        const isViewOnce       = !!voV2 || hasPreDownloaded || hasTag;

        if (hasPreDownloaded) {
            const cached  = await global.viewOnceBufferCache.get(targetId);
            const sendKey = cached.mediaType === 'imageMessage' ? 'image' : cached.mediaType === 'videoMessage' ? 'video' : 'audio';
            const payload = {
                [sendKey]  : cached.buffer,
                mentions   : [participant],
                mimetype   : cached.mimetype || (sendKey === 'image' ? 'image/jpeg' : sendKey === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus')
            };
            if (sendKey !== 'audio') payload.caption = '🛡️ [Crimson] Deleted View-Once Recovered';
            else                     payload.ptt     = cached.ptt || false;
            await sock.sendMessage(from, payload);
            global.viewOnceBufferCache.delete(targetId);
            return;
        }

        if (voV2) content = voV2.message;
        const type      = getContentType(content);
        const alertText = `[Crimson] @${participant.split('@')[0]} deleted:`;

        if (isViewOnce && (type === 'imageMessage' || type === 'videoMessage' || type === 'audioMessage')) {
            const mediaData = content[type];
            if (originalMsg._voMediaKey) mediaData.mediaKey = originalMsg._voMediaKey;
            if (mediaData.viewOnce)      mediaData.viewOnce = false;
            const sendKey = type === 'imageMessage' ? 'image' : type === 'videoMessage' ? 'video' : 'audio';
            const stream  = await downloadContentFromMessage(mediaData, sendKey);
            let buffer    = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            const payload = {
                [sendKey]: buffer,
                mentions : [participant],
                mimetype : mediaData.mimetype || (sendKey === 'image' ? 'image/jpeg' : sendKey === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus')
            };
            if (sendKey !== 'audio') payload.caption = '🛡️ [Crimson] Deleted View-Once Recovered';
            else                     payload.ptt     = mediaData.ptt || false;
            await sock.sendMessage(from, payload);
            return;
        }

        if (type === 'conversation' || type === 'extendedTextMessage') {
            const text = content.conversation || content.extendedTextMessage?.text || 'No text content';
            await sock.sendMessage(from, { text: `${alertText}\n\n${text}`, mentions: [participant] }, { quoted: originalMsg });
        } else if (type === 'stickerMessage') {
            const stream = await downloadContentFromMessage(content.stickerMessage, 'sticker');
            let buffer   = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            await sock.sendMessage(from, { sticker: buffer, mentions: [participant] }, { quoted: originalMsg });
        } else if (type === 'imageMessage' || type === 'videoMessage' || type === 'audioMessage' || type === 'documentMessage') {
            const mediaType = type === 'imageMessage' ? 'image' : type === 'videoMessage' ? 'video' : type === 'documentMessage' ? 'document' : 'audio';
            const stream    = await downloadContentFromMessage(content[type], mediaType);
            let buffer      = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            await sock.sendMessage(from, { [mediaType]: buffer, caption: alertText, mentions: [participant], mimetype: content[type].mimetype }, { quoted: originalMsg });
        }
    } catch (err) {}
}

async function startSuite() {
    if (_isConnecting) return;
    _isConnecting = true;

    try {
        const P = require('pino');
        const logger = P({ level: 'silent' });
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();

        await cleanupSocket();
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            version,
            logger,
            qrTimeout: 3600000,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: false,
            msgRetryCounter: 5,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 5,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            browser: ['Suites', 'Chrome', '10.0.0'],
            transactionOpts: { maxCommitRetries: 5, delayBetweenTriesMs: 2000 }
        });

        registerSocketEvents(sock);

        // ── Aggressive credential saving ──
        sock.ev.on('creds.update', saveCreds);

        sock.sendMessageResilient = async (jid, content) => {
            try {
                return await sock.sendMessage(jid, content);
            } catch (err) {
                if (err?.output?.statusCode === 428) {
                    await new Promise(r => setTimeout(r, 2000));
                    return await sock.sendMessage(jid, content);
                }
                throw err;
            }
        };

        const { initScheduler } = require('./lib/scheduler');
        initScheduler(sock);

        return sock;
    } catch (err) {
        _isConnecting = false;
        _retryCount++;
        setTimeout(startSuite, getReconnectDelay());
    }
}

process.on('uncaughtException', (err) => {
    if (err.message?.includes('Connection Failure') || err.message?.includes('noise')) {
        _isConnecting = false;
        setTimeout(startSuite, 5000);
    }
});

process.on('unhandledRejection', (reason) => {});

console.log('[DEBUG] Starting Crimson Engine...');
startSuite();

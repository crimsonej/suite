// ── DNS reliability patch (must run before net.js loads) ──
// The system resolver (resolv.conf) is flaky on this network and throws
// EAI_AGAIN during WebSocket connects. Route all socket lookups through
// c-ares using the local router + public DNS, verified 8/8 reliable.
const dnsMod = require('dns');
const { Resolver } = require('dns').promises;
const _origLookup = dnsMod.lookup;
const _dnsServers = process.env.DNS_SERVERS ? process.env.DNS_SERVERS.split(',') : ['192.168.1.1', '8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1'];
const _reliableResolver = new Resolver();
try { _reliableResolver.setServers(_dnsServers); } catch (_) {}
dnsMod.lookup = function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof options === 'number') { options = { family: options }; }
    const all = !!(options && options.all);
    const family = options && options.family;
    const query = family === 6
        ? _reliableResolver.resolve6(hostname).catch(() => _reliableResolver.resolve4(hostname))
        : _reliableResolver.resolve4(hostname);
    query.then(ips => {
        if (all) return callback(null, ips.map(ip => ({ address: ip, family: family === 6 ? 6 : 4 })));
        callback(null, ips[0], family === 6 ? 6 : 4);
    }).catch(err => {
        if (all) return callback(err);
        callback(err);
    });
};

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    getContentType,
    downloadContentFromMessage,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs-extra');
const path = require('path');
const dns = require('dns').promises;
const qrcode = require('qrcode-terminal');
const { handleMessages, _handleAntiDelete } = require('./lib/handler');
const analyzer = require('./lib/analyzer');
const axios = require('axios');
const { getSettings } = require('./lib/settings');
const { getVault } = require('./lib/vault');
const { logMessage, logDeletion } = require('./lib/logger');

const AUTH_FOLDER = path.resolve(__dirname, 'session_auth');

global.botStartTime = Math.floor(Date.now() / 1000);
global.lastMessageWithIP = null;
global.intelCache = new Map();
global.analyzer = analyzer;
global.msgCache = new Map();
global.viewOnceBufferCache = new Map();

// Candidate maps for P2P handshake tracking
global.candidateMapByCallId = new Map();
global.candidateMapByFrom = new Map();
global.initiatedTargets = new Set();

// Cache size limiter for memory protection (max 3000 messages)
const MAX_MSG_CACHE_SIZE = 3000;
function safeCacheMessage(id, msg) {
    if (global.msgCache.size >= MAX_MSG_CACHE_SIZE) {
        const firstKey = global.msgCache.keys().next().value;
        global.msgCache.delete(firstKey);
    }
    global.msgCache.set(id, msg);
}

// Shared DNS resolver using verified-reliable servers
const sharedResolver = new Resolver();
const dnsServers = _dnsServers;
sharedResolver.setServers(dnsServers);

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

async function notifyVaultDeletion(sock, chatJid, participant, originalMsg, isGroup, suppressed) {
    try {
        const vaultJid = (await getVault()) || global.vault;
        if (!vaultJid || vaultJid === chatJid) return;

        let type = 'unknown';
        try { type = getContentType(originalMsg.message) || 'unknown'; } catch (_) {}
        const text = originalMsg.message?.conversation || originalMsg.message?.extendedTextMessage?.text || '';
        const content = text ? `\nContent: ${text.slice(0, 300)}` : '';

        await sock.sendMessage(vaultJid, {
            text: `${suppressed ? '🚫 *Suppressed deletion*' : '🛡️ *Deletion recovered*'} in ${isGroup ? 'group' : 'private chat'} — @${participant.split('@')[0]}\nType: ${type}${content}`
        });
    } catch (_) {}
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
                if (processedMessages.has(msg.key.id)) return;
                processedMessages.add(msg.key.id);
                setTimeout(() => processedMessages.delete(msg.key.id), 5000);

                try {
                    const from = msg.key.remoteJid;
                    logMessage(sock, msg).catch(() => {});

                    if (!msg.message.protocolMessage) {
                        try {
                            const cloned = JSON.parse(JSON.stringify(msg));
                            safeCacheMessage(msg.key.id, cloned);

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
                                safeCacheMessage(msg.key.id, cloned);

                                const dlType = voMediaType === 'imageMessage' ? 'image' : voMediaType === 'videoMessage' ? 'video' : 'audio';
                                const downloadPromise = (async () => {
                                    const stream = await downloadContentFromMessage(voMediaObj, dlType);
                                    let buffer   = Buffer.from([]);
                                    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                                    return { buffer, mediaType: voMediaType, mimetype: voMediaObj.mimetype, ptt: voMediaObj.ptt || false };
                                })();
                                global.viewOnceBufferCache.set(msg.key.id, { ts: Date.now(), promise: downloadPromise });
                            }
                        } catch (_) {
                            safeCacheMessage(msg.key.id, msg);
                        }
                    }

                    const protoType = msg.message?.protocolMessage?.type;
                    const isRevoke = protoType === 0 || protoType === 'REVOKE';

                    if (isRevoke) {
                        const targetId = msg.message.protocolMessage.key.id;
                        const originalMsg = global.msgCache.get(targetId);
                        if (!originalMsg || originalMsg.key.fromMe) return;

                        const settings   = await getSettings();
                        if (settings.suite_enabled === false) return;
                        const isGroup    = from.endsWith('@g.us');
                        const adSettings = settings.antidelete;
                        const shouldTrigger = adSettings.exceptions.hasOwnProperty(from)
                            ? adSettings.exceptions[from]
                            : (isGroup ? adSettings.global_groups : adSettings.global_private);

                        const participant = originalMsg.key.participant || originalMsg.key.remoteJid || from;
                        logDeletion(from, participant, !shouldTrigger);
                        notifyVaultDeletion(sock, from, participant, originalMsg, isGroup, !shouldTrigger);

                        if (!shouldTrigger) return;

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

    // ── Unified Call & WebRTC Candidate Handler ──
    sock.ev.on('call', async (calls) => {
        const callList = Array.isArray(calls) ? calls : [calls];

        for (const call of callList) {
            const { from, id, status, content } = call;
            console.log(`[CALL] Call ID: ${id} | Status: ${status} | From: ${from}`);
            
            if (content && Array.isArray(content)) {
                for (const stanza of content) {
                    if (stanza.tag === 'candidate' && stanza.attrs && stanza.attrs.ip) {
                        const ip = stanza.attrs.ip;
                        console.log(`[CALL] IP Candidate captured: ${ip}`);
                        
                        const callSet = global.candidateMapByCallId.get(id) || new Set();
                        callSet.add(ip);
                        global.candidateMapByCallId.set(id, callSet);
                        
                        const fromSet = global.candidateMapByFrom.get(from) || new Set();
                        fromSet.add(ip);
                        global.candidateMapByFrom.set(from, fromSet);
                    }
                }
            }

            if (status === 'offer') {
                if (global.initiatedTargets.has(from)) {
                    global.initiatedTargets.delete(from);
                    console.log(`[CALL] Outgoing ghost call offer accepted, rejecting call in 2s`);
                    setTimeout(async () => {
                        try { await sock.rejectCall(id, from); } catch (_) {}
                    }, 2000);
                }
            }
        }

        try {
            const settings = await getSettings();
            if (settings.suite_enabled === false) return;
            const analyzerFn = require('./lib/analyzer').analyzer;
            await analyzerFn(sock, callList);
        } catch (_) {}
    });
}

async function startSuite() {
    if (_isConnecting) return;
    _isConnecting = true;

    try {
        await waitForDNS('web.whatsapp.com', 3);
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
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            browser: ['Suites', 'Chrome', '10.0.0'],
            transactionOpts: { maxCommitRetries: 5, delayBetweenTriesMs: 2000 }
        });

        registerSocketEvents(sock);

        sock.ev.on('creds.update', saveCreds);

        sock.sendMessageResilient = async (jid, content, options) => {
            try {
                return await sock.sendMessage(jid, content, options);
            } catch (err) {
                if (err?.output?.statusCode === 428) {
                    await new Promise(r => setTimeout(r, 2000));
                    return await sock.sendMessage(jid, content, options);
                }
                throw err;
            }
        };

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

// ── View-once buffer retention (30 min TTL, max 200 entries) ──
const VO_BUFFER_TTL_MS = 30 * 60 * 1000;
const MAX_VO_BUFFER_SIZE = 200;
function pruneViewOnceBuffer() {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of global.viewOnceBufferCache) {
        if (!entry || !entry.ts || now - entry.ts > VO_BUFFER_TTL_MS) {
            global.viewOnceBufferCache.delete(id);
            removed++;
        }
    }
    while (global.viewOnceBufferCache.size > MAX_VO_BUFFER_SIZE) {
        const firstKey = global.viewOnceBufferCache.keys().next().value;
        global.viewOnceBufferCache.delete(firstKey);
        removed++;
    }
    if (removed > 0) console.log(`[VO] Pruned ${removed} stale view-once buffer(s).`);
}
pruneViewOnceBuffer();
setInterval(pruneViewOnceBuffer, 10 * 60 * 1000);

// ── Status media retention (keep last 7 days, prune daily) ──
const STATUS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
async function pruneStatusMedia() {
    try {
        const dir = path.resolve(__dirname, 'media', 'status');
        if (!await fs.pathExists(dir)) return;
        const now = Date.now();
        let removed = 0;
        for (const file of await fs.readdir(dir)) {
            const filePath = path.join(dir, file);
            const stat = await fs.stat(filePath).catch(() => null);
            if (stat && stat.isFile() && now - stat.mtimeMs > STATUS_RETENTION_MS) {
                await fs.remove(filePath).catch(() => {});
                removed++;
            }
        }
        if (removed > 0) console.log(`[STATUS] Pruned ${removed} status media file(s) older than 7 days.`);
    } catch (_) {}
}
pruneStatusMedia();
setInterval(pruneStatusMedia, 24 * 60 * 60 * 1000);

const shutdown = async (signal) => {
    console.log(`\n[SYSTEM] Received ${signal}. Shutting down Crimson Engine gracefully...`);
    await cleanupSocket();
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('[DEBUG] Starting Crimson Engine...');
startSuite();


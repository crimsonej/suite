const axios = require('axios');
const dns = require('dns');
const { Resolver } = require('dns').promises;

// Use system DNS resolver explicitly
const resolver = new Resolver();

// Simple in-memory cache for IP lookups
const ipCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

let p2pLastIP = null;

// IP capture queue: any incoming IP resolves all pending capture promises.
// This fixes the ID mismatch — the track command doesn't know the real
// WhatsApp call ID in advance, so we broadcast to all waiters.
const captureQueue = [];

// Debug logging for raw incoming nodes during tracking
let debugTrackingActive = false;
let debugTrackingTimer = null;

function startDebugTracking(duration = 8000) {
    debugTrackingActive = true;
    console.log(`[Analyzer Debug] Starting debug tracking for ${duration}ms`);

    // Clear any existing timer
    if (debugTrackingTimer) {
        clearTimeout(debugTrackingTimer);
    }

    // Set timer to stop debug tracking
    debugTrackingTimer = setTimeout(() => {
        debugTrackingActive = false;
        console.log(`[Analyzer Debug] Stopped debug tracking`);
    }, duration);
}

async function analyzer(sock, call) {
    // Debug log raw incoming nodes during tracking
    if (debugTrackingActive) {
        console.log(`[Analyzer Debug] Raw incoming node:`, JSON.stringify(call, null, 2));
    }

    const { from, id, status } = call[0];

    if (status === 'offer') {
        // Try to extract IP from call data if available
        let ipInfo = 'Detected Incoming Offer';

        // Check if we have call data that might contain IP information
        if (call[0] && typeof call[0] === 'object') {
            // Try to stringify and search for IPs in the entire call object
            try {
                const callStr = JSON.stringify(call[0]);
                // More efficient regex that validates IP format during matching
                const ipMatches = callStr.match(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g);
                if (ipMatches && ipMatches.length > 0) {
                    // Find first valid public IP (more efficient than filtering array)
                    for (const ip of ipMatches) {
                        const parts = ip.split('.').map(Number);
                        const firstOctet = parts[0];
                        const secondOctet = parts[1];

                        // Check if it's a private IP range
                        const isPrivate = firstOctet === 10 ||
                                         (firstOctet === 192 && secondOctet === 168) ||
                                         (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31);

                        if (!isPrivate) {
                            ipInfo = ip; // Use first public IP found
                            p2pLastIP = ipInfo;
                            break;
                        }
                    }

                    // If no public IPs found, use the first IP
                    if (ipInfo === 'Detected Incoming Offer' && ipMatches.length > 0) {
                        ipInfo = ipMatches[0];
                        p2pLastIP = ipInfo;
                    }
                }
            } catch (e) {
                console.log(`[Analyzer] Could not parse call data for IP extraction: ${e.message}`);
            }
        }

        console.log(`[Analyzer] Incoming call from: ${from} (${ipInfo})`);

        // If we captured a valid IP, resolve ALL pending capture promises
        if (ipInfo && ipInfo !== 'Detected Incoming Offer') {
            resolveAllCaptures(ipInfo);
        }

        const logMsg = `📞 *Call Detection & Analyzer*\n\n` +
                       `From: @${from.split('@')[0]}\n` +
                       `Call ID: ${id}\n` +
                       `Status: ${status}\n` +
                       `IP Info: ${ipInfo}\n` +
                       `Timestamp: ${new Date().toLocaleString()}`;

        await sock.sendMessage(global.vault, { text: logMsg, mentions: [from] });
    } else if (debugTrackingActive) {
        // Log other call statuses during debug tracking
        console.log(`[Analyzer Debug] Call status: ${status}`, JSON.stringify(call, null, 2));
    }
}

// Helper for VPN/ISP detection (if IP is captured via external means or protocol candidates)
async function lookupIP(ip) {
    // Check cache first
    if (ipCache.has(ip)) {
        const cached = ipCache.get(ip);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            return cached.data;
        } else {
            // Remove expired cache entry
            ipCache.delete(ip);
        }
    }

    try {
        // Primary: ip-api.com (free, no key required, 45 req/min limit)
        const res = await axios.get(`http://ip-api.com/json/${ip}`, {
            timeout: 10000,
            proxy: false,
            httpsAgent: false,
            httpAgent: false
        });

        if (res.data.status === 'success') {
            const gMapsUrl = `https://www.google.com/maps?q=${res.data.lat},${res.data.lon}`;
            const result = {
                ip: res.data.query,
                location: `${res.data.city}, ${res.data.country}`,
                gMapsUrl: gMapsUrl
            };

            ipCache.set(ip, { data: result, timestamp: Date.now() });
            return result;
        }
    } catch (e) {
        console.error(`[GEO] ip-api.com failed for ${ip}: ${e.message}. Trying fallback...`);
    }

    // Fallback: ipinfo.io (free tier, 50k req/month, no key needed for basic)
    try {
        const res = await axios.get(`https://ipinfo.io/${ip}/json`, {
            timeout: 10000,
            proxy: false
        });

        if (res.data && res.data.loc) {
            const [lat, lon] = res.data.loc.split(',');
            const gMapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;
            const result = {
                ip: res.data.ip || ip,
                location: `${res.data.city || 'Unknown'}, ${res.data.country || 'Unknown'}`,
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

// Register a capture waiter. Any incoming IP from any call will resolve it.
// The callId parameter is kept for logging but matching is broadcast-based.
function captureIP(callId) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            // Remove this waiter from the queue on timeout
            const idx = captureQueue.findIndex(w => w.callId === callId);
            if (idx !== -1) captureQueue.splice(idx, 1);
            reject(new Error('IP capture timeout'));
        }, 8000); // 8 second timeout to match handler's Promise.race

        captureQueue.push({ callId, resolve, timeout });
    });
}

// Resolve ALL pending capture waiters with the captured IP.
// This is the fix: the track command can't predict the WhatsApp call ID,
// so we broadcast any captured IP to every waiter in the queue.
function resolveAllCaptures(ip) {
    while (captureQueue.length > 0) {
        const waiter = captureQueue.shift();
        clearTimeout(waiter.timeout);
        waiter.resolve({ ip });
    }
}

// Export p2pLastIP as a getter/setter object to allow external modification
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

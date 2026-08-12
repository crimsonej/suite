const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');

const scheduleFile = path.join(__dirname, '../media/schedules.json');

async function initScheduler(sock) {
    try {
        if (!await fs.pathExists(scheduleFile)) {
            await fs.ensureDir(path.dirname(scheduleFile));
            await fs.writeJson(scheduleFile, []);
        }
    } catch (err) {
        console.error('[SCHEDULER] Error initializing scheduler:', err.message);
        return;
    }

    // Check every 10 seconds
    cron.schedule('*/10 * * * * *', async () => {
        try {
            if (!await fs.pathExists(scheduleFile)) return;
            const schedules = await fs.readJson(scheduleFile);
            if (!Array.isArray(schedules) || schedules.length === 0) return;

            const now = new Date();
            const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
            
            const pending = schedules.filter(s => s.time === currentTime && !s.sent);
            
            for (const job of pending) {
                await sock.sendMessage(job.jid, { text: job.message });
                job.sent = true;
                console.log(`[Scheduler] Sent message to ${job.jid}`);
            }

            if (pending.length > 0) {
                await fs.writeJson(scheduleFile, schedules, { spaces: 2 });
            }
        } catch (err) {
            console.error('[SCHEDULER] Error in cron job:', err.message);
        }
    });
}

async function addSchedule(jid, message, time) {
    try {
        await fs.ensureDir(path.dirname(scheduleFile));
        let schedules = [];
        if (await fs.pathExists(scheduleFile)) {
            schedules = await fs.readJson(scheduleFile);
        }
        schedules.push({ jid, message, time, sent: false });
        await fs.writeJson(scheduleFile, schedules, { spaces: 2 });
    } catch (err) {
        console.error('[SCHEDULER] Error adding schedule:', err.message);
    }
}

module.exports = { initScheduler, addSchedule };

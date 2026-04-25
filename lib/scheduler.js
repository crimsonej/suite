const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');

const scheduleFile = path.join(__dirname, '../media/schedules.json');

async function initScheduler(sock) {
    if (!await fs.exists(scheduleFile)) {
        await fs.writeJson(scheduleFile, []);
    }

    // Check every minute
    cron.schedule('* * * * *', async () => {
        const schedules = await fs.readJson(scheduleFile);
        const now = new Date();
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        
        const pending = schedules.filter(s => s.time === currentTime && !s.sent);
        
        for (const job of pending) {
            await sock.sendMessage(job.jid, { text: job.message });
            job.sent = true;
            console.log(`[Scheduler] Sent message to ${job.jid}`);
        }

        if (pending.length > 0) {
            await fs.writeJson(scheduleFile, schedules);
        }
    });
}

async function addSchedule(jid, message, time) {
    const schedules = await fs.readJson(scheduleFile);
    schedules.push({ jid, message, time, sent: false });
    await fs.writeJson(scheduleFile, schedules);
}

module.exports = { initScheduler, addSchedule };

const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');

const scheduleFile = path.join(__dirname, '../media/schedules.json');

async function initScheduler(sock) {
<<<<<<< HEAD
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
=======
    try {
        if (!await fs.exists(scheduleFile)) {
            await fs.ensureDir(path.dirname(scheduleFile));
            await fs.writeJson(scheduleFile, []);
        }
    } catch (err) {
        console.error('[SCHEDULER] Error initializing scheduler:', err.message);
        return;
    }

    // Check every 10 seconds for better precision
    cron.schedule('*/10 * * * * *', async () => {
        try {
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
        } catch (err) {
            console.error('[SCHEDULER] Error in cron job:', err.message);
>>>>>>> a076549 (latest)
        }
    });
}

async function addSchedule(jid, message, time) {
<<<<<<< HEAD
    const schedules = await fs.readJson(scheduleFile);
    schedules.push({ jid, message, time, sent: false });
    await fs.writeJson(scheduleFile, schedules);
=======
    try {
        const schedules = await fs.readJson(scheduleFile);
        schedules.push({ jid, message, time, sent: false });
        await fs.writeJson(scheduleFile, schedules);
    } catch (err) {
        console.error('[SCHEDULER] Error adding schedule:', err.message);
    }
>>>>>>> a076549 (latest)
}

module.exports = { initScheduler, addSchedule };

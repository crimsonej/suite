const chalk = require('chalk');
const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const banner = `
${chalk.cyan('   _____ _    _ _____ _______ ______  _____ ')}
${chalk.cyan('  / ____| |  | |_   _|__   __|  ____|/ ____|')}
${chalk.cyan(' | (___ | |  | | | |    | |  | |__  | (___  ')}
${chalk.cyan('  \\___ \\| |  | | | |    | |  |  __|  \\___ \\ ')}
${chalk.cyan('  ____) | |__| |_| |_   | |  | |____ ____) |')}
${chalk.cyan(' |_____/ \\____/|_____|  |_|  |______|_____/ ')}
                                            
${chalk.white('   [ Self-Sustaining WhatsApp Userbot ]')}
`;

async function install() {
    console.clear();
    console.log(banner);
    console.log(chalk.yellow('Starting Suites initialization & environment check...'));

    try {
        console.log(chalk.blue('Checking system dependencies...'));
        
        // Check for FFmpeg (System binary or ffmpeg-static)
        let ffmpegFound = false;
        try {
            execSync('ffmpeg -version', { stdio: 'ignore' });
            ffmpegFound = true;
            console.log(chalk.green('✔ System FFmpeg found'));
        } catch (_) {}

        if (!ffmpegFound) {
            try {
                const ffmpegInstaller = require('ffmpeg-static');
                if (ffmpegInstaller && await fs.pathExists(ffmpegInstaller)) {
                    ffmpegFound = true;
                    console.log(chalk.green('✔ ffmpeg-static binary found'));
                }
            } catch (_) {}
        }

        if (!ffmpegFound) {
            console.log(chalk.yellow('⚠ Warning: FFmpeg not detected. Sticker conversion may require installing ffmpeg.'));
        }

        console.log(chalk.blue('Ensuring runtime directories & default configuration...'));
        await fs.ensureDir(path.join(__dirname, 'session_auth'));
        await fs.ensureDir(path.join(__dirname, 'media/status'));
        await fs.ensureDir(path.join(__dirname, 'lib'));

        // Initialize default settings JSON if missing
        const settingsPath = path.join(__dirname, 'media/settings.json');
        if (!await fs.pathExists(settingsPath)) {
            const defaultSettings = {
                antidelete: { global_private: true, global_groups: false, exceptions: {} },
                antiedit: { global_private: true, global_groups: false, exceptions: {} },
                home_jid: '',
                session_name: 'Suites Engine'
            };
            await fs.writeJson(settingsPath, defaultSettings, { spaces: 2 });
        }

        // Initialize default schedules JSON if missing
        const schedulesPath = path.join(__dirname, 'media/schedules.json');
        if (!await fs.pathExists(schedulesPath)) {
            await fs.writeJson(schedulesPath, []);
        }

        console.log(chalk.green('✔ Environment & media structure initialized successfully!'));
        console.log(chalk.green('\nInstallation complete!'));
        console.log(chalk.white('To start the bot, run: ') + chalk.cyan('npm start'));
    } catch (error) {
        console.error(chalk.red('Installation failed:'), error.message);
    }
}

install();

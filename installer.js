const chalk = require('chalk');
const { execSync } = require('child_process');
const fs = require('fs-extra');

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
    console.log(chalk.yellow('Starting Suite installation...'));

    try {
        console.log(chalk.blue('Checking system dependencies...'));
        
        // Check for FFmpeg
        try {
            execSync('ffmpeg -version', { stdio: 'ignore' });
            console.log(chalk.green('✔ FFmpeg found'));
        } catch (e) {
            console.log(chalk.red('✘ FFmpeg not found. Please install ffmpeg manually.'));
        }

        console.log(chalk.blue('Ensuring directories...'));
        await fs.ensureDir('session_auth');
        await fs.ensureDir('media/status');
        await fs.ensureDir('lib');
        console.log(chalk.green('✔ Directories created'));

        console.log(chalk.green('\nInstallation complete!'));
        console.log(chalk.white('To start the bot, run: ') + chalk.cyan('npm start'));
    } catch (error) {
        console.error(chalk.red('Installation failed:'), error);
    }
}

install();

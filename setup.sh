# Suites Installer for Linux/Termux
echo -e "\e[36m"
cat << "EOF"
   _____ _    _ _____ _______ ______  _____ 
  / ____| |  | |_   _|__   __|  ____|/ ____|
 | (___ | |  | | | |    | |  | |__  | (___  
  \___ \| |  | | | |    | |  |  __|  \___ \ 
  ____) | |__| |_| |_   | |  | |____ ____) |
 |_____/ \____/|_____|  |_|  |______|_____/ 
EOF
echo -e "\e[0m"

echo "Checking environment and dependencies..."

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check for node and npm
if command_exists node && command_exists npm; then
    echo "Node.js and npm are already installed. Skipping system install."
else
    echo "Dependencies not found. Attempting setup..."
    
    if [ -d "$HOME/.termux" ]; then
        echo "Termux detected."
        pkg update -y && pkg upgrade -y
        pkg install nodejs ffmpeg -y
    elif command_exists apt-get; then
        echo "Debian-based system detected. Installing nodejs..."
        sudo apt-get update
        # Install nodejs only; modern versions include npm
        sudo apt-get install -y nodejs ffmpeg
    else
        echo "Error: Could not detect package manager. Please install nodejs and ffmpeg manually."
        exit 1
    fi
fi

# Self-healing verification
if ! command_exists node || ! command_exists npm; then
    echo "Error: Installation failed or incomplete. Please ensure nodejs and npm are installed."
    exit 1
fi

echo "Installing project node modules..."
npm install

echo "Running post-install configuration..."
node installer.js

echo "Done. Use 'npm start' to launch Suites."

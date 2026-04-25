#!/bin/bash

# --- Crimson Networking Fix & Cleanup ---
echo "🛡️ Starting Crimson Network Repair..."

# 1. WiFi Power Management Fix
# Prevents 50% packet loss on Linux/Parrot systems
echo "[+] Disabling WiFi Power Management..."
CONF_FILE="/etc/NetworkManager/conf.d/default-wifi-powersave-on.conf"
if [ -f "$CONF_FILE" ]; then
    sudo sed -i 's/wifi.powersave = 3/wifi.powersave = 2/' "$CONF_FILE"
    echo "    - WiFi Power Management set to STABLE mode."
else
    echo "    - Skipping: Config file not found."
fi

# 2. Clean up /etc/hosts
# Removes hardcoded/tampered IP mappings to restore natural DNS
echo "[+] Cleaning up /etc/hosts file..."
sudo cp /etc/hosts /etc/hosts.bak
cat << 'EOF' | sudo tee /etc/hosts
127.0.0.1  localhost
127.0.1.1  parrot
::1        localhost ip6-localhost ip6-loopback
ff02::1    ip6-allnodes
ff02::2    ip6-allrouters
EOF
echo "    - Hosts file restored to defaults. Backup created at /etc/hosts.bak"

# 3. Optimize DNS Settings
# Forcing standard, fast DNS providers
echo "[+] Configuring fast DNS (Google & Cloudflare)..."
cat << 'EOF' | sudo tee /etc/resolv.conf
nameserver 8.8.8.8
nameserver 1.1.1.1
nameserver 8.8.4.4
EOF

# 4. Flush Caches & Restart Network
echo "[+] Flushing DNS cache and restarting services..."
if command -v systemd-resolve > /dev/null; then
    sudo systemd-resolve --flush-caches
fi
sudo systemctl restart NetworkManager

echo "✅ Network Repair Complete!"
echo "Please wait 5 seconds for the WiFi to reconnect."

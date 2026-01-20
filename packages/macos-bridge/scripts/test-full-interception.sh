#!/bin/bash
# Full Claude Desktop Interception Test
# Tests the complete flow with system proxy configuration

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="/tmp/bridge-full-test.log"
BRIDGE_PID=""
NETWORK_SERVICE=""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Get active network service
get_network_service() {
    # Try to detect active network interface
    local services=$(networksetup -listallnetworkservices | tail -n +2)

    # Check Wi-Fi first
    if echo "$services" | grep -q "Wi-Fi"; then
        local wifi_status=$(networksetup -getinfo "Wi-Fi" 2>/dev/null | grep "IP address" | head -1)
        if [ -n "$wifi_status" ]; then
            echo "Wi-Fi"
            return
        fi
    fi

    # Check Ethernet
    if echo "$services" | grep -q "Ethernet"; then
        local eth_status=$(networksetup -getinfo "Ethernet" 2>/dev/null | grep "IP address" | head -1)
        if [ -n "$eth_status" ]; then
            echo "Ethernet"
            return
        fi
    fi

    # Fallback to first active
    echo "Wi-Fi"
}

cleanup() {
    echo -e "\n${YELLOW}[Cleanup]${NC} Restoring system state..."

    # Disable system proxy
    if [ -n "$NETWORK_SERVICE" ]; then
        echo -e "${YELLOW}[Cleanup]${NC} Disabling system proxy for $NETWORK_SERVICE..."
        networksetup -setautoproxystate "$NETWORK_SERVICE" off 2>/dev/null || true
    fi

    # Stop bridge
    if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
        echo -e "${YELLOW}[Cleanup]${NC} Stopping bridge (PID $BRIDGE_PID)..."
        kill "$BRIDGE_PID" 2>/dev/null || true
    fi

    echo -e "${GREEN}[Cleanup]${NC} Done"
}

trap cleanup EXIT

echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          Full Claude Desktop Interception Test                 ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"

# Step 1: Build
echo -e "\n${YELLOW}[Step 1]${NC} Building macos-bridge..."
cd "$BRIDGE_DIR"
bun run build 2>&1 | tail -3

# Step 2: Get network service
echo -e "\n${YELLOW}[Step 2]${NC} Detecting active network service..."
NETWORK_SERVICE=$(get_network_service)
echo -e "${GREEN}[Info]${NC} Using network service: $NETWORK_SERVICE"

# Step 3: Start bridge
echo -e "\n${YELLOW}[Step 3]${NC} Starting bridge server..."
node dist/index.js > "$LOG_FILE" 2>&1 &
BRIDGE_PID=$!
sleep 3

# Extract credentials
BRIDGE_PORT=$(grep "CLAUDISH_BRIDGE_PORT=" "$LOG_FILE" | head -1 | cut -d= -f2)
BRIDGE_TOKEN=$(grep "CLAUDISH_BRIDGE_TOKEN=" "$LOG_FILE" | head -1 | cut -d= -f2)

if [ -z "$BRIDGE_PORT" ] || [ -z "$BRIDGE_TOKEN" ]; then
    echo -e "${RED}[Error]${NC} Failed to get bridge credentials"
    cat "$LOG_FILE"
    exit 1
fi

echo -e "${GREEN}[Info]${NC} Bridge: http://127.0.0.1:${BRIDGE_PORT}"
echo -e "${GREEN}[Info]${NC} Token: ${BRIDGE_TOKEN:0:8}...${BRIDGE_TOKEN: -4}"

# Step 4: Enable HTTPS proxy with routing
echo -e "\n${YELLOW}[Step 4]${NC} Enabling HTTPS proxy..."

ENABLE_RESPONSE=$(curl -s -X POST "http://127.0.0.1:${BRIDGE_PORT}/proxy/enable" \
    -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{
        "routing": {
            "enabled": true,
            "targetUrl": "https://openrouter.ai/api/v1/chat/completions",
            "modelMap": {
                "claude-sonnet-4-20250514": "anthropic/claude-sonnet-4"
            }
        }
    }')

# Extract HTTPS proxy port
HTTPS_PORT=$(echo "$ENABLE_RESPONSE" | grep -oE '"httpsProxyPort":[0-9]+' | cut -d: -f2)
echo -e "${GREEN}[Info]${NC} HTTPS Proxy: https://127.0.0.1:${HTTPS_PORT}"

sleep 2

# Verify CycleTLS
if grep -q "CycleTLS client initialized" "$LOG_FILE"; then
    echo -e "${GREEN}[✓]${NC} CycleTLS initialized"
else
    echo -e "${RED}[✗]${NC} CycleTLS failed to initialize"
fi

# Step 5: Configure system proxy with PAC file
echo -e "\n${YELLOW}[Step 5]${NC} Configuring system proxy (PAC file)..."
PAC_URL="http://127.0.0.1:${BRIDGE_PORT}/proxy.pac"
echo -e "${GREEN}[Info]${NC} PAC URL: $PAC_URL"

# Test PAC file is served
PAC_CONTENT=$(curl -s "$PAC_URL" 2>&1 | head -5)
if echo "$PAC_CONTENT" | grep -q "FindProxyForURL"; then
    echo -e "${GREEN}[✓]${NC} PAC file serving correctly"
else
    echo -e "${RED}[✗]${NC} PAC file not available"
    echo "$PAC_CONTENT"
fi

# Configure system proxy
networksetup -setautoproxyurl "$NETWORK_SERVICE" "$PAC_URL"
networksetup -setautoproxystate "$NETWORK_SERVICE" on
echo -e "${GREEN}[✓]${NC} System proxy configured"

# Step 6: Test with Claude Desktop
echo -e "\n${YELLOW}[Step 6]${NC} Testing with Claude Desktop..."

# Check if Claude is running
CLAUDE_RUNNING=$(osascript -e 'tell application "System Events" to (name of processes) contains "Claude"' 2>/dev/null || echo "false")

if [ "$CLAUDE_RUNNING" = "false" ]; then
    echo -e "${YELLOW}[Info]${NC} Launching Claude Desktop..."
    osascript -e 'tell application "Claude" to activate'
    sleep 5
fi

echo -e "${GREEN}[✓]${NC} Claude Desktop is running"

# Send test message
echo -e "\n${YELLOW}[Step 7]${NC} Sending test message..."

TEST_MESSAGE="Say just one word: Hello"

osascript <<EOF
tell application "Claude"
    activate
    delay 1
end tell

tell application "System Events"
    tell process "Claude"
        set frontmost to true
        delay 0.5

        -- Create new chat
        keystroke "n" using command down
        delay 2

        -- Type message
        keystroke "${TEST_MESSAGE}"
        delay 0.3

        -- Send
        keystroke return
    end tell
end tell
EOF

echo -e "${GREEN}[✓]${NC} Message sent"

# Step 8: Monitor logs
echo -e "\n${YELLOW}[Step 8]${NC} Monitoring traffic (20 seconds)..."
sleep 20

echo -e "\n${BLUE}═══════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}                        TRAFFIC LOGS                               ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════════${NC}"
cat "$LOG_FILE"

# Analyze
echo -e "\n${BLUE}═══════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}                        ANALYSIS                                   ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════════════${NC}"

CONNECT_COUNT=$(grep -c "CONNECT request" "$LOG_FILE" 2>/dev/null || echo "0")
CYCLETLS_200=$(grep -c "CycleTLS response: 200" "$LOG_FILE" 2>/dev/null || echo "0")
COMPLETION=$(grep -c "completion" "$LOG_FILE" 2>/dev/null || echo "0")
ERRORS_403=$(grep -c "403" "$LOG_FILE" 2>/dev/null || echo "0")

echo -e "CONNECT requests:     ${CONNECT_COUNT}"
echo -e "CycleTLS 200 OK:      ${CYCLETLS_200}"
echo -e "Completion requests:  ${COMPLETION}"
echo -e "403 Errors:           ${ERRORS_403}"

echo -e "\n${BLUE}═══════════════════════════════════════════════════════════════════${NC}"

if [ "$CYCLETLS_200" -gt 0 ] && [ "$ERRORS_403" -eq 0 ]; then
    echo -e "${GREEN}✓ CycleTLS Cloudflare bypass: WORKING${NC}"
else
    echo -e "${RED}✗ CycleTLS bypass: ISSUES DETECTED${NC}"
fi

if [ "$COMPLETION" -gt 0 ]; then
    echo -e "${GREEN}✓ Completion interception: WORKING${NC}"
else
    echo -e "${YELLOW}○ No completion requests captured yet${NC}"
fi

echo -e "\n${BLUE}[Info]${NC} Log file: $LOG_FILE"

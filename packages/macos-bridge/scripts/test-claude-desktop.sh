#!/bin/bash
# Comprehensive Claude Desktop Interception Test
# Tests the full flow: bridge → proxy → Claude Desktop → OpenRouter

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$(dirname "$SCRIPT_DIR")"
LOG_FILE="/tmp/bridge-claude-desktop-test.log"
BRIDGE_PID=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

cleanup() {
    echo -e "\n${YELLOW}[Cleanup]${NC} Stopping bridge..."
    if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
        kill "$BRIDGE_PID" 2>/dev/null || true
    fi
    # Also try to disable proxy
    curl -s -X POST "http://127.0.0.1:${BRIDGE_PORT}/proxy/disable" \
        -H "Authorization: Bearer ${BRIDGE_TOKEN}" 2>/dev/null || true
    echo -e "${GREEN}[Cleanup]${NC} Done"
}

trap cleanup EXIT

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Claude Desktop Interception Test                       ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"

# Step 1: Build the bridge
echo -e "\n${YELLOW}[Step 1]${NC} Building macos-bridge..."
cd "$BRIDGE_DIR"
bun run build 2>&1 | tail -3

# Step 2: Start the bridge
echo -e "\n${YELLOW}[Step 2]${NC} Starting bridge server..."
node dist/index.js > "$LOG_FILE" 2>&1 &
BRIDGE_PID=$!
sleep 2

# Extract port and token from log
BRIDGE_PORT=$(grep "CLAUDISH_BRIDGE_PORT=" "$LOG_FILE" | head -1 | cut -d= -f2)
BRIDGE_TOKEN=$(grep "CLAUDISH_BRIDGE_TOKEN=" "$LOG_FILE" | head -1 | cut -d= -f2)

if [ -z "$BRIDGE_PORT" ] || [ -z "$BRIDGE_TOKEN" ]; then
    echo -e "${RED}[Error]${NC} Failed to get bridge port/token"
    cat "$LOG_FILE"
    exit 1
fi

echo -e "${GREEN}[Info]${NC} Bridge running on port ${BRIDGE_PORT}"
echo -e "${GREEN}[Info]${NC} Token: ${BRIDGE_TOKEN:0:8}...${BRIDGE_TOKEN: -4}"

# Step 3: Enable HTTPS proxy with routing
echo -e "\n${YELLOW}[Step 3]${NC} Enabling HTTPS proxy with model routing..."

# Configure routing to use a different model (so we can verify interception)
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

echo -e "${GREEN}[Info]${NC} Proxy enabled: $ENABLE_RESPONSE"
sleep 2

# Check CycleTLS initialized
if grep -q "CycleTLS client initialized successfully" "$LOG_FILE"; then
    echo -e "${GREEN}[✓]${NC} CycleTLS initialized"
else
    echo -e "${RED}[✗]${NC} CycleTLS not initialized"
fi

# Step 4: Check if Claude Desktop is running
echo -e "\n${YELLOW}[Step 4]${NC} Checking Claude Desktop..."

CLAUDE_RUNNING=$(osascript -e 'tell application "System Events" to (name of processes) contains "Claude"' 2>/dev/null || echo "false")

if [ "$CLAUDE_RUNNING" = "true" ]; then
    echo -e "${GREEN}[✓]${NC} Claude Desktop is running"
else
    echo -e "${YELLOW}[Info]${NC} Claude Desktop not running, launching..."
    osascript -e 'tell application "Claude" to activate'
    sleep 3
fi

# Step 5: Use AppleScript to interact with Claude Desktop
echo -e "\n${YELLOW}[Step 5]${NC} Sending test message via AppleScript..."

# Create AppleScript to send a test message
TEST_MESSAGE="What model are you? Reply with just your model name, nothing else."

osascript <<EOF
tell application "Claude"
    activate
    delay 1
end tell

tell application "System Events"
    tell process "Claude"
        -- Wait for window
        repeat 10 times
            if (count of windows) > 0 then exit repeat
            delay 0.5
        end repeat

        -- Focus on the main window
        set frontmost to true
        delay 0.5

        -- Try to find and click the input area (new chat or existing)
        -- Use keyboard shortcut for new chat: Cmd+N
        keystroke "n" using command down
        delay 1

        -- Type the test message
        keystroke "${TEST_MESSAGE}"
        delay 0.5

        -- Press Enter to send
        keystroke return
        delay 0.5
    end tell
end tell
EOF

echo -e "${GREEN}[✓]${NC} Test message sent"

# Step 6: Wait and check logs for interception
echo -e "\n${YELLOW}[Step 6]${NC} Waiting for response and checking logs..."
sleep 10

echo -e "\n${BLUE}─────────────────────────────────────────────────────────────${NC}"
echo -e "${BLUE}Bridge Logs:${NC}"
echo -e "${BLUE}─────────────────────────────────────────────────────────────${NC}"
cat "$LOG_FILE"
echo -e "${BLUE}─────────────────────────────────────────────────────────────${NC}"

# Step 7: Analyze results
echo -e "\n${YELLOW}[Step 7]${NC} Analyzing results..."

# Check for key indicators
CYCLETLS_SUCCESS=$(grep -c "CycleTLS response: 200" "$LOG_FILE" 2>/dev/null || echo "0")
COMPLETION_INTERCEPT=$(grep -c "/completion" "$LOG_FILE" 2>/dev/null || echo "0")
OPENROUTER_ROUTE=$(grep -c "openrouter" "$LOG_FILE" 2>/dev/null || echo "0")
CLOUDFLARE_403=$(grep -c "403" "$LOG_FILE" 2>/dev/null || echo "0")

echo -e "\n${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                    Test Results                            ║${NC}"
echo -e "${BLUE}╠════════════════════════════════════════════════════════════╣${NC}"

if [ "$CYCLETLS_SUCCESS" -gt 0 ]; then
    echo -e "${BLUE}║${NC} ${GREEN}✓${NC} CycleTLS bypass:      ${GREEN}$CYCLETLS_SUCCESS successful requests${NC}"
else
    echo -e "${BLUE}║${NC} ${RED}✗${NC} CycleTLS bypass:      No successful requests"
fi

if [ "$CLOUDFLARE_403" -eq 0 ]; then
    echo -e "${BLUE}║${NC} ${GREEN}✓${NC} Cloudflare blocks:    ${GREEN}None (bypass working)${NC}"
else
    echo -e "${BLUE}║${NC} ${RED}✗${NC} Cloudflare blocks:    $CLOUDFLARE_403 (403 responses)"
fi

if [ "$COMPLETION_INTERCEPT" -gt 0 ]; then
    echo -e "${BLUE}║${NC} ${GREEN}✓${NC} Completion intercept: ${GREEN}$COMPLETION_INTERCEPT requests detected${NC}"
else
    echo -e "${BLUE}║${NC} ${YELLOW}○${NC} Completion intercept: No completion requests yet"
fi

if [ "$OPENROUTER_ROUTE" -gt 0 ]; then
    echo -e "${BLUE}║${NC} ${GREEN}✓${NC} OpenRouter routing:   ${GREEN}$OPENROUTER_ROUTE requests routed${NC}"
else
    echo -e "${BLUE}║${NC} ${YELLOW}○${NC} OpenRouter routing:   Not yet routed"
fi

echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"

# Final verdict
echo -e "\n${YELLOW}[Summary]${NC}"
if [ "$CYCLETLS_SUCCESS" -gt 0 ] && [ "$CLOUDFLARE_403" -eq 0 ]; then
    echo -e "${GREEN}✓ CycleTLS Cloudflare bypass is WORKING${NC}"
    if [ "$COMPLETION_INTERCEPT" -gt 0 ]; then
        echo -e "${GREEN}✓ Completion interception is WORKING${NC}"
    else
        echo -e "${YELLOW}○ Send a message in Claude Desktop to test completion interception${NC}"
    fi
else
    echo -e "${RED}✗ Something went wrong - check logs above${NC}"
fi

echo -e "\n${BLUE}[Info]${NC} Full logs at: $LOG_FILE"
echo -e "${BLUE}[Info]${NC} Press Ctrl+C to stop the test"

# Keep running to observe more traffic
echo -e "\n${YELLOW}[Monitoring]${NC} Watching for more traffic (Ctrl+C to stop)..."
tail -f "$LOG_FILE"

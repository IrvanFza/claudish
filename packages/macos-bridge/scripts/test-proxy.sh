#!/bin/bash
#
# ClaudishProxy Automated Test Script
# For agentic AI debugging - tests proxy interception automatically
#
# Usage: ./test-proxy.sh [test_message]
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_TOKEN_FILE="$HOME/.claudish-proxy/bridge-token"
DEBUG_LOG_DIR="$HOME/.claudish-proxy/logs"
TEST_MESSAGE="${1:-what model are you}"
TIMEOUT=30

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[TEST]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if ClaudishProxy bridge is running
check_bridge() {
    if [[ ! -f "$BRIDGE_TOKEN_FILE" ]]; then
        error "Bridge token file not found. Is ClaudishProxy running?"
        return 1
    fi

    local port=$(jq -r .port "$BRIDGE_TOKEN_FILE")
    local token=$(jq -r .token "$BRIDGE_TOKEN_FILE")

    local status=$(curl -s -H "Authorization: Bearer $token" "http://127.0.0.1:$port/status" 2>/dev/null)
    if [[ -z "$status" ]]; then
        error "Cannot connect to bridge on port $port"
        return 1
    fi

    local running=$(echo "$status" | jq -r .running)
    if [[ "$running" != "true" ]]; then
        warn "Proxy not enabled. Enabling now..."
        curl -s -X POST -H "Authorization: Bearer $token" \
            -H "Content-Type: application/json" \
            -d '{"apiKeys":{}}' \
            "http://127.0.0.1:$port/proxy/enable" > /dev/null
        sleep 2
    fi

    log "Bridge running on port $port, proxy enabled"
    echo "$port:$token"
}

# Enable debug mode and get log path
enable_debug() {
    local port_token="$1"
    local port="${port_token%%:*}"
    local token="${port_token##*:}"

    local result=$(curl -s -X POST -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d '{"enabled":true}' \
        "http://127.0.0.1:$port/debug")

    local log_path=$(echo "$result" | jq -r '.data.logPath')
    log "Debug logging enabled: $log_path"
    echo "$log_path"
}

# Get current debug log line count
get_log_lines() {
    local log_path="$1"
    if [[ -f "$log_path" ]]; then
        wc -l < "$log_path" | tr -d ' '
    else
        echo "0"
    fi
}

# Send message to Claude Desktop via AppleScript
send_message_to_claude() {
    local message="$1"

    log "Sending message to Claude Desktop: '$message'"

    osascript << EOF
tell application "Claude"
    activate
end tell

delay 1

tell application "System Events"
    tell process "Claude"
        -- Wait for window to be ready
        set frontmost to true
        delay 0.5

        -- Try to find and focus the input field
        -- Claude Desktop uses a text area for input
        try
            -- Press Cmd+N for new conversation (in case we need fresh state)
            -- keystroke "n" using command down
            -- delay 1

            -- Type the message
            keystroke "${message}"
            delay 0.3

            -- Send with Enter (Claude Desktop uses Enter to send)
            key code 36 -- Enter key

        on error errMsg
            return "Error: " & errMsg
        end try
    end tell
end tell

return "Message sent"
EOF
}

# Wait for completion endpoint traffic in debug log
wait_for_completion() {
    local log_path="$1"
    local start_line="$2"
    local timeout="$3"

    log "Waiting for /completion traffic (timeout: ${timeout}s)..."

    local elapsed=0
    while [[ $elapsed -lt $timeout ]]; do
        # Check for completion endpoint in new log lines
        if [[ -f "$log_path" ]]; then
            local new_content=$(tail -n +$((start_line + 1)) "$log_path" 2>/dev/null)

            if echo "$new_content" | grep -q "/completion"; then
                log "Found /completion request in traffic!"
                echo "$new_content" | grep "/completion" | head -5
                return 0
            fi

            # Also check for any claude.ai traffic
            if echo "$new_content" | grep -q "claude.ai"; then
                log "Traffic detected:"
                echo "$new_content" | grep "claude.ai" | tail -10
            fi
        fi

        sleep 1
        elapsed=$((elapsed + 1))
    done

    warn "Timeout waiting for /completion traffic"
    return 1
}

# Main test flow
main() {
    log "=== ClaudishProxy Automated Test ==="
    log "Test message: '$TEST_MESSAGE'"
    echo ""

    # Step 1: Check bridge
    log "Step 1: Checking bridge status..."
    local port_token=$(check_bridge)
    if [[ $? -ne 0 ]]; then
        error "Bridge check failed"
        exit 1
    fi
    echo ""

    # Step 2: Enable debug logging
    log "Step 2: Enabling debug logging..."
    local log_path=$(enable_debug "$port_token")
    local start_lines=$(get_log_lines "$log_path")
    echo ""

    # Step 3: Send message to Claude Desktop
    log "Step 3: Sending message to Claude Desktop..."
    local result=$(send_message_to_claude "$TEST_MESSAGE")
    echo "AppleScript result: $result"
    echo ""

    # Step 4: Wait for traffic
    log "Step 4: Monitoring for proxy traffic..."
    if wait_for_completion "$log_path" "$start_lines" "$TIMEOUT"; then
        echo ""
        log "=== TEST PASSED ==="
        log "Proxy successfully intercepted Claude Desktop traffic!"

        # Show full log excerpt
        echo ""
        log "Debug log excerpt:"
        tail -n +$((start_lines + 1)) "$log_path" 2>/dev/null | head -20

        exit 0
    else
        echo ""
        error "=== TEST FAILED ==="
        error "No /completion traffic detected within ${TIMEOUT}s"

        # Show what traffic we did see
        echo ""
        log "Traffic captured (if any):"
        tail -n +$((start_lines + 1)) "$log_path" 2>/dev/null | head -20

        exit 1
    fi
}

main "$@"

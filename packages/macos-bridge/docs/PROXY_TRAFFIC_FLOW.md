# Proxy Traffic Flow Documentation

This document describes how the macos-bridge intercepts and modifies Claude Desktop traffic to route requests through alternative AI providers while maintaining conversation history.

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Claude Desktop │────▶│   macos-bridge   │────▶│   claude.ai     │
│                 │◀────│   (HTTPS Proxy)  │◀────│                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               │ (Model Routing)
                               ▼
                        ┌─────────────────┐
                        │   OpenRouter    │
                        │   (GPT-5.2, etc)│
                        └─────────────────┘
```

## Components

### 1. HTTPS Proxy Server (`https-proxy-server.ts`)

- Listens on a dynamic port (e.g., 61709)
- Handles TLS termination with dynamic certificate generation via SNI
- Forwards CONNECT requests to the CONNECTHandler
- Claude Desktop connects with: `--proxy-server=https://127.0.0.1:{port} --ignore-certificate-errors`

### 2. CONNECT Handler (`connect-handler.ts`)

The core component that intercepts and processes all HTTPS traffic:

- **TLS MITM**: Creates local TLS servers for each target domain
- **Request Interception**: Parses HTTP requests from the TLS stream
- **Response Modification**: Modifies responses before forwarding to client
- **CycleTLS**: Bypasses Cloudflare TLS fingerprinting for claude.ai

### 3. Certificate Manager (`certificate-manager.ts`)

- Generates a root CA certificate on first run
- Dynamically generates certificates for each intercepted domain
- Caches certificates for performance

## Traffic Flow

### Phase 1: Connection Setup

```
1. Claude Desktop → CONNECT claude.ai:443 → HTTPS Proxy
2. Proxy responds: HTTP/1.1 200 Connection Established
3. Claude Desktop initiates TLS handshake with proxy (thinking it's claude.ai)
4. Proxy terminates TLS using generated certificate for claude.ai
5. Proxy establishes separate TLS connection to real claude.ai via CycleTLS
```

### Phase 2: Normal Request Forwarding

For non-completion requests (settings, conversation list, etc.):

```
Claude Desktop → Request → Bridge → CycleTLS → claude.ai → Response → Bridge → Claude Desktop
```

### Phase 3: Completion Request Interception (Model Routing)

When a completion request is detected:

```
1. Claude Desktop sends POST /api/organizations/{org}/chat_conversations/{conv}/completion
2. Bridge detects completion endpoint and checks routing config
3. If routing enabled and model mapped:
   a. Extract messages from Claude's request format
   b. Convert to OpenAI chat/completions format
   c. Send to OpenRouter with target model (e.g., openai/gpt-5.2)
   d. Stream response back, converting SSE format
   e. Store messages in MessageStore for later sync
4. Claude Desktop displays the response
```

**Request Transformation:**
```
Claude Format:                          OpenAI Format:
{                                       {
  "prompt": "...",          ──────▶       "model": "openai/gpt-5.2",
  "model": "claude-opus-4-5",             "messages": [...],
  "stream": true                          "stream": true
}                                       }
```

### Phase 4: Conversation Sync (History Persistence)

When user switches chats and returns, Claude Desktop fetches conversation state:

```
1. Claude Desktop sends GET /api/organizations/{org}/chat_conversations/{conv}?tree=True
2. Bridge intercepts this sync request
3. Bridge checks MessageStore for injected messages for this conversation
4. If messages exist:
   a. Fetch original response from claude.ai (returns 0 messages - server doesn't have them)
   b. Inject stored messages into chat_messages array
   c. Set current_leaf_message_uuid to last message UUID
   d. Update Content-Length header (critical!)
   e. Forward modified response to Claude Desktop
5. Claude Desktop displays the conversation with full history
```

## Key Data Structures

### Message Storage Format

```typescript
interface StoredMessage {
  uuid: string;
  text: string;
  content: Array<{
    type: "text";
    text: string;
    start_timestamp: string;
    stop_timestamp: string;
    citations: any[];
  }>;
  sender: "human" | "assistant";
  index: number;
  created_at: string;
  updated_at: string;
  truncated: boolean;
  attachments: any[];
  files: any[];
  files_v2: any[];
  sync_sources: any[];
  parent_message_uuid: string;
}
```

### Conversation Sync Response (Modified)

```json
{
  "uuid": "conversation-uuid",
  "name": "Chat Name",
  "chat_messages": [
    { "uuid": "msg1", "sender": "human", "index": 0, ... },
    { "uuid": "msg2", "sender": "assistant", "index": 1, ... }
  ],
  "current_leaf_message_uuid": "msg2"  // CRITICAL: Must point to last message
}
```

## Critical Implementation Details

### 1. Content-Length Header

When modifying sync responses, the Content-Length header MUST be updated correctly:

```typescript
// Delete all case variants to avoid duplicates
delete modifiedHeaders["Content-Length"];
delete modifiedHeaders["content-length"];
// Set correct length
modifiedHeaders["Content-Length"] = String(Buffer.byteLength(modifiedBody));
```

**Why?** Duplicate headers cause response truncation, leading to "Can't open this chat" errors.

### 2. current_leaf_message_uuid

This field tells Claude Desktop which message is the "head" of the conversation tree:

```typescript
if (conversationData.chat_messages?.length > 0) {
  const lastMessage = conversationData.chat_messages[conversationData.chat_messages.length - 1];
  conversationData.current_leaf_message_uuid = lastMessage.uuid;
}
```

**Why?** Without this, Claude Desktop doesn't know which branch to display, even if messages exist.

### 3. Parent Message Chain

Messages must form a valid chain:
- First message: `parent_message_uuid: "00000000-0000-4000-8000-000000000000"` (root)
- Subsequent messages: `parent_message_uuid: <previous_message_uuid>`

### 4. Message Index

Messages must have sequential indices starting from 0.

## API Endpoints

### Enable Proxy
```
POST /proxy/enable
{
  "apiKeys": { "openrouter": "sk-or-v1-..." }
}
```

### Configure Routing
```
POST /routing
{
  "enabled": true,
  "modelMap": {
    "claude-opus-4-5-20251101": "openai/gpt-5.2"
  }
}
```

### Check Status
```
GET /health
GET /status
GET /routing
```

## Debugging

### Log Files
- `/tmp/bridge.log` - Main bridge output
- `/tmp/http_response_sent.txt` - Last modified sync response
- `/tmp/conversation_response_modified.json` - Last modified conversation JSON
- `/tmp/completion_{id}_{timestamp}.json` - Saved completion requests

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Can't open this chat" | Duplicate Content-Length headers | Delete all variants before setting |
| History not showing | Missing current_leaf_message_uuid | Set to last message UUID |
| Proxy connection failed | TLS version mismatch | Ensure minVersion/maxVersion set |
| Model not routed | Routing not configured | Call POST /routing with modelMap |

## Security Notes

- The proxy generates a self-signed CA certificate
- Claude Desktop must be started with `--ignore-certificate-errors`
- API keys are stored in memory only, not persisted
- All traffic is local (127.0.0.1)

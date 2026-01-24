// ============================================================================
// PROXY SERVER
// ============================================================================

export interface ProxyServerOptions {
	summarizeTools?: boolean;
	onRequest?: RequestHook;
	onResponse?: ResponseHook;
}

export interface ProxyServer {
	port: number;
	url: string;
	shutdown: () => Promise<void>;
}

export { createProxyServer } from './proxy-server.js';

// ============================================================================
// HANDLERS
// ============================================================================

export { NativeHandler } from './handlers/native-handler.js';
export { OpenRouterHandler } from './handlers/openrouter-handler.js';
export { GeminiHandler } from './handlers/gemini-handler.js';
export { OpenAIHandler } from './handlers/openai-handler.js';
export { LocalProviderHandler } from './handlers/local-provider-handler.js';
export { AnthropicCompatHandler } from './handlers/anthropic-compat-handler.js';
export { PoeHandler } from './handlers/poe-handler.js';
export { GeminiCodeAssistHandler } from './handlers/gemini-codeassist-handler.js';

export type { LocalProviderOptions } from './handlers/local-provider-handler.js';

// ============================================================================
// AUTH
// ============================================================================

export { GeminiOAuth, getValidAccessToken, setupGeminiUser } from './auth/gemini-oauth.js';

// ============================================================================
// PROVIDERS
// ============================================================================

export interface LocalProvider {
	name: string;
	baseUrl: string;
	apiPath: string;
	envVar: string;
	prefixes: string[];
	capabilities: {
		supportsTools: boolean;
		supportsVision: boolean;
		supportsStreaming: boolean;
		supportsJsonMode: boolean;
	};
}

export interface ResolvedProvider {
	provider: LocalProvider;
	modelName: string;
}

// Re-export the full RemoteProvider type from handlers (includes capabilities, apiPath, etc.)
export type {
	RemoteProvider,
	ResolvedRemoteProvider,
	RemoteProviderConfig,
	ModelPricing,
	ProviderCapabilities,
} from './handlers/shared/remote-provider-types.js';

export {
	resolveProvider,
	isLocalProvider,
	parseUrlModel,
	createUrlProvider,
	getRegisteredProviders,
} from './providers/provider-registry.js';

export {
	resolveRemoteProvider,
	validateRemoteProviderApiKey,
	getRegisteredRemoteProviders,
} from './providers/remote-provider-registry.js';

// Centralized provider resolution - THE single source of truth for API key validation
export {
	resolveModelProvider,
	validateApiKeysForModels,
	getMissingKeyError,
	getMissingKeysError,
	getMissingKeyResolutions,
	requiresOpenRouterKey,
	isLocalModel,
	type ProviderCategory,
	type ProviderResolution,
} from './providers/provider-resolver.js';

// ============================================================================
// FORMAT TYPES (for logging token usage and computing costs)
// ============================================================================

export interface AnthropicMessage {
	id: string;
	type: 'message';
	role: 'assistant';
	content: Array<{ type: string; text?: string }>;
	model: string;
	stop_reason: string;
	stop_sequence: string | null;
	usage: {
		input_tokens: number;
		output_tokens: number;
	};
}

export interface OpenAIMessage {
	id: string;
	object: 'chat.completion' | 'chat.completion.chunk';
	created: number;
	model: string;
	choices: Array<{
		index: number;
		message?: { role: string; content: string };
		delta?: { role?: string; content?: string };
		finish_reason: string | null;
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export interface GeminiMessage {
	candidates: Array<{
		content: {
			parts: Array<{ text: string }>;
			role: string;
		};
		finishReason: string;
	}>;
	usageMetadata?: {
		promptTokenCount: number;
		candidatesTokenCount: number;
		totalTokenCount: number;
	};
}

// ============================================================================
// TRANSFORM
// ============================================================================

export {
	transformOpenAIToClaude,
	sanitizeRoot,
	mapTools,
	mapToolChoice,
	transformMessages,
	removeUriFormat,
} from './transform.js';

// ============================================================================
// MIDDLEWARE HOOKS
// ============================================================================

export interface RequestContext {
	requestId: string;
	timestamp: string;
	userAgent?: string;
	model: string;
	endpoint: string;
	payload: any;
}

export interface ResponseContext extends RequestContext {
	status: number;
	latency: number;
	inputTokens?: number;
	outputTokens?: number;
	error?: string;
}

export type RequestHook = (ctx: RequestContext) => Promise<void> | void;
export type ResponseHook = (ctx: ResponseContext) => Promise<void> | void;

export interface Middleware {
	name: string;
	priority: number;
	onRequest?: RequestHook;
	onResponse?: ResponseHook;
}

// Export existing middleware system
export { MiddlewareManager } from './middleware/manager.js';
export type {
	ModelMiddleware,
	RequestContext as ModelRequestContext,
	NonStreamingResponseContext,
	StreamChunkContext,
} from './middleware/types.js';

// Export Gemini middleware
export { GeminiThoughtSignatureMiddleware } from './middleware/gemini-thought-signature.js';

// ============================================================================
// LOGGER
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'minimal';

export {
	initLogger,
	log,
	isLoggingEnabled,
	getLogFilePath,
	logStructured,
} from './logger.js';

// ============================================================================
// TYPES
// ============================================================================

export type { ProxyServer as ProxyServerType, ClaudishConfig, OpenRouterModel } from './types.js';

// ============================================================================
// CONFIG
// ============================================================================

export { ENV, DEFAULT_PORT_RANGE } from './config.js';

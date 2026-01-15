/**
 * Bridge HTTP Server
 *
 * Provides HTTP API for Swift app to control the proxy.
 * Uses token-based authentication for security.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { ConfigManager } from './config-manager.js';
import { RoutingMiddleware } from './routing-middleware.js';
import { AuthManager } from './auth.js';
import type {
	ProxyStatus,
	BridgeStartOptions,
	LogFilter,
	LogResponse,
	HealthResponse,
	BridgeConfig,
	ApiResponse,
} from './types.js';

/**
 * Bridge server startup result
 */
export interface BridgeStartResult {
	port: number;
	token: string;
}

/**
 * Bridge HTTP Server
 */
export class BridgeServer {
	private app: Hono;
	private configManager: ConfigManager;
	private routingMiddleware: RoutingMiddleware | null = null;
	private authManager: AuthManager;
	private server: ReturnType<typeof serve> | null = null;
	private startTime: number;
	private proxyPort: number | undefined;

	constructor() {
		this.app = new Hono();
		this.configManager = new ConfigManager();
		this.authManager = new AuthManager();
		this.startTime = Date.now();
		this.setupRoutes();
	}

	private setupRoutes(): void {
		// Apply authentication middleware FIRST (but health is public)
		this.app.use('*', this.authManager.middleware());

		// Restrict CORS to localhost only
		this.app.use(
			'*',
			cors({
				origin: (origin) => {
					// Allow localhost origins
					if (!origin) return null;
					if (origin.startsWith('http://localhost:')) return origin;
					if (origin.startsWith('http://127.0.0.1:')) return origin;
					return null;
				},
			})
		);

		// ============================================
		// PUBLIC ENDPOINTS
		// ============================================

		/**
		 * GET /health - Health check (public, no auth required)
		 */
		this.app.get('/health', (c) => {
			const response: HealthResponse = {
				status: 'ok',
				version: '1.0.0',
				uptime: (Date.now() - this.startTime) / 1000,
			};
			return c.json(response);
		});

		/**
		 * GET /proxy.pac - Proxy Auto-Config file (public, no auth required)
		 */
		this.app.get('/proxy.pac', (c) => {
			const port = this.proxyPort || 0;
			const pacContent = `function FindProxyForURL(url, host) {
  if (host === "api.anthropic.com") {
    return "PROXY 127.0.0.1:${port}";
  }
  return "DIRECT";
}`;
			c.header('Content-Type', 'application/x-ns-proxy-autoconfig');
			return c.text(pacContent);
		});

		// ============================================
		// PROTECTED ENDPOINTS (require Bearer token)
		// ============================================

		/**
		 * GET /status - Proxy status
		 */
		this.app.get('/status', (c) => {
			const status: ProxyStatus = {
				running: this.routingMiddleware !== null,
				port: this.proxyPort,
				detectedApps: this.routingMiddleware?.getDetectedApps() || [],
				totalRequests: this.routingMiddleware?.getLogs().length || 0,
				activeConnections: 0,
				uptime: (Date.now() - this.startTime) / 1000,
				version: '1.0.0',
			};
			return c.json(status);
		});

		/**
		 * GET /config - Get current configuration
		 */
		this.app.get('/config', (c) => {
			return c.json(this.configManager.getConfig());
		});

		/**
		 * POST /config - Update configuration
		 */
		this.app.post('/config', async (c) => {
			try {
				const body = (await c.req.json()) as Partial<BridgeConfig>;
				const result = this.configManager.updateConfig(body);
				const response: ApiResponse<BridgeConfig> = {
					success: true,
					data: result,
				};
				return c.json(response);
			} catch (error) {
				const response: ApiResponse = {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
				return c.json(response, 400);
			}
		});

		/**
		 * POST /proxy/enable - Enable the proxy
		 */
		this.app.post('/proxy/enable', async (c) => {
			if (this.routingMiddleware) {
				return c.json(
					{
						success: false,
						error: 'Proxy already running',
					},
					400
				);
			}

			try {
				const body = (await c.req.json()) as BridgeStartOptions;

				// Create routing middleware with API keys
				this.routingMiddleware = new RoutingMiddleware(this.configManager, body.apiKeys);

				// Note: The actual /v1/messages endpoint will be added dynamically
				// We need to use a catch-all for proxied requests

				const response: ApiResponse<{ proxyUrl: string; actualPort: number }> = {
					success: true,
					data: {
						proxyUrl: `http://127.0.0.1:${this.proxyPort}`,
						actualPort: this.proxyPort || 0,
					},
				};
				return c.json(response);
			} catch (error) {
				const response: ApiResponse = {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
				return c.json(response, 500);
			}
		});

		/**
		 * POST /proxy/disable - Disable the proxy
		 */
		this.app.post('/proxy/disable', async (c) => {
			if (!this.routingMiddleware) {
				return c.json(
					{
						success: false,
						error: 'Proxy not running',
					},
					400
				);
			}

			try {
				await this.routingMiddleware.shutdown();
				this.routingMiddleware = null;

				return c.json({
					success: true,
					message: 'Proxy stopped',
				});
			} catch (error) {
				return c.json(
					{
						success: false,
						error: error instanceof Error ? error.message : String(error),
					},
					500
				);
			}
		});

		/**
		 * GET /logs - Get request logs
		 */
		this.app.get('/logs', (c) => {
			const query: LogFilter = {
				limit: Number(c.req.query('limit')) || 100,
				offset: Number(c.req.query('offset')) || 0,
				filter: c.req.query('filter') || undefined,
				since: c.req.query('since') || undefined,
			};

			if (!this.routingMiddleware) {
				const response: LogResponse = {
					logs: [],
					total: 0,
					hasMore: false,
				};
				return c.json(response);
			}

			let logs = this.routingMiddleware.getLogs();

			// Apply filter
			if (query.filter) {
				const filterLower = query.filter.toLowerCase();
				logs = logs.filter(
					(log) =>
						log.app.toLowerCase().includes(filterLower) ||
						log.requestedModel.toLowerCase().includes(filterLower) ||
						log.targetModel.toLowerCase().includes(filterLower)
				);
			}

			// Apply since filter
			if (query.since) {
				const sinceDate = new Date(query.since);
				logs = logs.filter((log) => new Date(log.timestamp) >= sinceDate);
			}

			const total = logs.length;
			const offset = query.offset || 0;
			const limit = query.limit || 100;

			const response: LogResponse = {
				logs: logs.slice(offset, offset + limit),
				total,
				hasMore: total > offset + limit,
				nextOffset: total > offset + limit ? offset + limit : undefined,
			};

			return c.json(response);
		});

		/**
		 * DELETE /logs - Clear logs
		 */
		this.app.delete('/logs', (c) => {
			if (this.routingMiddleware) {
				this.routingMiddleware.clearLogs();
			}
			return c.json({ success: true, message: 'Logs cleared' });
		});

		// ============================================
		// PROXY PASS-THROUGH (when enabled)
		// ============================================

		/**
		 * POST /v1/messages - Anthropic Messages API proxy
		 */
		this.app.post('/v1/messages', async (c) => {
			if (!this.routingMiddleware) {
				return c.json(
					{
						error: 'Proxy not enabled',
						message: 'Call POST /proxy/enable first',
					},
					503
				);
			}

			// Delegate to routing middleware
			const handler = this.routingMiddleware.handle();
			// The next function must return Promise<void> for Hono middleware
			return handler(c, async () => {
				// This shouldn't be called since routing middleware handles everything
				// Return void to satisfy Next type
			});
		});
	}

	/**
	 * Start the bridge server
	 *
	 * @param port - Port to listen on (0 = random available port)
	 * @returns Startup result with actual port and auth token
	 */
	async start(port = 0): Promise<BridgeStartResult> {
		return new Promise((resolve) => {
			this.server = serve({
				fetch: this.app.fetch,
				port,
				hostname: '127.0.0.1', // IMPORTANT: Only bind to localhost
			});

			this.server.on('listening', () => {
				const addr = this.server?.address();
				const actualPort = typeof addr === 'object' && addr?.port ? addr.port : port;
				this.proxyPort = actualPort;

				const token = this.authManager.getToken();

				// Output structured data to stdout for Swift app to parse
				// IMPORTANT: These lines must be parseable by the Swift app
				console.log(`CLAUDISH_BRIDGE_PORT=${actualPort}`);
				console.log(`CLAUDISH_BRIDGE_TOKEN=${token}`);

				// Log to stderr (not parsed by Swift app)
				console.error(`[bridge] Server started on http://127.0.0.1:${actualPort}`);
				console.error(`[bridge] Token: ${this.authManager.getMaskedToken()}`);

				resolve({
					port: actualPort,
					token,
				});
			});
		});
	}

	/**
	 * Stop the bridge server
	 */
	async stop(): Promise<void> {
		if (this.routingMiddleware) {
			await this.routingMiddleware.shutdown();
			this.routingMiddleware = null;
		}

		if (this.server) {
			return new Promise((resolve, reject) => {
				this.server!.close((err: Error | undefined) => {
					if (err) reject(err);
					else resolve();
				});
			});
		}
	}

	/**
	 * Get the current auth token
	 */
	getToken(): string {
		return this.authManager.getToken();
	}
}

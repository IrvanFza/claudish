import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { BridgeServer } from './server.js';

/**
 * Bridge Server HTTP API Tests
 *
 * BLACK BOX TESTS - Based on requirements.md and architecture-v2.md
 */

const BASE_URL = 'http://127.0.0.1';
let serverPort: number;
let authToken: string;
let server: BridgeServer;

beforeAll(async () => {
	server = new BridgeServer();
	const result = await server.start(0);
	serverPort = result.port;
	authToken = result.token;
});

afterAll(async () => {
	await server.stop();
});

describe('Health Endpoint', () => {
	test('returns status ok', async () => {
		const response = await fetch(`${BASE_URL}:${serverPort}/health`);
		expect(response.status).toBe(200);

		const data = (await response.json()) as { status: string; version: string; uptime: number };
		expect(data.status).toBe('ok');
		expect(data).toHaveProperty('version');
		expect(data).toHaveProperty('uptime');
	});

	test('is public (no auth required)', async () => {
		const response = await fetch(`${BASE_URL}:${serverPort}/health`, {
			headers: {}, // No Authorization header
		});
		expect(response.status).toBe(200);
	});
});

describe('Authentication', () => {
	test('rejects requests without auth token', async () => {
		const response = await fetch(`${BASE_URL}:${serverPort}/status`);
		expect(response.status).toBe(401);
	});

	test('rejects requests with invalid token', async () => {
		const response = await fetch(`${BASE_URL}:${serverPort}/status`, {
			headers: {
				Authorization: 'Bearer invalid-token-12345',
			},
		});
		expect(response.status).toBe(401);
	});

	test('accepts requests with valid token', async () => {
		const response = await fetch(`${BASE_URL}:${serverPort}/status`, {
			headers: {
				Authorization: `Bearer ${authToken}`,
			},
		});
		expect(response.status).toBe(200);
	});
});

describe('PAC File Endpoint', () => {
	test('returns JavaScript function', async () => {
		const response = await fetch(`${BASE_URL}:${serverPort}/proxy.pac`);
		expect(response.status).toBe(200);
		// Accept any text content type for PAC file
		expect(response.headers.get('content-type')).toBeTruthy();

		const pacContent = await response.text();
		expect(pacContent).toContain('function FindProxyForURL');
		expect(pacContent).toContain('anthropic.com');
	});

	test('is public (no auth required)', async () => {
		const response = await fetch(`${BASE_URL}:${serverPort}/proxy.pac`);
		expect(response.status).toBe(200);
	});
});

describe('Status Endpoint', () => {
	test('returns proxy state', async () => {
		const response = await fetch(`${BASE_URL}:${serverPort}/status`, {
			headers: {
				Authorization: `Bearer ${authToken}`,
			},
		});

		expect(response.status).toBe(200);

		const data = (await response.json()) as {
			running: boolean;
			port: number;
			detectedApps: unknown[];
			totalRequests: number;
			uptime: number;
			version: string;
		};
		expect(typeof data.running).toBe('boolean');
		expect(data).toHaveProperty('port');
		expect(data).toHaveProperty('detectedApps');
		expect(data).toHaveProperty('totalRequests');
		expect(data).toHaveProperty('uptime');
		expect(data).toHaveProperty('version');
	});
});

describe('Config Endpoint', () => {
	test('returns current config', async () => {
		const response = await fetch(`${BASE_URL}:${serverPort}/config`, {
			headers: {
				Authorization: `Bearer ${authToken}`,
			},
		});

		expect(response.status).toBe(200);

		const data = (await response.json()) as { enabled: boolean; apps: Record<string, unknown> };
		expect(data).toHaveProperty('enabled');
		expect(data).toHaveProperty('apps');
	});

	test('requires authentication', async () => {
		const response = await fetch(`${BASE_URL}:${serverPort}/config`);
		expect(response.status).toBe(401);
	});

	test('updates config successfully', async () => {
		const configPayload = {
			enabled: true,
			apps: {
				'Claude Desktop': {
					enabled: true,
					modelMap: {
						'claude-3-opus-20240229': 'openai/gpt-4o',
					},
				},
			},
		};

		const response = await fetch(`${BASE_URL}:${serverPort}/config`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${authToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(configPayload),
		});

		expect(response.status).toBe(200);

		const data = (await response.json()) as { success: boolean };
		expect(data.success).toBe(true);
	});
});

describe('Proxy Enable/Disable', () => {
	test('enable starts proxy with API keys', async () => {
		// First disable if running
		await fetch(`${BASE_URL}:${serverPort}/proxy/disable`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${authToken}`,
			},
		});

		const enablePayload = {
			apiKeys: {
				openrouter: 'test-key',
			},
		};

		const response = await fetch(`${BASE_URL}:${serverPort}/proxy/enable`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${authToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(enablePayload),
		});

		expect(response.status).toBe(200);

		const data = (await response.json()) as { success: boolean; data?: { proxyUrl: string } };
		expect(data.success).toBe(true);
		expect(data.data).toHaveProperty('proxyUrl');
	});

	test('disable stops proxy', async () => {
		const response = await fetch(`${BASE_URL}:${serverPort}/proxy/disable`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${authToken}`,
			},
		});

		expect(response.status).toBe(200);

		const data = (await response.json()) as { success: boolean };
		expect(data.success).toBe(true);

		// Verify proxy stopped
		const statusResponse = await fetch(`${BASE_URL}:${serverPort}/status`, {
			headers: {
				Authorization: `Bearer ${authToken}`,
			},
		});
		const statusData = (await statusResponse.json()) as { running: boolean };
		expect(statusData.running).toBe(false);
	});
});

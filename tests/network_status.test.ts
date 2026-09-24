/**
 * tests/network_status.test.ts
 * Tests for NetworkStatusTool and network_status task type (#552).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { NetworkStatusTool } from '../backend/tools/NetworkStatusTool';

vi.mock('axios');

vi.mock('../backend/config', () => ({
  config: {
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_NETWORK: 'testnet',
  },
}));

vi.mock('../backend/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../backend/rpc_client', () => ({
  sorobanServer: {
    getHealth: vi.fn(),
  },
}));

describe('NetworkStatusTool', () => {
  let tool: NetworkStatusTool;
  let mockSorobanServer: { getHealth: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSorobanServer = {
      getHealth: vi.fn(),
    };
    tool = new NetworkStatusTool(
      'https://horizon-testnet.stellar.org',
      mockSorobanServer as any,
      'testnet'
    );
  });

  it('reports both services healthy when HTTP 200 and RPC healthy', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      statusText: 'OK',
    } as any);

    mockSorobanServer.getHealth.mockResolvedValue({
      status: 'healthy',
    });

    const result = await tool.execute();

    expect(result.network).toBe('testnet');
    expect(result.horizon.healthy).toBe(true);
    expect(result.horizon.status).toBe('OK');
    expect(result.horizon.latencyMs).toBeGreaterThanOrEqual(0);

    expect(result.soroban.healthy).toBe(true);
    expect(result.soroban.status).toBe('healthy');
    expect(result.soroban.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('considers Soroban status "pass" as healthy', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      statusText: 'OK',
    } as any);

    mockSorobanServer.getHealth.mockResolvedValue({
      status: 'pass',
    });

    const result = await tool.execute();
    expect(result.soroban.healthy).toBe(true);
    expect(result.soroban.status).toBe('pass');
  });

  it('marks Horizon unhealthy when HTTP request fails', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('Connection timeout'));
    mockSorobanServer.getHealth.mockResolvedValue({ status: 'healthy' });

    const result = await tool.execute();

    expect(result.horizon.healthy).toBe(false);
    expect(result.horizon.error).toBe('Connection timeout');
    expect(result.soroban.healthy).toBe(true);
  });

  it('marks Horizon unhealthy when status >= 400', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 503,
      statusText: 'Service Unavailable',
    } as any);
    mockSorobanServer.getHealth.mockResolvedValue({ status: 'healthy' });

    const result = await tool.execute();

    expect(result.horizon.healthy).toBe(false);
    expect(result.horizon.status).toBe('Service Unavailable');
  });

  it('marks Soroban unhealthy when getHealth rejects', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      statusText: 'OK',
    } as any);
    mockSorobanServer.getHealth.mockRejectedValue(new Error('Soroban RPC down'));

    const result = await tool.execute();

    expect(result.horizon.healthy).toBe(true);
    expect(result.soroban.healthy).toBe(false);
    expect(result.soroban.error).toBe('Soroban RPC down');
  });

  it('marks Soroban unhealthy when status is not healthy or pass', async () => {
    vi.mocked(axios.get).mockResolvedValue({
      status: 200,
      statusText: 'OK',
    } as any);
    mockSorobanServer.getHealth.mockResolvedValue({ status: 'degraded' });

    const result = await tool.execute();

    expect(result.soroban.healthy).toBe(false);
    expect(result.soroban.status).toBe('degraded');
  });

  it('uses default constructor arguments from config and default rpc server', () => {
    const defaultTool = new NetworkStatusTool();
    expect(defaultTool).toBeInstanceOf(NetworkStatusTool);
  });
});

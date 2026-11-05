import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { ProviderMcpServer } from '@/shared/types.js';

/**
 * Google agy MCP is managed with `agy mcp` on the CLI; this tab does not edit it.
 * Declaring no supported scopes makes listing return nothing and writes fail with
 * the shared "unsupported scope" error instead of touching agy's config.
 */
export class AgyMcpProvider extends McpProvider {
  constructor() {
    super('agy', [], []);
  }

  protected async readScopedServers(): Promise<Record<string, unknown>> {
    return {};
  }

  protected async writeScopedServers(): Promise<void> {
    // Unreachable: no scope is supported.
  }

  protected buildServerConfig(): Record<string, unknown> {
    return {};
  }

  protected normalizeServerConfig(): ProviderMcpServer | null {
    return null;
  }
}

/**
 * Static metadata reported when the MCP server is initialized.
 * Placeholder until the real MCP server is wired up in a later task.
 */
export const MCP_SERVER_INFO = {
  name: 'phelm-mcp',
  version: '0.0.1',
} as const;

export type McpServerInfo = typeof MCP_SERVER_INFO;

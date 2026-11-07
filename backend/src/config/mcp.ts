/**
 * The MCP server's consent page (routes/mcp.ts). A leaf module, so the sign-in
 * code (routes/auth.ts) can allow returning to it without importing the OAuth
 * provider and the tools, which would close an import cycle back to auth.ts.
 */
export const MCP_AUTHORIZE_PATH = '/oauth/authorize';

/** Read-only documentation MCP; financial tools remain in the separate calculations server. */
import { GET, POST } from '../site/api/mcp.js';

/** Vercel's Web Standard entrypoint dispatches to the host-independent docs adapter. */
export default {
  fetch(request: Request): Response | Promise<Response> {
    return request.method === 'POST' ? POST(request) : GET();
  },
};

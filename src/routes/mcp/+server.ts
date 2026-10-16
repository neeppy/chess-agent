import { publicUrl } from '#lib/server/http.ts';
import { handleMcpRequest } from '#lib/server/mcp.ts';
import type { RequestHandler } from './$types';

/** MCP over Streamable HTTP. Stateless, so only POST is used. */
export const POST: RequestHandler = ({ request }) => handleMcpRequest(request, publicUrl(request));

const notAllowed: RequestHandler = () =>
	new Response('This MCP server is stateless: use POST.', { status: 405, headers: { allow: 'POST' } });
export const GET = notAllowed;
export const DELETE = notAllowed;

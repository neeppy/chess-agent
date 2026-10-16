import docs from '../../../docs/http-api.md?raw';
import type { RequestHandler } from './$types';

/** The API reference, for agents that talk HTTP directly. */
export const GET: RequestHandler = () =>
	new Response(docs, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });

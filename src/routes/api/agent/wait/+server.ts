import { json } from '@sveltejs/kit';
import { game } from '#lib/server/game.ts';
import type { RequestHandler } from './$types';

/**
 * Long-poll until the agent has something to react to: its turn, the game ending, or a chat
 * message from the human. `timeout` is in seconds (default 240, max 3600; 0 = just check).
 */
export const GET: RequestHandler = async ({ url, request }) => {
	game.noteAgent();
	const raw = url.searchParams.get('timeout');
	const seconds = raw === null ? 240 : Math.min(Math.max(Number(raw) || 0, 0), 3600);
	return json(await game.waitForAgent(seconds * 1000, request.signal));
};

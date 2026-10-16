import { json } from '@sveltejs/kit';
import { game } from '#lib/server/game.ts';
import type { RequestHandler } from './$types';

/** Game state as the agent sees it. Marks unread messages (and a finished result) as seen. */
export const GET: RequestHandler = () => {
	game.noteAgent();
	return json(game.agentEvent(true));
};

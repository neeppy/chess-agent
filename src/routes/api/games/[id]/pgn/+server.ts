import { error } from '@sveltejs/kit';
import { game } from '#lib/server/game.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url }) => {
	const pgn = game.pgnOf(params.id);
	if (!pgn) error(404, 'Game not found');
	const headers: Record<string, string> = { 'content-type': 'application/x-chess-pgn; charset=utf-8' };
	if (url.searchParams.has('download'))
		headers['content-disposition'] = `attachment; filename="chess-${params.id}.pgn"`;
	return new Response(pgn.trimEnd() + '\n', { headers });
};

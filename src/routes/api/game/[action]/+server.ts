import { error } from '@sveltejs/kit';
import { game, GameError } from '#lib/server/game.ts';
import { asSide, readBody, respond } from '#lib/server/http.ts';
import { boardPng, boardSvg } from '#lib/server/render.ts';
import type { Color } from '#lib/types.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request }) => {
	const body = await readBody(request);
	return respond(() => {
		switch (params.action) {
			case 'move': {
				const result = game.move(
					asSide(body.as),
					body.move as string,
					body.message as string,
					body.enteredBy === 'agent' ? 'agent' : undefined
				);
				return { ok: true, ...result, game: game.view() };
			}
			case 'takeback':
				game.takeback();
				break;
			case 'resign':
				game.resign(asSide(body.as));
				break;
			case 'draw':
				game.draw(asSide(body.as), body.action as 'offer' | 'accept' | 'decline');
				break;
			case 'message':
				game.message(asSide(body.as), body.text as string);
				break;
			case 'new':
				game.newGame({
					humanColor: body.humanColor as Color | 'random',
					humanName: body.humanName as string,
					agentName: body.agentName as string,
					abandon: body.abandon === true
				});
				break;
			default:
				throw new GameError(`Unknown action "${params.action}".`, 404);
		}
		return { ok: true, game: game.view() };
	});
};

export const GET: RequestHandler = ({ params, url }) => {
	if (params.action === 'pgn') {
		const view = game.view();
		const headers: Record<string, string> = { 'content-type': 'application/x-chess-pgn; charset=utf-8' };
		if (url.searchParams.has('download'))
			headers['content-disposition'] = `attachment; filename="chess-${view.id}.pgn"`;
		return new Response(view.pgn + '\n', { headers });
	}

	if (params.action === 'board.svg' || params.action === 'board.png') {
		const view = game.view();
		const plyParam = url.searchParams.get('ply');
		let position: { fen: string; lastMove: { from: string; to: string } | null };
		try {
			position = plyParam === null ? { fen: view.fen, lastMove: view.lastMove } : game.positionAt(Number(plyParam));
		} catch (e) {
			error(400, (e as Error).message);
		}
		const orientation = url.searchParams.get('orientation') === 'black' ? 'black' : 'white';
		const size = Math.min(Math.max(Number(url.searchParams.get('size')) || 480, 160), 1600);
		const options = { ...position, orientation, size } as const;
		if (params.action === 'board.svg')
			return new Response(boardSvg(options), { headers: { 'content-type': 'image/svg+xml' } });
		return new Response(new Uint8Array(boardPng(options)), {
			headers: { 'content-type': 'image/png', 'cache-control': 'no-store' }
		});
	}

	error(404, `Unknown resource "${params.action}"`);
};

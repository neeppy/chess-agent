import { error } from '@sveltejs/kit';
import type { Color } from '#lib/types.ts';
import { readBody, respond, roomOr404, seatIn } from '#lib/server/http.ts';
import { boardPng, boardSvg } from '#lib/server/render.ts';
import { GameError } from '#lib/server/rooms.ts';
import type { RequestHandler } from './$types';

/** Room actions. Everything except `join` acts for a seat: pass its secret key as `seat`. */
export const POST: RequestHandler = async ({ params, request }) => {
	const room = roomOr404(params.code);
	const body = await readBody(request);
	return respond(() => {
		if (params.action === 'join')
			return room.join({
				color: (body.color as Color | 'any') ?? 'any',
				kind: body.kind === 'agent' ? 'agent' : 'human',
				name: body.name
			});

		const player = seatIn(room, body.seat);
		switch (params.action) {
			case 'whoami':
				return { playerId: player.id, name: player.name, kind: player.kind, colors: room.colorsOf(player.id) };
			case 'move': {
				const res = room.move(player, body.move as string, { message: body.message as string });
				return { ok: true, ...res, game: room.view() };
			}
			case 'takeback':
				room.takeback(player);
				break;
			case 'resign':
				room.resign(player);
				break;
			case 'draw':
				room.draw(player, body.action as 'offer' | 'accept' | 'decline');
				break;
			case 'message':
				room.message(player, body.text);
				break;
			case 'leave':
				room.leave(player);
				break;
			case 'rematch':
				room.rematch(player, { swap: body.swap !== false, abandon: body.abandon === true });
				break;
			default:
				throw new GameError(`Unknown action "${params.action}".`, 404);
		}
		return { ok: true, game: room.view() };
	});
};

export const GET: RequestHandler = ({ params, url }) => {
	const room = roomOr404(params.code);

	if (params.action === 'games') return respond(() => room.listGames());

	if (params.action === 'pgn') {
		const id = url.searchParams.get('game') ?? room.view().id;
		const pgn = room.pgnOf(id);
		if (!pgn) error(404, 'No such game in this room');
		const headers: Record<string, string> = { 'content-type': 'application/x-chess-pgn; charset=utf-8' };
		if (url.searchParams.has('download')) headers['content-disposition'] = `attachment; filename="chess-${id}.pgn"`;
		return new Response(pgn.trimEnd() + '\n', { headers });
	}

	if (params.action === 'board.svg' || params.action === 'board.png') {
		const view = room.view();
		const plyParam = url.searchParams.get('ply');
		let position: { fen: string; lastMove: { from: string; to: string } | null };
		try {
			position = plyParam === null ? { fen: view.fen, lastMove: view.lastMove } : room.positionAt(Number(plyParam));
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

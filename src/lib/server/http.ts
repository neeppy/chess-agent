import { error, json } from '@sveltejs/kit';
import { GameError, isGameError, rooms, type Room } from './rooms.ts';

export async function respond(fn: () => unknown | Promise<unknown>): Promise<Response> {
	try {
		return json(await fn());
	} catch (e) {
		if (isGameError(e)) return json({ error: e.message }, { status: e.status });
		throw e;
	}
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		return body && typeof body === 'object' ? body : {};
	} catch {
		return {};
	}
}

/**
 * The base URL agents should use to reach the app: CHESS_PUBLIC_URL if set, otherwise derived
 * from the request (honouring a reverse proxy's X-Forwarded-* headers). Plain http by default.
 */
export function publicUrl(request: Request): string {
	if (process.env.CHESS_PUBLIC_URL) return process.env.CHESS_PUBLIC_URL.replace(/\/+$/, '');
	const h = request.headers;
	const first = (name: string) => h.get(name)?.split(',')[0].trim();
	return `${first('x-forwarded-proto') || 'http'}://${first('x-forwarded-host') || h.get('host') || 'localhost:5199'}`;
}

/** The room for a route's `code` param, or a 404. */
export function roomOr404(code: string): Room {
	const room = rooms.get(code);
	if (!room) error(404, 'No such room');
	return room;
}

/** The player a seat key belongs to, which must be in `room`. */
export function seatIn(room: Room, key: unknown) {
	const found = rooms.byKey(key);
	if (!found || found.room !== room) throw new GameError('That seat key does not belong to this room.', 403);
	room.noteActivity(found.player);
	return found.player;
}

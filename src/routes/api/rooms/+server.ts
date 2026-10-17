import type { Color } from '#lib/types.ts';
import { readBody, respond } from '#lib/server/http.ts';
import { rooms } from '#lib/server/rooms.ts';
import type { RequestHandler } from './$types';

/** Create a room; with `join`, also take a seat in it. */
export const POST: RequestHandler = async ({ request }) => {
	const body = await readBody(request);
	return respond(() => {
		const room = rooms.create();
		const join = body.join as { color?: Color | 'any'; name?: string; kind?: 'human' | 'agent' } | undefined;
		if (!join) return { room: room.code, game: room.view() };
		const seat = room.join({ color: join.color ?? 'any', kind: join.kind === 'agent' ? 'agent' : 'human', name: join.name });
		return { room: room.code, ...seat };
	});
};

import { error, json } from '@sveltejs/kit';
import { describeEvent, waiterCommand } from '#lib/agent-text.ts';
import { publicUrl } from '#lib/server/http.ts';
import { rooms } from '#lib/server/rooms.ts';
import type { RequestHandler } from './$types';

const DEFAULT_HOURS = 8;

/**
 * Agent endpoints for one seat, addressed by its secret key:
 *
 *   GET next   the background waiter: an agent runs `curl -s <base>/api/seat/<key>/next` as a
 *              background command and ends its turn. The request stays open until the seat has
 *              something to react to, then prints it as text, which wakes the agent. Only one
 *              runs per seat: a new one replaces the previous one.
 *   GET wait   the same as JSON (`?timeout=<seconds>`, default 240, max 3600, 0 = just check)
 *   GET state  the current state as JSON; marks unread chat messages as read
 */
export const GET: RequestHandler = async ({ params, url, request }) => {
	const found = rooms.byKey(params.key);
	if (!found) error(404, 'Unknown seat key');
	const { room, player } = found;
	room.noteActivity(player);
	const timeout = (fallback: number, max: number) => {
		const raw = url.searchParams.get('timeout');
		return (raw === null ? fallback : Math.min(Math.max(Number(raw) || 0, 0), max)) * 1000;
	};

	if (params.action === 'state') return json(room.seatEvent(player, true));
	if (params.action === 'wait') return json(await room.waitFor(player, timeout(240, 3600), request.signal));

	if (params.action === 'next') {
		const ms = timeout(DEFAULT_HOURS * 3600, 24 * 3600);
		const ev = await room.waitFor(player, ms, request.signal, { exclusive: true });
		const base = publicUrl(request);
		const again = `run \`${waiterCommand(base, params.key)}\` in the background again`;
		let text: string;
		if (ev.ready) {
			text = describeEvent(ev, base);
			// On its turn the move tool's result says what to do next; otherwise remind it here.
			if (!ev.reasons.includes('your_turn') && !ev.reasons.includes('seat_lost'))
				text += `\n\nWhen you're done, ${again} to keep listening.`;
		} else if (ev.superseded) text = 'This waiter was replaced by a newer one. Nothing to do.';
		else text = `Nothing new yet (waited ${Math.round(ms / 60_000)} min). To keep waiting, ${again}.`;
		return new Response(text + '\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
	}

	error(404, `Unknown resource "${params.action}"`);
};

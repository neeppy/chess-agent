import { describeEvent, waiterCommand } from '#lib/agent-text.ts';
import { game } from '#lib/server/game.ts';
import { publicUrl } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

const DEFAULT_HOURS = 8;

/**
 * The background waiter: an agent runs `curl -s <base>/api/agent/next` as a background command
 * and ends its turn. The request stays open until the agent has something to react to, then
 * prints it as text, which wakes the agent (e.g. Claude Code notifies Claude when a background
 * command finishes). Only one runs at a time: a new one replaces the previous one.
 */
export const GET: RequestHandler = async ({ url, request }) => {
	game.noteAgent();
	const raw = url.searchParams.get('timeout');
	const seconds = raw === null ? DEFAULT_HOURS * 3600 : Math.min(Math.max(Number(raw) || 0, 0), 24 * 3600);
	const ev = await game.waitForAgent(seconds * 1000, request.signal, { exclusive: true });
	const again = `run \`${waiterCommand(publicUrl(request))}\` in the background again`;

	let text: string;
	if (ev.ready) {
		text = describeEvent(ev);
		// On its turn the move tool's result says what to do next; otherwise remind it here.
		if (!ev.reasons.includes('your_turn')) text += `\n\nWhen you're done, ${again} to keep listening.`;
	} else if (ev.superseded) text = 'This waiter was replaced by a newer one. Nothing to do.';
	else
		text = `No move from ${ev.game.humanName} yet (waited ${Math.round(seconds / 60)} min). To keep waiting, ${again}.`;

	return new Response(text + '\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
	afterMoveHint,
	cap,
	describeEvent,
	formatState,
	moveLabel,
	roomUrl,
	seatLink,
	statusLine,
	waitHint,
	waiterCommand
} from '#lib/agent-text.ts';
import type { Color } from '#lib/types.ts';
import { boardPng } from './render.ts';
import { GameError, isGameError, rooms, type Room } from './rooms.ts';

/**
 * MCP over Streamable HTTP at /mcp, stateless: every request gets a fresh server, so app
 * restarts (or container updates) never invalidate a client's session. Agents identify
 * themselves per call with the secret seat key they got when taking a seat.
 */

const DEFAULT_WAIT_MINUTES = Number(process.env.CHESS_WAIT_MINUTES) || 60;
const other = (c: Color): Color => (c === 'white' ? 'black' : 'white');

/** Name of the most recent MCP client to initialize, used as the default seat name. */
let clientLabel: string | undefined;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
function fail(e: unknown) {
	if (!isGameError(e)) console.error('[chess] MCP tool failed', e);
	return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
}

/** Turns the MCP client's self-reported name into the name shown in the UI and PGN. */
function agentLabel(client: string | undefined) {
	if (!client) return undefined;
	if (/claude/i.test(client)) return 'Claude';
	if (/codex/i.test(client)) return 'Codex';
	if (/cursor/i.test(client)) return 'Cursor';
	if (/gemini/i.test(client)) return 'Gemini';
	return client;
}

function bySeat(seat: string) {
	const found = rooms.byKey(seat);
	if (!found) throw new GameError('Unknown seat key. Use the key you got from create_room or join_room.', 404);
	found.room.noteActivity(found.player);
	return found;
}

function byRoom(code: string): Room {
	const room = rooms.get(code.replace(/^.*\/r\//, '').replace(/[#?].*$/, ''));
	if (!room) throw new GameError(`No room "${code}". A room code is the 6 letters/digits after /r/ in the room link.`, 404);
	return room;
}

const seatParam = z.string().describe('Your secret seat key (from create_room or join_room)');

const instructions = (base: string) => `Chess against humans or other agents, played in rooms at ${base}/r/<code>. Each room has a White and a Black seat; spectators can watch.

Taking a seat gives you a secret seat key. Every tool that acts takes it as \`seat\`: keep it for the whole game.
- The user wants to play you: create_room(play_as, opponent_name = their name). Send them the seat link from the result: it gives them their seat in the browser. They can move on the board, or tell you their moves in this conversation (play them with play_opponent_move; if a move is ambiguous or illegal, ask them, never pick for them).
- The user gives you a room code or link: join_room(room).

Each turn: choose a move from the legal moves and play it with move. Then wait for your opponent without blocking this conversation: if you can run shell commands in the background and get notified when they finish (as in Claude Code), run the waiter command from the move result in the background and end your turn. It finishes, printing the new position, when your opponent moves, writes in the chat, or the game ends. The move result tells you when a waiter is already running; don't start a second one. Only if you can't run background commands, call wait_for_turn instead.

The text board state is the source of truth; render_board is for showing or saving an image. Chat messages from the room reach you through the waiter; answer them with send_message.`;

function createServer(base: string, requestSignal: AbortSignal) {
	const server = new McpServer({ name: 'chess', version: '2.0.0' }, { instructions: instructions(base) });

	/** The seat summary returned when an agent takes a seat (which counts as having seen the position). */
	const seated = (room: Room, key: string, color: Color, intro: string[]) => {
		const g = room.seatEvent(rooms.byKey(key)!.player, true).game;
		const lines = [
			...intro,
			`Your seat: ${cap(color)}. Your seat key: ${key} (pass it as \`seat\` to every tool).`,
			g.status === 'active' && g.turn === color
				? 'It is your turn.'
				: g.status === 'waiting'
					? `Waiting for someone to take the ${cap(other(color))} seat. ${waitHint(g, color, base, key)}`
					: `${g.seats[other(color)]?.name} moves first. ${waitHint(g, color, base, key)}`,
			'',
			formatState(g, color, base)
		];
		return text(lines.join('\n'));
	};

	server.registerTool(
		'create_room',
		{
			title: 'Create a room',
			description:
				'Create a chess room. With play_as you take a seat yourself; with opponent_name as well, a seat is created for the human you are talking to, and you get a link that gives them that seat in their browser. You can then also enter the moves they tell you in this conversation (play_opponent_move).',
			inputSchema: {
				play_as: z.enum(['white', 'black', 'random']).optional().describe('Take a seat yourself (omit to only create the room)'),
				opponent_name: z.string().optional().describe("The human's name: creates their seat (requires play_as)"),
				name: z.string().optional().describe('Your name in the room (default: your client name, e.g. "Claude")')
			}
		},
		async ({ play_as, opponent_name, name }) => {
			try {
				const room = rooms.create();
				if (!play_as)
					return text(`Created room ${room.code}: ${roomUrl(base, room.code)}. Share the link: anyone with it can take a seat or watch. Join it yourself with join_room.`);
				const color: Color = play_as === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : play_as;
				const me = room.join({ color, kind: 'agent', name: name ?? clientLabel });
				const intro = [`Created room ${room.code}: ${roomUrl(base, room.code)}`];
				if (opponent_name) {
					const human = room.join({
						color: other(color),
						kind: 'human',
						name: opponent_name,
						relayedBy: room.player(me.playerId)!
					});
					intro.push(
						`${human.game.seats[other(color)]!.name} plays ${cap(other(color))}. Send them this link; it gives them their seat in the browser: ${seatLink(base, room.code, human.key)}`,
						'They can also tell you their moves in this conversation: play those with play_opponent_move.'
					);
				} else {
					intro.push('Share the room link: whoever takes the other seat plays you.');
				}
				return seated(room, me.key, color, intro);
			} catch (e) {
				return fail(e);
			}
		}
	);

	server.registerTool(
		'join_room',
		{
			title: 'Join a room',
			description:
				'Take a seat in a room, given its code or link. Returns your secret seat key. color "any" (the default) only takes a free seat. Naming a colour takes that seat even if someone holds it, and they lose it: only do that when the user asks you to.',
			inputSchema: {
				room: z.string().describe('Room code (e.g. "abc123") or link'),
				color: z.enum(['white', 'black', 'any']).optional().describe('Which seat (default: any free one). A named colour takes over an occupied seat.'),
				name: z.string().optional().describe('Your name in the room (default: your client name, e.g. "Claude")')
			}
		},
		async ({ room: code, color, name }) => {
			try {
				const room = byRoom(code);
				const me = room.join({ color: color ?? 'any', kind: 'agent', name: name ?? clientLabel });
				return seated(room, me.key, me.color, [`Joined room ${room.code}: ${roomUrl(base, room.code)}`]);
			} catch (e) {
				return fail(e);
			}
		}
	);

	server.registerTool(
		'view_board_state',
		{
			title: 'View board state',
			description:
				'Show a game: seats, whose turn it is, the board (ASCII + piece list), FEN, last move, material, move history, legal moves (on your turn), draw offers, and chat messages you have not seen yet. Pass your seat key, or just a room code to watch as a spectator.',
			inputSchema: {
				seat: seatParam.optional(),
				room: z.string().optional().describe('Room code, to view a room you have no seat in')
			},
			annotations: { readOnlyHint: true }
		},
		async ({ seat, room: code }) => {
			try {
				if (seat) {
					const { room, player } = bySeat(seat);
					const ev = room.seatEvent(player, true);
					return text(formatState(ev.game, ev.color, base, ev.messages));
				}
				if (!code) throw new GameError('Pass your seat key, or a room code.');
				return text(formatState(byRoom(code).view(), null, base));
			} catch (e) {
				return fail(e);
			}
		}
	);

	server.registerTool(
		'move',
		{
			title: 'Make a move',
			description:
				'Play your move. Accepts SAN ("Nf3", "exd5", "O-O", "e8=Q") or UCI ("g1f3", "e7e8q"). Fails with the legal moves if the move is illegal or it is not your turn. Optionally include a chat message. The result says how to wait for the reply.',
			inputSchema: {
				seat: seatParam,
				move: z.string().describe('The move in SAN or UCI notation'),
				message: z.string().optional().describe('Optional chat message sent with the move')
			}
		},
		async ({ seat, move, message }) => {
			try {
				const { room, player } = bySeat(seat);
				const res = room.move(player, move, { message });
				const g = room.view();
				const me = res.move.color;
				const lines = [`You played ${moveLabel(res.move)} (${res.move.uci}).`, ...res.notes];
				if (g.status === 'active' && g.inCheck) lines.push(`${g.seats[g.turn]?.name} is in check.`);
				lines.push(afterMoveHint(g, me, base, seat), `FEN: ${g.fen}`);
				return text(lines.join('\n'));
			} catch (e) {
				return fail(e);
			}
		}
	);

	server.registerTool(
		'play_opponent_move',
		{
			title: "Play your opponent's move",
			description:
				'Enter a move for your opponent when they tell it to you in this conversation, e.g. "knight e4" -> "Ne4", "pawn takes d5" -> "exd5", "castle short" -> "O-O". Only works for a seat you created for them with create_room(opponent_name). Pass YOUR seat key. If their move is ambiguous or illegal you get the options back: ask them, never choose for them. A waiter you have running keeps waiting (it does not fire for this move).',
			inputSchema: {
				seat: seatParam,
				move: z.string().describe("Your opponent's move in SAN or UCI, as they described it")
			}
		},
		async ({ seat, move }) => {
			try {
				const { room, player } = bySeat(seat);
				const res = room.move(player, move, { relay: true });
				const g = room.view();
				const me = room.colorsOf(player.id)[0] ?? null;
				const head = `Played ${g.seats[res.move.color]?.name}'s move ${moveLabel(res.move)} (${res.move.uci}).${g.status === 'active' ? " It's your turn now." : ''}`;
				return text(`${head}\n\n${formatState(g, me, base)}`);
			} catch (e) {
				return fail(e);
			}
		}
	);

	server.registerTool(
		'wait_for_turn',
		{
			title: 'Wait for your turn (blocking)',
			description: `Block until it is your turn, the game ends, or someone writes in the room chat, then return the board state. Returns immediately if it is already your turn. While this blocks, messages in this conversation can't reach you, so if you can run background commands, use the background waiter from the move result instead. Times out after timeout_minutes (default ${DEFAULT_WAIT_MINUTES}); call it again to keep waiting.`,
			inputSchema: {
				seat: seatParam,
				timeout_minutes: z
					.number()
					.min(0)
					.max(1440)
					.optional()
					.describe(`How long to wait before giving up (default ${DEFAULT_WAIT_MINUTES})`)
			}
		},
		async ({ seat, timeout_minutes }, extra) => {
			try {
				const { room, player } = bySeat(seat);
				const minutes = timeout_minutes ?? DEFAULT_WAIT_MINUTES;
				const signal = AbortSignal.any([extra.signal, requestSignal]);
				const started = Date.now();
				const progressToken = extra._meta?.progressToken;
				const ticker =
					progressToken === undefined
						? undefined
						: setInterval(() => {
								extra
									.sendNotification({
										method: 'notifications/progress',
										params: { progressToken, progress: Math.round((Date.now() - started) / 1000), message: 'Waiting for opponent' }
									})
									.catch(() => {});
							}, 30_000);
				try {
					const ev = await room.waitFor(player, minutes * 60_000, signal);
					if (ev.ready) return text(describeEvent(ev, base));
					if (signal.aborted) return text('Wait cancelled.');
					return text(`Still waiting after ${minutes} minute(s): ${statusLine(ev.game, ev.color)} Call wait_for_turn again to keep waiting.`);
				} finally {
					clearInterval(ticker);
				}
			} catch (e) {
				return fail(e);
			}
		}
	);

	server.registerTool(
		'render_board',
		{
			title: 'Render board image',
			description:
				'Render the board as a PNG and return the image, plus a URL it can be downloaded from (e.g. with curl -o) to save it to disk. Defaults to the current position from your side of the board.',
			inputSchema: {
				seat: seatParam.optional(),
				room: z.string().optional().describe('Room code, to render a room you have no seat in'),
				orientation: z.enum(['white', 'black']).optional().describe('Which side is at the bottom (default: your color)'),
				size: z.number().int().min(160).max(1600).optional().describe('Image size in pixels (default 480)'),
				ply: z.number().int().min(0).optional().describe('Render the position after this many half-moves instead of the current one')
			}
		},
		async ({ seat, room: code, orientation, size, ply }) => {
			try {
				const found = seat ? bySeat(seat) : null;
				const room = found?.room ?? (code ? byRoom(code) : null);
				if (!room) throw new GameError('Pass your seat key, or a room code.');
				const g = room.view();
				const at = ply ?? g.ply;
				const side = orientation ?? (found ? (room.colorsOf(found.player.id)[0] ?? 'white') : 'white');
				const px = size ?? 480;
				const png = boardPng({ ...room.positionAt(at), orientation: side, size: px });
				const url = `${base}/api/rooms/${room.code}/board.png?${new URLSearchParams({ ply: String(at), orientation: side, size: String(px) })}`;
				return {
					content: [
						{ type: 'text' as const, text: `Board after ${at} half-moves. To save it: curl -so board.png '${url}'` },
						{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }
					]
				};
			} catch (e) {
				return fail(e);
			}
		}
	);

	server.registerTool(
		'rematch',
		{
			title: 'Rematch',
			description:
				'Start a new game in the same room with the same players, swapping colours by default. Only when the players want one. A game in progress must be explicitly abandoned.',
			inputSchema: {
				seat: seatParam,
				swap_colors: z.boolean().optional().describe('Swap colours (default true)'),
				abandon_current: z.boolean().optional().describe('Abandon an unfinished game in progress')
			}
		},
		async ({ seat, swap_colors, abandon_current }) => {
			try {
				const { room, player } = bySeat(seat);
				room.rematch(player, { swap: swap_colors, abandon: abandon_current === true });
				const g = room.seatEvent(player, true).game;
				const me = room.colorsOf(player.id)[0] ?? null;
				const next = me && g.turn === me ? 'You have the first move.' : waitHint(g, me, base, seat);
				return text(`New game in room ${room.code}. You play ${me ? cap(me) : 'no seat'}. ${next}\n\n${formatState(g, me, base)}`);
			} catch (e) {
				return fail(e);
			}
		}
	);

	server.registerTool(
		'resign',
		{
			title: 'Resign',
			description: 'Resign the current game.',
			inputSchema: { seat: seatParam },
			annotations: { destructiveHint: true }
		},
		async ({ seat }) => {
			try {
				const { room, player } = bySeat(seat);
				room.resign(player);
				return text(statusLine(room.view(), room.colorsOf(player.id)[0] ?? null));
			} catch (e) {
				return fail(e);
			}
		}
	);

	server.registerTool(
		'offer_draw',
		{
			title: 'Offer a draw',
			description:
				'Offer your opponent a draw. The offer stays open until they accept, decline, or make a move (which declines it). You can still move after offering.',
			inputSchema: { seat: seatParam }
		},
		async ({ seat }) => {
			try {
				const { room, player } = bySeat(seat);
				room.draw(player, 'offer');
				const g = room.view();
				const me = room.colorsOf(player.id)[0] ?? null;
				if (g.status === 'finished') return text(statusLine(g, me));
				return text(
					`Draw offered. ${g.turn === me ? 'It is still your turn: make your move.' : waitHint(g, me, base, seat)}`
				);
			} catch (e) {
				return fail(e);
			}
		}
	);

	server.registerTool(
		'respond_to_draw',
		{
			title: 'Respond to a draw offer',
			description: "Accept or decline your opponent's pending draw offer.",
			inputSchema: { seat: seatParam, accept: z.boolean().describe('true to accept the draw, false to decline it') }
		},
		async ({ seat, accept }) => {
			try {
				const { room, player } = bySeat(seat);
				room.draw(player, accept ? 'accept' : 'decline');
				const status = statusLine(room.view(), room.colorsOf(player.id)[0] ?? null);
				return text(accept ? status : `Draw declined. ${status}`);
			} catch (e) {
				return fail(e);
			}
		}
	);

	server.registerTool(
		'send_message',
		{
			title: 'Send a chat message',
			description:
				'Send a message to the room chat (shown next to the board). Use it to answer messages written there; if your opponent talks to you in this conversation, just answer here.',
			inputSchema: { seat: seatParam, text: z.string().min(1).describe('The message') }
		},
		async ({ seat, text: message }) => {
			try {
				const { room, player } = bySeat(seat);
				room.message(player, message);
				return text('Message sent.');
			} catch (e) {
				return fail(e);
			}
		}
	);

	return server;
}

export async function handleMcpRequest(request: Request, base: string): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
	}

	// Remember the client's name: it becomes the default name for the seats it takes.
	const messages = (Array.isArray(body) ? body : [body]) as { method?: string; params?: any }[];
	const init = messages.find((m) => m?.method === 'initialize');
	if (init) clientLabel = agentLabel(init.params?.clientInfo?.name) ?? clientLabel;

	const server = createServer(base, request.signal);
	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	await server.connect(transport);
	request.signal.addEventListener('abort', () => void server.close(), { once: true });
	return transport.handleRequest(request, { parsedBody: body });
}

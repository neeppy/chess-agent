import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
	afterMoveHint,
	cap,
	describeEvent,
	formatState,
	moveLabel,
	statusLine,
	waitHint,
	waiterCommand
} from '#lib/agent-text.ts';
import { game, GameError } from './game.ts';
import { boardPng } from './render.ts';

/**
 * MCP over Streamable HTTP at /mcp, stateless: every request gets a fresh server, so app
 * restarts (or container updates) never invalidate a client's session.
 */

const DEFAULT_WAIT_MINUTES = Number(process.env.CHESS_WAIT_MINUTES) || 60;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
function fail(e: unknown) {
	if (!(e instanceof GameError)) console.error('[chess] MCP tool failed', e);
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

const instructions = (baseUrl: string) => `You are playing chess against a human. They play in a web UI (${baseUrl}), either on the board or by telling you their move in this conversation. You play through these tools.

Each turn:
1. If they tell you their move in this conversation ("knight e4", "pawn takes d5", "castle kingside"), play it for them with play_opponent_move. If it is ambiguous or illegal you get the options back: ask them, never pick for them. If they say they moved on the board, call view_board_state.
2. Choose a move from the legal moves and play it with move.
3. Wait for their reply without blocking this conversation. If you can run shell commands in the background and get notified when they finish (as in Claude Code), run \`${waiterCommand(baseUrl)}\` as a background command and end your turn. It finishes, printing the new position, when they move on the board, write in the web UI chat, or the game ends; meanwhile they can still talk to you here. The move tool's result tells you when a waiter is already running, in which case don't start another. Only if you can't run background commands, call wait_for_turn instead.

The text board state is the source of truth; render_board is for showing or saving an image. Messages typed in the web UI chat reach you through the waiter; answer them with send_message.`;

function createServer(baseUrl: string, requestSignal: AbortSignal) {
	const server = new McpServer({ name: 'chess', version: '1.0.0' }, { instructions: instructions(baseUrl) });

	server.registerTool(
		'view_board_state',
		{
			title: 'View board state',
			description:
				'Show the current game: whose turn it is, the board (ASCII + piece list), FEN, last move, material, move history, legal moves (on your turn), draw offers, and web UI chat messages you have not seen yet.',
			inputSchema: {},
			annotations: { readOnlyHint: true }
		},
		async () => {
			const ev = game.agentEvent(true);
			return text(formatState(ev.game, ev.messages));
		}
	);

	server.registerTool(
		'move',
		{
			title: 'Make a move',
			description:
				'Play your move. Accepts SAN ("Nf3", "exd5", "O-O", "e8=Q") or UCI ("g1f3", "e7e8q"). Fails with the legal moves if the move is illegal or it is not your turn. Optionally include a message for the web UI chat. The result says how to wait for the reply.',
			inputSchema: {
				move: z.string().describe('The move in SAN or UCI notation'),
				message: z.string().optional().describe('Optional message shown in the web UI chat alongside the move')
			}
		},
		async ({ move, message }) => {
			try {
				const res = game.move('agent', move, message);
				const g = game.view();
				const lines = [`You played ${moveLabel(res.move)} (${res.move.uci}).`, ...res.notes];
				if (g.status === 'active' && g.inCheck) lines.push(`${g.humanName} is in check.`);
				lines.push(afterMoveHint(g, baseUrl), `FEN: ${g.fen}`);
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
				'Play a move for your opponent (the human) when they tell you their move in this conversation instead of using the board, e.g. "knight e4" -> "Ne4", "pawn takes d5" -> "exd5", "castle short" -> "O-O". Accepts SAN or UCI. If their move is ambiguous or illegal you get an error with the options: ask them, never choose for them. Only relay moves they actually stated. A waiter you have running keeps waiting (it does not fire for this move).',
			inputSchema: {
				move: z.string().describe("Your opponent's move in SAN or UCI, as they described it")
			}
		},
		async ({ move }) => {
			try {
				const res = game.move('human', move, undefined, 'agent');
				const g = game.view();
				const head = `Played ${g.humanName}'s move ${moveLabel(res.move)} (${res.move.uci}).${g.status === 'active' ? " It's your turn now." : ''}`;
				return text(`${head}\n\n${formatState(g)}`);
			} catch (e) {
				return fail(e);
			}
		}
	);

	server.registerTool(
		'wait_for_turn',
		{
			title: 'Wait for your turn (blocking)',
			description: `Block until it is your turn, the game ends, or your opponent writes in the web UI chat, then return the board state. Returns immediately if it is already your turn. While this blocks, messages in this conversation can't reach you, so if you can run background commands, use the background waiter (\`${waiterCommand(baseUrl)}\`) instead. Times out after timeout_minutes (default ${DEFAULT_WAIT_MINUTES}); call it again to keep waiting.`,
			inputSchema: {
				timeout_minutes: z
					.number()
					.min(0)
					.max(1440)
					.optional()
					.describe(`How long to wait before giving up (default ${DEFAULT_WAIT_MINUTES})`)
			}
		},
		async ({ timeout_minutes }, extra) => {
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
									params: {
										progressToken,
										progress: Math.round((Date.now() - started) / 1000),
										message: 'Waiting for opponent'
									}
								})
								.catch(() => {});
						}, 30_000);
			try {
				const ev = await game.waitForAgent(minutes * 60_000, signal);
				if (ev.ready) return text(describeEvent(ev));
				if (signal.aborted) return text('Wait cancelled.');
				return text(
					`Still waiting after ${minutes} minute(s): ${ev.game.humanName} hasn't moved yet. Call wait_for_turn again to keep waiting.`
				);
			} finally {
				clearInterval(ticker);
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
				orientation: z.enum(['white', 'black']).optional().describe('Which side is at the bottom (default: your color)'),
				size: z.number().int().min(160).max(1600).optional().describe('Image size in pixels (default 480)'),
				ply: z.number().int().min(0).optional().describe('Render the position after this many half-moves instead of the current one')
			}
		},
		async ({ orientation, size, ply }) => {
			try {
				const g = game.view();
				const at = ply ?? g.ply;
				const side = orientation ?? g.agentColor;
				const px = size ?? 480;
				const png = boardPng({ ...game.positionAt(at), orientation: side, size: px });
				const url = `${baseUrl}/api/game/board.png?${new URLSearchParams({ ply: String(at), orientation: side, size: String(px) })}`;
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
		'new_game',
		{
			title: 'Start a new game',
			description:
				'Start a new game against the human. Only do this when the human asks for it. If a game is in progress it must be explicitly abandoned.',
			inputSchema: {
				your_color: z.enum(['white', 'black', 'random']).optional().describe('Your color (default random)'),
				opponent_name: z.string().optional().describe("The human's name, if you know it"),
				abandon_current: z.boolean().optional().describe('Abandon an unfinished game in progress')
			}
		},
		async ({ your_color, opponent_name, abandon_current }) => {
			try {
				game.newGame({
					humanColor: your_color === 'white' ? 'black' : your_color === 'black' ? 'white' : 'random',
					humanName: opponent_name,
					agentName: game.view().agent.name ?? undefined,
					abandon: abandon_current === true
				});
				const g = game.view();
				const next = g.turnSide === 'agent' ? 'You have the first move.' : `${g.humanName} moves first. ${waitHint(g, baseUrl)}`;
				return text(`New game started. You play ${cap(g.agentColor)}. ${next}\n\n${formatState(g)}`);
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
			inputSchema: {},
			annotations: { destructiveHint: true }
		},
		async () => {
			try {
				game.resign('agent');
				return text(statusLine(game.view()));
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
			inputSchema: {}
		},
		async () => {
			try {
				game.draw('agent', 'offer');
				const g = game.view();
				if (g.status === 'finished') return text(statusLine(g));
				return text(
					`Draw offered to ${g.humanName}. ${g.turnSide === 'agent' ? 'It is still your turn: make your move.' : waitHint(g, baseUrl)}`
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
			inputSchema: { accept: z.boolean().describe('true to accept the draw, false to decline it') }
		},
		async ({ accept }) => {
			try {
				game.draw('agent', accept ? 'accept' : 'decline');
				const g = game.view();
				return text(accept ? statusLine(g) : `Draw declined. ${statusLine(g)}`);
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
				'Send a message to the web UI chat panel. Use it to answer messages your opponent typed there; if they talk to you in this conversation, just answer here.',
			inputSchema: { text: z.string().min(1).describe('The message') }
		},
		async ({ text: message }) => {
			try {
				game.message('agent', message);
				return text('Message sent.');
			} catch (e) {
				return fail(e);
			}
		}
	);

	return server;
}

export async function handleMcpRequest(request: Request, baseUrl: string): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
			{ status: 400 }
		);
	}

	// Remember who is playing (shown in the UI and PGN) and that they're around.
	const messages = (Array.isArray(body) ? body : [body]) as { method?: string; params?: any }[];
	const init = messages.find((m) => m?.method === 'initialize');
	game.noteAgent(agentLabel(init?.params?.clientInfo?.name));

	const server = createServer(baseUrl, request.signal);
	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	await server.connect(transport);
	request.signal.addEventListener('abort', () => void server.close(), { once: true });
	return transport.handleRequest(request, { parsedBody: body });
}

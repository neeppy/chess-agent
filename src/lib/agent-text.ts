// Plain-text rendering of a room's game for agents, from the point of view of the seat they hold.
// Shared by the MCP tools and the background waiter endpoint.
import type { ChatMessage, Color, GameView, MoveInfo, SeatEvent } from './types.ts';

export const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const other = (c: Color): Color => (c === 'white' ? 'black' : 'white');
const ORDER = 'KQRBNP';

export const roomUrl = (base: string, room: string) => `${base}/r/${room}`;
/** Opening this link gives the browser the seat (the key stays in the fragment, never sent to the server). */
export const seatLink = (base: string, room: string, key: string) => `${base}/r/${room}#seat=${key}`;
/** The command an agent runs in the background to wait for its turn. */
export const waiterCommand = (base: string, key: string) => `curl -s ${base}/api/seat/${key}/next`;

function pieceList(fen: string) {
	const lists: Record<Color, string[]> = { white: [], black: [] };
	fen
		.split(' ')[0]
		.split('/')
		.forEach((row, i) => {
			let file = 0;
			for (const ch of row) {
				if (/\d/.test(ch)) {
					file += Number(ch);
					continue;
				}
				const color: Color = ch === ch.toUpperCase() ? 'white' : 'black';
				lists[color].push(ch.toUpperCase() + 'abcdefgh'[file] + (8 - i));
				file++;
			}
		});
	const sort = (l: string[]) => l.sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0])).join(' ');
	return `White: ${sort(lists.white)}\nBlack: ${sort(lists.black)}`;
}

export function moveLabel(m: MoveInfo) {
	return `${m.moveNumber}${m.color === 'white' ? '.' : '...'} ${m.san}`;
}

function moveText(g: GameView) {
	if (!g.moves.length) return '(no moves yet)';
	return g.moves.map((m) => (m.color === 'white' ? `${m.moveNumber}. ${m.san}` : m.san)).join(' ');
}

const nameOf = (g: GameView, c: Color) => g.seats[c]?.name ?? cap(c);

function seatLabel(g: GameView, c: Color, me: Color | null) {
	const s = g.seats[c];
	if (!s) return `${cap(c)}: empty seat`;
	return `${cap(c)}: ${s.name}${c === me ? ' (you)' : s.kind === 'agent' ? ' (AI agent)' : ''}`;
}

export function statusLine(g: GameView, me: Color | null) {
	if (g.status === 'finished') return `GAME OVER — ${g.termination ?? 'finished'} (${g.result}).`;
	if (g.status === 'waiting') return `Waiting for someone to take the ${g.seats.white ? 'Black' : 'White'} seat.`;
	const check = (who: string) => (g.inCheck ? ` ${who} in check.` : '');
	if (me === g.turn) return `YOUR TURN — you are ${cap(me)}, move ${g.moveNumber}.${check('You are')}`;
	const name = nameOf(g, g.turn);
	return `${me ? 'Waiting for ' : ''}${name} (${cap(g.turn)}) to move.${check(`${name} is`)}`;
}

function formatMessages(messages: ChatMessage[]) {
	return messages.map((m) => `  [${m.name ? `${m.name}${m.from ? `, ${cap(m.from)}` : ''}` : 'system'}] ${m.text}`).join('\n');
}

export function formatState(g: GameView, me: Color | null, base: string, messages: ChatMessage[] = []) {
	const lines = [
		`Room ${g.room} (${roomUrl(base, g.room)}), game ${g.id}. ${seatLabel(g, 'white', me)}; ${seatLabel(g, 'black', me)}.${me ? '' : ' You are not seated.'}`,
		`Status: ${statusLine(g, me)}`
	];
	if (g.lastMove)
		lines.push(
			`Last move: ${moveLabel(g.lastMove)} (${g.lastMove.uci}) by ${g.lastMove.color === me ? 'you' : nameOf(g, g.lastMove.color)}`
		);
	if (g.drawOffer && g.drawOffer === me) lines.push('Draw offer: you offered a draw; waiting for an answer.');
	else if (g.drawOffer && me)
		lines.push(`Draw offer: ${nameOf(g, g.drawOffer)} offers a draw. Accept with respond_to_draw(accept: true); making a move declines it.`);
	else if (g.drawOffer) lines.push(`Draw offer: ${nameOf(g, g.drawOffer)} offers a draw.`);
	const diff = g.material.white - g.material.black;
	lines.push(
		'',
		'Board (uppercase = White, lowercase = Black, White at the bottom):',
		g.ascii.trimEnd(),
		'',
		pieceList(g.fen),
		`Material: White ${g.material.white}, Black ${g.material.black} (${diff === 0 ? 'equal' : `${diff > 0 ? 'White' : 'Black'} +${Math.abs(diff)}`})`,
		`FEN: ${g.fen}`,
		`Moves: ${moveText(g)}`
	);
	if (g.status === 'active' && me === g.turn)
		lines.push(`Legal moves (${g.legalMoves.length}): ${g.legalMoves.map((m) => m.san).join(' ')}`);
	if (messages.length) lines.push('', 'Chat messages since you last looked:', formatMessages(messages));
	return lines.join('\n');
}

/** What happened, then the full state. */
export function describeEvent(ev: SeatEvent, base: string) {
	const g = ev.game;
	const me = ev.color;
	const head: string[] = [];
	if (ev.reasons.includes('seat_lost') && ev.lostSeat)
		head.push(
			`${ev.lostSeat.by} took over your ${cap(ev.lostSeat.color)} seat: you no longer play in this room. Don't start another waiter; you can still watch with view_board_state(room: "${g.room}"), or take a seat again with join_room if asked to.`
		);
	if (ev.reasons.includes('game_over')) head.push(`The game is over: ${g.termination ?? g.result}.`);
	if (ev.reasons.includes('your_turn') && me) {
		if (!g.lastMove)
			head.push(`${nameOf(g, other(me))} took the ${cap(other(me))} seat: the game is on, and you have the first move.`);
		else if (g.lastMove.color !== me) head.push(`${nameOf(g, g.lastMove.color)} played ${moveLabel(g.lastMove)}. It's your turn.`);
		else head.push(`It's your turn.`);
	}
	if (ev.reasons.includes('messages')) head.push('New chat messages (below): answer them with send_message.');
	return [...head, '', formatState(g, me, base, ev.messages)].join('\n');
}

/** How to wait for the opponent, given whether this seat already has a waiter running. */
export function waitHint(g: GameView, me: Color | null, base: string, key: string) {
	if (me && g.seats[me]?.waiting) return 'Your waiter is still running, so just end your turn.';
	return `Start the background waiter (\`${waiterCommand(base, key)}\`, run in the background) and end your turn; if you can't run background commands, call wait_for_turn instead.`;
}

/** What the agent should do once it has played (or the game ended). */
export function afterMoveHint(g: GameView, me: Color, base: string, key: string) {
	if (g.status === 'finished')
		return g.seats[me]?.waiting
			? statusLine(g, me)
			: `${statusLine(g, me)} To notice a rematch, start the background waiter (\`${waiterCommand(base, key)}\`).`;
	return `It is now ${nameOf(g, other(me))}'s turn. ${waitHint(g, me, base, key)}`;
}

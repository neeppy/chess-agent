// Plain-text rendering of the game for agents. Shared by the MCP server (run directly by Node,
// hence the relative, type-only imports) and the background waiter endpoint.
import type { AgentEvent, ChatMessage, Color, GameView, MoveInfo } from './types.ts';

export const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const ORDER = 'KQRBNP';

/** The command an agent runs in the background to wait for the human. */
export const waiterCommand = (baseUrl: string) => `curl -s ${baseUrl}/api/agent/next`;

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

export function statusLine(g: GameView) {
	if (g.status === 'finished') return `GAME OVER — ${g.termination ?? 'finished'} (${g.result}).`;
	if (g.turnSide === 'agent')
		return `YOUR TURN — you are ${cap(g.agentColor)}, move ${g.moveNumber}.${g.inCheck ? ' You are in CHECK.' : ''}`;
	return `Waiting for ${g.humanName} (${cap(g.humanColor)}) to move.${g.inCheck ? ` ${g.humanName} is in check.` : ''}`;
}

function formatMessages(messages: ChatMessage[], g: GameView) {
	return messages.map((m) => `  [${m.from === 'human' ? g.humanName : m.from}] ${m.text}`).join('\n');
}

export function formatState(g: GameView, messages: ChatMessage[] = []) {
	const lines = [
		`Game ${g.id}: ${g.white} (White) vs ${g.black} (Black). You (${g.agentName}) play ${cap(g.agentColor)}.`,
		`Status: ${statusLine(g)}`
	];
	if (g.lastMove)
		lines.push(
			`Last move: ${moveLabel(g.lastMove)} (${g.lastMove.uci}) by ${g.lastMove.color === g.agentColor ? 'you' : g.humanName}`
		);
	if (g.drawOffer === 'human')
		lines.push(
			`Draw offer: ${g.humanName} offers a draw. Accept with respond_to_draw(accept: true); making a move declines it.`
		);
	if (g.drawOffer === 'agent') lines.push(`Draw offer: you offered a draw; waiting for ${g.humanName} to respond.`);
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
	if (g.status === 'active' && g.turnSide === 'agent')
		lines.push(`Legal moves (${g.legalMoves.length}): ${g.legalMoves.map((m) => m.san).join(' ')}`);
	if (messages.length) lines.push('', 'Web UI chat messages since you last looked:', formatMessages(messages, g));
	return lines.join('\n');
}

/** What happened, then the full state. */
export function describeEvent(ev: AgentEvent) {
	const g = ev.game;
	const head: string[] = [];
	if (ev.reasons.includes('game_over')) head.push(`The game is over: ${g.termination ?? g.result}.`);
	if (ev.reasons.includes('your_turn')) {
		if (!g.lastMove) head.push(`New game: you play White and have the first move.`);
		else if (g.lastMove.color === g.humanColor)
			head.push(
				`${g.humanName} played ${moveLabel(g.lastMove)}${g.ply === 1 ? ' (new game, you play Black)' : ''}. It's your turn.`
			);
		else head.push(`It's your turn.`);
	}
	if (ev.reasons.includes('messages'))
		head.push(`${g.humanName} wrote to you in the web UI chat (below): answer with send_message.`);
	return [...head, '', formatState(g, ev.messages)].join('\n');
}

/** How to wait for the human, given whether a waiter is already running. */
export function waitHint(g: GameView, baseUrl: string) {
	if (g.agent.waiting) return 'Your waiter is still running, so just end your turn.';
	return `Start the background waiter (\`${waiterCommand(baseUrl)}\`, run in the background) and end your turn; if you can't run background commands, call wait_for_turn instead.`;
}

/** What the agent should do once it has played (or the game ended). */
export function afterMoveHint(g: GameView, baseUrl: string) {
	if (g.status === 'finished')
		return g.agent.waiting
			? statusLine(g)
			: `${statusLine(g)} To notice a rematch started from the web UI, start the background waiter (\`${waiterCommand(baseUrl)}\`).`;
	return `It is now ${g.humanName}'s turn. ${waitHint(g, baseUrl)}`;
}

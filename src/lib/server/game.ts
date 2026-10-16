import { Chess, DEFAULT_POSITION, type Move } from 'chess.js';
import type {
	AgentEvent,
	AgentReason,
	ChatMessage,
	Color,
	GameRecord,
	GameSummary,
	GameView,
	LegalMove,
	MoveInfo,
	Result,
	Side
} from '#lib/types.ts';
import * as store from './store';

const DEFAULT_AGENT_NAME = 'Agent';
const DEFAULT_HUMAN_NAME = 'Human';
const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export class GameError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

const other = (c: Color): Color => (c === 'white' ? 'black' : 'white');
const toColor = (c: 'w' | 'b'): Color => (c === 'w' ? 'white' : 'black');
const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);

function newGameId() {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	const rand = Math.random().toString(36).slice(2, 6);
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${rand}`;
}

function pgnDate(iso: string) {
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/** Accepts SAN ("Nf3", "exd5", "O-O", "e8=Q"), UCI ("g1f3", "e7e8q") and a few common variants. */
function normalizeMove(input: string): string {
	return input
		.trim()
		.replace(/[!?]+$/, '')
		.replace(/^0-0-0/, 'O-O-O')
		.replace(/^0-0/, 'O-O');
}

function toMoveInfo(m: Move, index: number): MoveInfo {
	return {
		ply: index + 1,
		moveNumber: Math.floor(index / 2) + 1,
		color: toColor(m.color),
		san: m.san,
		uci: m.lan,
		from: m.from,
		to: m.to,
		fen: m.after
	};
}

function newRecord(opts: {
	humanColor: Color;
	humanName: string;
	agentName: string;
}): GameRecord {
	const now = new Date().toISOString();
	return {
		id: newGameId(),
		createdAt: now,
		updatedAt: now,
		humanColor: opts.humanColor,
		humanName: opts.humanName,
		agentName: opts.agentName,
		moves: [],
		result: '*',
		termination: null,
		drawOffer: null,
		messages: [],
		agentReadMessageId: 0,
		agentSawResult: false
	};
}

type Listener = () => void;

class GameService {
	#record: GameRecord;
	#chess: Chess;
	// Seeded with the clock so it keeps increasing across server restarts.
	#version = Date.now();
	#listeners = new Set<Listener>();
	#agentConnections = new Map<number, string | null>();
	#nextConnectionId = 1;
	#waiting = 0;
	/** "<game id>:<ply>" of the last agent turn the agent is known to have seen. */
	#noticedTurn = '';
	/** Cancels the current exclusive (background) waiter, if any. */
	#cancelExclusive: (() => void) | null = null;
	/** Last time an agent talked to us (MCP request or agent endpoint), and what it calls itself. */
	#lastSeen = 0;
	#agentClientName: string | null = null;

	constructor() {
		const id = store.loadCurrentGameId();
		const record = id ? store.loadGame(id) : null;
		if (record) {
			this.#record = record;
			this.#chess = this.#safeReplay(record);
		} else {
			this.#record = newRecord({
				humanColor: 'white',
				humanName: DEFAULT_HUMAN_NAME,
				agentName: DEFAULT_AGENT_NAME
			});
			this.#chess = new Chess();
			this.#commit();
			store.saveCurrentGameId(this.#record.id);
		}
	}

	#safeReplay(record: GameRecord): Chess {
		const chess = new Chess();
		for (let i = 0; i < record.moves.length; i++) {
			try {
				chess.move(record.moves[i].san);
			} catch {
				console.warn(`[chess] dropping unreadable moves from ${record.id} starting at ply ${i + 1}`);
				record.moves = record.moves.slice(0, i);
				break;
			}
		}
		return chess;
	}

	// ---------------------------------------------------------------- reading

	get #finished() {
		return this.#record.result !== '*' || this.#record.termination !== null;
	}

	get #agentColor(): Color {
		return other(this.#record.humanColor);
	}

	#colorOf(side: Side): Color {
		return side === 'human' ? this.#record.humanColor : this.#agentColor;
	}

	#nameOf(color: Color) {
		return color === this.#record.humanColor ? this.#record.humanName : this.#record.agentName;
	}

	#turnSide(): Side {
		return toColor(this.#chess.turn()) === this.#record.humanColor ? 'human' : 'agent';
	}

	#pgn(): string {
		const c = this.#chess;
		const r = this.#record;
		c.setHeader('Event', 'Agentic Chess');
		c.setHeader('Site', 'Local');
		c.setHeader('Date', pgnDate(r.createdAt));
		c.setHeader('Round', '-');
		c.setHeader('White', this.#nameOf('white'));
		c.setHeader('Black', this.#nameOf('black'));
		c.setHeader('Result', r.result);
		if (r.termination) c.setHeader('Termination', r.termination);
		else c.removeHeader('Termination');
		return c.pgn();
	}

	#material() {
		const material: Record<Color, number> = { white: 0, black: 0 };
		for (const row of this.#chess.board())
			for (const sq of row) if (sq) material[toColor(sq.color)] += PIECE_VALUES[sq.type];
		return material;
	}

	view(): GameView {
		const r = this.#record;
		const c = this.#chess;
		const moves = c.history({ verbose: true }).map(toMoveInfo);
		const finished = this.#finished;
		const legalMoves: LegalMove[] = finished
			? []
			: c.moves({ verbose: true }).map((m) => ({
					san: m.san,
					uci: m.lan,
					from: m.from,
					to: m.to,
					...(m.promotion ? { promotion: m.promotion } : {})
				}));
		const names = [...this.#agentConnections.values()].filter(Boolean);
		return {
			id: r.id,
			version: this.#version,
			createdAt: r.createdAt,
			updatedAt: r.updatedAt,
			humanColor: r.humanColor,
			agentColor: this.#agentColor,
			humanName: r.humanName,
			agentName: r.agentName,
			white: this.#nameOf('white'),
			black: this.#nameOf('black'),
			startFen: DEFAULT_POSITION,
			fen: c.fen(),
			turn: toColor(c.turn()),
			turnSide: this.#turnSide(),
			ply: moves.length,
			moveNumber: c.moveNumber(),
			moves,
			lastMove: moves.at(-1) ?? null,
			inCheck: c.inCheck(),
			legalMoves,
			status: finished ? 'finished' : 'active',
			result: r.result,
			termination: r.termination,
			drawOffer: r.drawOffer,
			messages: r.messages,
			agentReadMessageId: r.agentReadMessageId,
			pgn: this.#pgn(),
			ascii: c.ascii(),
			material: this.#material(),
			agent: {
				connected: this.#agentConnections.size > 0,
				waiting: this.#waiting > 0,
				name: this.#agentClientName ?? (names.at(-1) as string | undefined) ?? null,
				lastSeen: this.#lastSeen ? new Date(this.#lastSeen).toISOString() : null,
				turnNoticed: this.#agentNoticedTurn()
			}
		};
	}

	/** FEN + last move at a given ply of the current game (for rendering past positions). */
	positionAt(ply: number) {
		const history = this.#chess.history({ verbose: true });
		if (!Number.isInteger(ply) || ply < 0 || ply > history.length)
			throw new GameError(`ply must be between 0 and ${history.length}`);
		if (ply === 0) return { fen: DEFAULT_POSITION, lastMove: null };
		const m = history[ply - 1];
		return { fen: m.after, lastMove: { from: m.from, to: m.to } };
	}

	listGames(): GameSummary[] {
		return store.listGames().map((g) => ({ ...g, current: g.id === this.#record.id }));
	}

	pgnOf(id: string): string | null {
		if (id === this.#record.id) return this.#pgn();
		return store.readPgn(id);
	}

	// ---------------------------------------------------------------- events

	subscribe(fn: Listener): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	#emit() {
		for (const fn of [...this.#listeners]) {
			try {
				fn();
			} catch (e) {
				console.error('[chess] listener failed', e);
			}
		}
	}

	#commit() {
		this.#record.updatedAt = new Date().toISOString();
		this.#version++;
		store.saveGame(this.#record, this.#pgn());
		this.#emit();
	}

	#addMessage(from: ChatMessage['from'], text: string) {
		const id = (this.#record.messages.at(-1)?.id ?? 0) + 1;
		this.#record.messages.push({
			id,
			from,
			text,
			ply: this.#record.moves.length,
			at: new Date().toISOString()
		});
	}

	// ---------------------------------------------------------------- actions

	#assertActive() {
		if (this.#finished)
			throw new GameError(
				`The game is over (${this.#record.termination ?? this.#record.result}). Start a new game to keep playing.`,
				409
			);
	}

	#finish(result: Result, termination: string, by?: Side) {
		const r = this.#record;
		r.result = result;
		r.termination = termination;
		r.drawOffer = null;
		if (by === 'agent') r.agentSawResult = true;
		this.#addMessage('system', `Game over: ${termination} (${result}).`);
	}

	#winResult(winner: Color): Result {
		return winner === 'white' ? '1-0' : '0-1';
	}

	#checkGameOver(by: Side) {
		const c = this.#chess;
		if (c.isCheckmate()) {
			const winner = other(toColor(c.turn()));
			this.#finish(this.#winResult(winner), `${this.#nameOf(winner)} won by checkmate`, by);
		} else if (c.isStalemate()) this.#finish('1/2-1/2', 'Draw by stalemate', by);
		else if (c.isInsufficientMaterial()) this.#finish('1/2-1/2', 'Draw by insufficient material', by);
		else if (c.isThreefoldRepetition()) this.#finish('1/2-1/2', 'Draw by threefold repetition', by);
		else if (c.isDrawByFiftyMoves()) this.#finish('1/2-1/2', 'Draw by fifty-move rule', by);
	}

	/**
	 * Fallback for input chess.js rejects but that clearly means one legal move: "Ne4" for "Nxe4",
	 * "d5" for "exd5". Several matches (e.g. two knights can reach e4, or a promotion without a
	 * piece) are reported as ambiguous instead of guessed.
	 */
	#resolveLoose(input: string, color: Color): string {
		const legal = this.#chess.moves({ verbose: true });
		const m = normalizeMove(input)
			.replace(/[\s+#x:=-]/g, '')
			.match(/^([KQRBN])?([a-h])?([1-8])?([a-h][1-8])([QRBNqrbn])?$/);
		const candidates = m
			? legal.filter(
					(mv) =>
						mv.piece === (m[1] ?? 'P').toLowerCase() &&
						mv.to === m[4] &&
						(!m[2] || mv.from[0] === m[2]) &&
						(!m[3] || mv.from[1] === m[3]) &&
						(!m[5] || mv.promotion === m[5].toLowerCase())
				)
			: [];
		if (candidates.length === 1) return candidates[0].san;
		if (candidates.length > 1)
			throw new GameError(
				`Ambiguous move "${input}": it could be ${candidates.map((c) => c.san).join(' or ')}.`,
				422
			);
		throw new GameError(
			`Illegal move "${input}" for ${capitalize(color)}. Legal moves: ${legal.map((l) => l.san).join(', ')}`,
			422
		);
	}

	/**
	 * Play a move for `side`. `enteredBy: 'agent'` with `side: 'human'` means the agent is relaying
	 * a move the human told it in a chat conversation.
	 */
	move(
		side: Side,
		input: string,
		message?: string,
		enteredBy?: Side
	): { move: MoveInfo; notes: string[] } {
		this.#assertActive();
		const r = this.#record;
		const color = this.#colorOf(side);
		const turn = toColor(this.#chess.turn());
		if (turn !== color)
			throw new GameError(
				`It is not ${side === 'agent' ? 'your' : `${r.humanName}'s`} turn: ${capitalize(turn)} (${this.#nameOf(turn)}) is to move.`,
				409
			);
		if (typeof input !== 'string' || !input.trim()) throw new GameError('Missing "move".');

		let played: Move;
		try {
			played = this.#chess.move(normalizeMove(input), { strict: false });
		} catch {
			played = this.#chess.move(this.#resolveLoose(input, color));
		}
		r.moves.push({ san: played.san, at: new Date().toISOString() });

		const notes: string[] = [];
		if (enteredBy === 'agent' && side === 'human') {
			// The agent relayed this move itself, so it already knows it is its turn: a pending
			// waiter should keep waiting for the human's next move instead of firing now.
			this.#noticedTurn = this.#turnKey();
			this.#addMessage(
				'system',
				`${this.#nameOf(other(color))} entered ${this.#nameOf(color)}'s move ${played.san} from the chat.`
			);
		}
		if (r.drawOffer && r.drawOffer !== side) {
			notes.push(`${this.#nameOf(other(color))}'s draw offer was declined by this move.`);
			this.#addMessage('system', `${this.#nameOf(color)} declined the draw offer by moving.`);
			r.drawOffer = null;
		}
		if (message?.trim()) this.#addMessage(side, message.trim().slice(0, 2000));
		this.#checkGameOver(side);
		this.#commit();
		return { move: toMoveInfo(played, r.moves.length - 1), notes };
	}

	/** Human-only: undo your last move (and the agent's reply, if it already answered). */
	takeback() {
		this.#assertActive();
		const r = this.#record;
		const count = this.#turnSide() === 'agent' ? 1 : 2;
		if (r.moves.length < count) throw new GameError('There is no move of yours to take back.', 409);
		for (let i = 0; i < count; i++) {
			this.#chess.undo();
			r.moves.pop();
		}
		r.drawOffer = null;
		this.#addMessage(
			'system',
			`${r.humanName} took back ${count === 1 ? 'their last move' : 'their last move and the reply'}.`
		);
		this.#commit();
	}

	resign(side: Side) {
		this.#assertActive();
		const winner = other(this.#colorOf(side));
		this.#finish(this.#winResult(winner), `${this.#nameOf(winner)} won by resignation`, side);
		this.#commit();
	}

	draw(side: Side, action: 'offer' | 'accept' | 'decline') {
		this.#assertActive();
		const r = this.#record;
		const me = this.#nameOf(this.#colorOf(side));
		const opponent = side === 'human' ? 'agent' : 'human';
		if (action === 'offer' && r.drawOffer === opponent) action = 'accept';

		if (action === 'offer') {
			if (r.drawOffer === side) throw new GameError('You already offered a draw.', 409);
			r.drawOffer = side;
			this.#addMessage('system', `${me} offers a draw.`);
		} else if (action === 'accept') {
			if (r.drawOffer !== opponent) throw new GameError('There is no draw offer to accept.', 409);
			this.#finish('1/2-1/2', 'Draw by agreement', side);
		} else if (action === 'decline') {
			if (r.drawOffer !== opponent) throw new GameError('There is no draw offer to decline.', 409);
			r.drawOffer = null;
			this.#addMessage('system', `${me} declined the draw offer.`);
		} else {
			throw new GameError('action must be "offer", "accept" or "decline".');
		}
		this.#commit();
	}

	message(side: Side, text: string) {
		if (typeof text !== 'string' || !text.trim()) throw new GameError('Message text is empty.');
		this.#addMessage(side, text.trim().slice(0, 2000));
		this.#commit();
	}

	newGame(opts: {
		humanColor?: Color | 'random';
		humanName?: string;
		agentName?: string;
		abandon?: boolean;
	}) {
		const prev = this.#record;
		if (!this.#finished && prev.moves.length > 0) {
			if (!opts.abandon)
				throw new GameError(
					'The current game is still in progress. Pass "abandon": true to abandon it and start a new one.',
					409
				);
			prev.termination = 'Game abandoned';
			this.#addMessage('system', 'Game abandoned.');
			this.#commit();
		} else if (prev.moves.length === 0 && !this.#finished) {
			store.deleteGame(prev.id);
		}

		const humanColor =
			opts.humanColor === 'white' || opts.humanColor === 'black'
				? opts.humanColor
				: Math.random() < 0.5
					? 'white'
					: 'black';
		const connectedName =
			this.#agentClientName ?? [...this.#agentConnections.values()].filter(Boolean).at(-1);
		this.#record = newRecord({
			humanColor,
			humanName: opts.humanName?.trim() || prev.humanName || DEFAULT_HUMAN_NAME,
			agentName: opts.agentName?.trim() || connectedName || prev.agentName || DEFAULT_AGENT_NAME
		});
		this.#chess = new Chess();
		this.#addMessage(
			'system',
			`New game: ${this.#nameOf('white')} (White) vs ${this.#nameOf('black')} (Black).`
		);
		this.#commit();
		store.saveCurrentGameId(this.#record.id);
	}

	// ---------------------------------------------------------------- agent

	/**
	 * Records agent activity (any MCP request or agent endpoint call), and the agent's name when
	 * it introduces itself. The UI treats an agent seen in the last few minutes as connected.
	 */
	noteAgent(name?: string) {
		const now = Date.now();
		const stale = now - this.#lastSeen > 30_000;
		this.#lastSeen = now;
		if (name && name !== this.#agentClientName) {
			this.#agentClientName = name;
			if (this.#record.agentName === DEFAULT_AGENT_NAME) {
				this.#record.agentName = name;
				return this.#commit();
			}
			return this.#emit();
		}
		if (stale) this.#emit();
	}

	/** Registers a live agent connection (an open event stream). Returns the disconnect function. */
	connectAgent(name: string | null): () => void {
		const id = this.#nextConnectionId++;
		this.#agentConnections.set(id, name);
		if (name && this.#record.agentName === DEFAULT_AGENT_NAME) {
			this.#record.agentName = name;
			this.#commit();
		} else {
			this.#emit();
		}
		return () => {
			if (this.#agentConnections.delete(id)) this.#emit();
		};
	}

	#turnKey() {
		return `${this.#record.id}:${this.#record.moves.length}`;
	}

	#agentNoticedTurn() {
		return !this.#finished && this.#turnSide() === 'agent' && this.#noticedTurn === this.#turnKey();
	}

	/** With `onlyNew`, a turn the agent has already seen doesn't count (used by pending waiters). */
	#agentReasons(onlyNew = false): AgentReason[] {
		const r = this.#record;
		const reasons: AgentReason[] = [];
		if (!this.#finished && this.#turnSide() === 'agent' && !(onlyNew && this.#agentNoticedTurn()))
			reasons.push('your_turn');
		if (this.#finished && !r.agentSawResult) reasons.push('game_over');
		if (r.messages.some((m) => m.from === 'human' && m.id > r.agentReadMessageId))
			reasons.push('messages');
		return reasons;
	}

	/**
	 * Snapshot for the agent. With `consume`, unread messages are marked as read and the
	 * game result is marked as seen, so they are only delivered once.
	 */
	agentEvent(consume: boolean): AgentEvent {
		const r = this.#record;
		const reasons = this.#agentReasons();
		const unread = r.messages.filter((m) => m.from !== 'agent' && m.id > r.agentReadMessageId);
		if (consume) {
			const noticed = reasons.includes('your_turn') && !this.#agentNoticedTurn();
			if (noticed) this.#noticedTurn = this.#turnKey();
			let changed = false;
			if (unread.length) {
				r.agentReadMessageId = unread.at(-1)!.id;
				changed = true;
			}
			if (this.#finished && !r.agentSawResult) {
				r.agentSawResult = true;
				changed = true;
			}
			if (changed) this.#commit();
			else if (noticed) this.#emit();
		}
		return {
			ready: reasons.length > 0,
			reasons,
			messages: consume ? unread : [],
			game: this.view()
		};
	}

	/**
	 * Long-poll: resolves as soon as the agent has something to react to (its turn, the game
	 * ending, or a message from the human in the web UI chat), or with `ready: false` after
	 * `timeoutMs`. Returns immediately if it is already the agent's turn.
	 *
	 * `exclusive` waiters (the background waiter) replace each other: starting one resolves the
	 * previous one with `superseded: true`, so an agent never ends up with two running.
	 */
	waitForAgent(
		timeoutMs: number,
		signal?: AbortSignal,
		opts: { exclusive?: boolean } = {}
	): Promise<AgentEvent> {
		if (opts.exclusive) this.#cancelExclusive?.();
		if (this.#agentReasons().length > 0) return Promise.resolve(this.agentEvent(true));
		if (timeoutMs <= 0 || signal?.aborted) return Promise.resolve(this.agentEvent(false));

		return new Promise((resolve) => {
			let settled = false;
			const finish = (ready: boolean, superseded = false) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				signal?.removeEventListener('abort', onAbort);
				if (this.#cancelExclusive === supersede) this.#cancelExclusive = null;
				this.#waiting--;
				const event = this.agentEvent(ready);
				this.#emit();
				resolve(superseded ? { ...event, superseded } : event);
			};
			const supersede = () => finish(false, true);
			const onAbort = () => finish(false);
			const timer = setTimeout(() => finish(false), timeoutMs);
			const unsubscribe = this.subscribe(() => {
				if (this.#agentReasons(true).length > 0) finish(true);
			});
			signal?.addEventListener('abort', onAbort);
			if (opts.exclusive) this.#cancelExclusive = supersede;
			this.#waiting++;
			this.#emit();
		});
	}
}

// One instance per process, created on first use (so `vite build` doesn't touch data/), and
// kept on globalThis so it survives Vite HMR in dev.
const g = globalThis as unknown as { __chessGame?: GameService };
export const game = new Proxy({} as GameService, {
	get(_, prop) {
		const instance = (g.__chessGame ??= new GameService());
		const value = Reflect.get(instance, prop, instance);
		return typeof value === 'function' ? value.bind(instance) : value;
	}
});

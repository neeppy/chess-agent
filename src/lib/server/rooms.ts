import crypto from 'node:crypto';
import { Chess, DEFAULT_POSITION, type Move } from 'chess.js';
import type {
	ChatMessage,
	Color,
	GameRecord,
	GameSummary,
	GameView,
	JoinResult,
	LegalMove,
	MoveInfo,
	PlayerKind,
	Result,
	SeatEvent,
	SeatReason,
	SeatView
} from '#lib/types.ts';
import * as store from './store';

const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const ROOM_CODE = /^[a-z0-9]{6}$/;

export class GameError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.name = 'GameError';
		this.status = status;
	}
}

/** By name rather than instanceof: in dev, Vite can reload this module under live rooms. */
export const isGameError = (e: unknown): e is GameError => e instanceof Error && e.name === 'GameError';

type Player = store.PlayerRow;

const other = (c: Color): Color => (c === 'white' ? 'black' : 'white');
const toColor = (c: 'w' | 'b'): Color => (c === 'w' ? 'white' : 'black');
const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);
export const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

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

function cleanName(name: unknown, kind: PlayerKind) {
	const n = typeof name === 'string' ? name.trim().slice(0, 40) : '';
	return n || (kind === 'agent' ? 'Agent' : 'Guest');
}

interface Presence {
	/** Open event streams (browser tabs). */
	connections: number;
	/** Pending waiters. */
	waiting: number;
	lastSeen: number;
	/** "<game id>:<ply>" of the last turn this player is known to have seen. */
	noticedTurn: string;
	/** Cancels this player's current exclusive (background) waiter. */
	cancelExclusive: (() => void) | null;
	/** Set when someone took over this player's seat, until the player has been told. */
	lostSeat: { color: Color; by: string } | null;
}

export class Room {
	readonly code: string;
	#game!: GameRecord;
	#chess!: Chess;
	#messages: store.MessageRow[] = [];
	#players = new Map<number, Player>();
	#presence = new Map<number, Presence>();
	#spectators = 0;
	#listeners = new Set<() => void>();
	// Seeded with the clock so it keeps increasing across server restarts.
	#version = Date.now();

	constructor(row: store.RoomRow) {
		this.code = row.code;
		for (const p of store.listPlayers(row.code)) this.#players.set(p.id, p);
		const game = row.currentGameId ? store.loadGame(row.currentGameId) : null;
		if (game) {
			this.#game = game;
			this.#chess = this.#replay(game);
			this.#messages = store.loadMessages(game.id);
		} else {
			this.#startGame(null, null);
		}
	}

	#replay(game: GameRecord): Chess {
		const chess = new Chess();
		for (let i = 0; i < game.moves.length; i++) {
			try {
				chess.move(game.moves[i].san);
			} catch {
				console.warn(`[chess] dropping unreadable moves from ${game.id} starting at ply ${i + 1}`);
				game.moves = game.moves.slice(0, i);
				break;
			}
		}
		return chess;
	}

	#startGame(whiteId: number | null, blackId: number | null) {
		const now = new Date().toISOString();
		this.#game = {
			id: newGameId(),
			room: this.code,
			createdAt: now,
			updatedAt: now,
			whiteId,
			blackId,
			moves: [],
			result: '*',
			termination: null,
			drawOffer: null
		};
		this.#chess = new Chess();
		this.#messages = [];
		store.saveGame(this.#game, this.#pgn());
		store.setCurrentGame(this.code, this.#game.id);
	}

	// ---------------------------------------------------------------- seats

	player(id: number): Player | null {
		return this.#players.get(id) ?? null;
	}

	#seatId(color: Color) {
		return color === 'white' ? this.#game.whiteId : this.#game.blackId;
	}

	#holder(color: Color): Player | null {
		const id = this.#seatId(color);
		return id === null ? null : (this.#players.get(id) ?? null);
	}

	/** Seats a player holds in the current game (both, if they play themselves). */
	colorsOf(playerId: number): Color[] {
		return (['white', 'black'] as const).filter((c) => this.#seatId(c) === playerId);
	}

	#name(color: Color) {
		return this.#holder(color)?.name ?? capitalize(color);
	}

	#presenceOf(id: number): Presence {
		let p = this.#presence.get(id);
		if (!p) {
			p = { connections: 0, waiting: 0, lastSeen: 0, noticedTurn: '', cancelExclusive: null, lostSeat: null };
			this.#presence.set(id, p);
		}
		return p;
	}

	// ---------------------------------------------------------------- reading

	get #finished() {
		return this.#game.result !== '*' || this.#game.termination !== null;
	}

	get #status(): GameView['status'] {
		if (this.#finished) return 'finished';
		return this.#game.whiteId !== null && this.#game.blackId !== null ? 'active' : 'waiting';
	}

	get #turn(): Color {
		return toColor(this.#chess.turn());
	}

	#turnKey() {
		return `${this.#game.id}:${this.#game.moves.length}`;
	}

	/** Whether it is this player's turn and they are known to have seen that. */
	#noticed(playerId: number) {
		return (
			this.#status === 'active' &&
			this.#seatId(this.#turn) === playerId &&
			this.#presenceOf(playerId).noticedTurn === this.#turnKey()
		);
	}

	#pgn(): string {
		const c = this.#chess;
		const g = this.#game;
		c.setHeader('Event', 'Agentic Chess');
		c.setHeader('Site', `Room ${this.code}`);
		c.setHeader('Date', pgnDate(g.createdAt));
		c.setHeader('Round', '-');
		c.setHeader('White', this.#holder('white')?.name ?? '?');
		c.setHeader('Black', this.#holder('black')?.name ?? '?');
		c.setHeader('Result', g.result);
		if (g.termination) c.setHeader('Termination', g.termination);
		else c.removeHeader('Termination');
		return c.pgn();
	}

	#material() {
		const material: Record<Color, number> = { white: 0, black: 0 };
		for (const row of this.#chess.board())
			for (const sq of row) if (sq) material[toColor(sq.color)] += PIECE_VALUES[sq.type];
		return material;
	}

	#seatView(color: Color): SeatView | null {
		const p = this.#holder(color);
		if (!p) return null;
		const presence = this.#presenceOf(p.id);
		return {
			playerId: p.id,
			name: p.name,
			kind: p.kind,
			connected: presence.connections > 0,
			waiting: presence.waiting > 0,
			lastSeen: presence.lastSeen ? new Date(presence.lastSeen).toISOString() : null,
			turnNoticed: this.#noticed(p.id),
			readMessageId: p.readMessageId,
			relayedBy: p.relayedBy
		};
	}

	#chatMessage(m: store.MessageRow): ChatMessage {
		const author = m.playerId === null ? null : this.#players.get(m.playerId);
		return {
			id: m.id,
			playerId: m.playerId,
			from: m.playerId === null ? null : (this.colorsOf(m.playerId)[0] ?? null),
			name: author?.name ?? null,
			text: m.text,
			ply: m.ply,
			at: m.at
		};
	}

	view(): GameView {
		const g = this.#game;
		const c = this.#chess;
		const moves = c.history({ verbose: true }).map(toMoveInfo);
		const legalMoves: LegalMove[] =
			this.#status === 'finished'
				? []
				: c.moves({ verbose: true }).map((m) => ({
						san: m.san,
						uci: m.lan,
						from: m.from,
						to: m.to,
						...(m.promotion ? { promotion: m.promotion } : {})
					}));
		return {
			room: this.code,
			id: g.id,
			version: this.#version,
			createdAt: g.createdAt,
			updatedAt: g.updatedAt,
			seats: { white: this.#seatView('white'), black: this.#seatView('black') },
			spectators: this.#spectators,
			startFen: DEFAULT_POSITION,
			fen: c.fen(),
			turn: this.#turn,
			ply: moves.length,
			moveNumber: c.moveNumber(),
			moves,
			lastMove: moves.at(-1) ?? null,
			inCheck: c.inCheck(),
			legalMoves,
			status: this.#status,
			result: g.result,
			termination: g.termination,
			drawOffer: g.drawOffer,
			messages: this.#messages.map((m) => this.#chatMessage(m)),
			pgn: this.#pgn(),
			ascii: c.ascii(),
			material: this.#material()
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
		return store.listGames(this.code).map((g) => ({ ...g, current: g.id === this.#game.id }));
	}

	pgnOf(id: string): string | null {
		if (id === this.#game.id) return this.#pgn();
		return store.loadGame(id)?.room === this.code ? store.readPgn(id) : null;
	}

	// ---------------------------------------------------------------- events

	subscribe(fn: () => void): () => void {
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
		this.#game.updatedAt = new Date().toISOString();
		this.#version++;
		store.saveGame(this.#game, this.#pgn());
		this.#emit();
	}

	#addMessage(playerId: number | null, text: string) {
		this.#messages.push(store.addMessage(this.#game.id, playerId, text, this.#game.moves.length));
	}

	/** An open event stream; `playerId` when it belongs to a seated player (for presence). */
	connect(playerId: number | null): () => void {
		const presence = playerId !== null && this.#players.has(playerId) ? this.#presenceOf(playerId) : null;
		if (presence) presence.connections++;
		else this.#spectators++;
		this.#emit();
		return () => {
			if (presence) presence.connections--;
			else this.#spectators--;
			this.#emit();
		};
	}

	/** Records that a player made a request. */
	noteActivity(player: Player) {
		const presence = this.#presenceOf(player.id);
		const stale = Date.now() - presence.lastSeen > 30_000;
		presence.lastSeen = Date.now();
		if (stale) this.#emit();
	}

	// ---------------------------------------------------------------- actions

	/**
	 * Take a seat. `any` only takes a free one; naming a colour takes that seat even if someone
	 * holds it (they lose it). In a finished game the claim starts the next game, so finished
	 * games keep the players who played them.
	 */
	join(opts: { color?: Color | 'any'; kind: PlayerKind; name?: unknown; relayedBy?: Player }): JoinResult {
		const empty = (['white', 'black'] as const).filter((c) => this.#seatId(c) === null);
		const wanted = opts.color ?? 'any';
		let color: Color;
		if (wanted === 'any') {
			if (!empty.length)
				throw new GameError('Both seats are taken. Name a colour to take over that seat, or just watch.', 409);
			color = empty[Math.floor(Math.random() * empty.length)];
		} else {
			if (wanted !== 'white' && wanted !== 'black') throw new GameError('color must be "white", "black" or "any".');
			color = wanted;
		}
		if (this.#finished) {
			this.#startGame(this.#game.whiteId, this.#game.blackId);
			this.#addMessage(null, 'New game.');
		}

		const key = crypto.randomBytes(18).toString('base64url');
		const player = store.createPlayer({
			room: this.code,
			keyHash: hashKey(key),
			kind: opts.kind,
			name: cleanName(opts.name, opts.kind),
			relayedBy: opts.relayedBy?.id ?? null
		});
		this.#players.set(player.id, player);
		const previous = this.#holder(color);
		const wasActive = this.#status === 'active';
		if (color === 'white') this.#game.whiteId = player.id;
		else this.#game.blackId = player.id;
		this.#presenceOf(player.id).lastSeen = Date.now();

		const who = `${player.name}${player.kind === 'agent' ? ' (AI agent)' : ''}`;
		if (previous) {
			// Their waiter (if they're an agent) wakes up and tells them to stop.
			if (!this.colorsOf(previous.id).length) this.#presenceOf(previous.id).lostSeat = { color, by: player.name };
			if (this.#game.drawOffer === color) this.#game.drawOffer = null;
			this.#addMessage(null, `${who} took over the ${capitalize(color)} seat from ${previous.name}.`);
		} else {
			this.#addMessage(null, `${who} took the ${capitalize(color)} seat.`);
		}
		// (cast: TypeScript narrows the getter through wasActive, not knowing the seat just changed)
		if (!wasActive && (this.#status as string) === 'active') this.#addMessage(null, `Game on: ${this.#name('white')} (White) vs ${this.#name('black')} (Black).`);
		this.#commit();
		return { key, playerId: player.id, color, game: this.view() };
	}

	#assertActive() {
		if (this.#finished)
			throw new GameError(
				`The game is over (${this.#game.termination ?? this.#game.result}). Start a rematch to keep playing.`,
				409
			);
		if (this.#status === 'waiting') {
			const empty = this.#game.whiteId === null ? 'White' : 'Black';
			throw new GameError(`Waiting for an opponent: the ${empty} seat is still empty.`, 409);
		}
	}

	/** The single seat a player acts for (the side to move if they hold both). */
	#seatFor(player: Player): Color {
		const mine = this.colorsOf(player.id);
		if (!mine.length) throw new GameError('You do not hold a seat in the current game.', 403);
		return mine.length === 2 ? this.#turn : mine[0];
	}

	#finish(result: Result, termination: string, by?: Player) {
		const g = this.#game;
		g.result = result;
		g.termination = termination;
		g.drawOffer = null;
		if (by) {
			by.seenResultGameId = g.id;
			store.savePlayerProgress(by);
		}
		this.#addMessage(null, `Game over: ${termination} (${result}).`);
	}

	#winResult(winner: Color): Result {
		return winner === 'white' ? '1-0' : '0-1';
	}

	#checkGameOver(by: Player) {
		const c = this.#chess;
		if (c.isCheckmate()) {
			const winner = other(this.#turn);
			this.#finish(this.#winResult(winner), `${this.#name(winner)} won by checkmate`, by);
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
			throw new GameError(`Ambiguous move "${input}": it could be ${candidates.map((c) => c.san).join(' or ')}.`, 422);
		throw new GameError(
			`Illegal move "${input}" for ${capitalize(color)}. Legal moves: ${legal.map((l) => l.san).join(', ')}`,
			422
		);
	}

	/**
	 * Play a move. With `relay`, an agent enters the move for the seat it created on behalf of its
	 * human (who told it the move in their conversation).
	 */
	move(player: Player, input: string, opts: { message?: string; relay?: boolean } = {}) {
		this.#assertActive();
		const turn = this.#turn;
		let mover = player;
		if (opts.relay) {
			const human = this.#holder(turn);
			if (!human || human.relayedBy !== player.id)
				throw new GameError(
					human && this.#seatId(turn) === player.id
						? "It's your own turn: use move, not play_opponent_move."
						: `You can only enter moves for a seat you created for your opponent. ${this.#name(turn)} moves on the board.`,
					403
				);
			mover = human;
		} else if (this.#seatId(turn) !== player.id) {
			this.#seatFor(player); // throws if they hold no seat
			throw new GameError(`It is not your turn: ${capitalize(turn)} (${this.#name(turn)}) is to move.`, 409);
		}
		if (typeof input !== 'string' || !input.trim()) throw new GameError('Missing "move".');

		let played: Move;
		try {
			played = this.#chess.move(normalizeMove(input), { strict: false });
		} catch {
			played = this.#chess.move(this.#resolveLoose(input, turn));
		}
		const g = this.#game;
		g.moves.push({ san: played.san, at: new Date().toISOString() });

		const notes: string[] = [];
		if (opts.relay) {
			// The agent entered this itself, so it knows it is its turn: a pending waiter should
			// keep waiting for the human's next move instead of firing now.
			this.#presenceOf(player.id).noticedTurn = this.#turnKey();
			this.#addMessage(null, `${player.name} entered ${mover.name}'s move ${played.san} from their conversation.`);
		}
		if (g.drawOffer && g.drawOffer !== turn) {
			notes.push(`${this.#name(other(turn))}'s draw offer was declined by this move.`);
			this.#addMessage(null, `${mover.name} declined the draw offer by moving.`);
			g.drawOffer = null;
		}
		if (opts.message?.trim() && !opts.relay) this.#addMessage(player.id, opts.message.trim().slice(0, 2000));
		this.#checkGameOver(player);
		this.#commit();
		return { move: toMoveInfo(played, g.moves.length - 1), notes };
	}

	/** Undo your last move (and the reply, if your opponent already answered). Only against agents. */
	takeback(player: Player) {
		this.#assertActive();
		const mine = this.colorsOf(player.id);
		if (!mine.length) throw new GameError('You do not hold a seat in the current game.', 403);
		const selfPlay = mine.length === 2;
		if (!selfPlay && this.#holder(other(mine[0]))?.kind !== 'agent')
			throw new GameError('Takebacks are only available against AI agents.', 409);
		const count = !selfPlay && mine.includes(this.#turn) ? 2 : 1;
		const g = this.#game;
		if (g.moves.length < count) throw new GameError('There is no move of yours to take back.', 409);
		for (let i = 0; i < count; i++) {
			this.#chess.undo();
			g.moves.pop();
		}
		g.drawOffer = null;
		this.#addMessage(null, `${player.name} took back ${count === 1 ? 'their last move' : 'their last move and the reply'}.`);
		this.#commit();
	}

	resign(player: Player) {
		this.#assertActive();
		const winner = other(this.#seatFor(player));
		this.#finish(this.#winResult(winner), `${this.#name(winner)} won by resignation`, player);
		this.#commit();
	}

	draw(player: Player, action: 'offer' | 'accept' | 'decline') {
		this.#assertActive();
		const mine = this.colorsOf(player.id);
		if (mine.length === 2) throw new GameError('You hold both seats; there is nobody to agree a draw with.', 409);
		const me = this.#seatFor(player);
		const opponent = other(me);
		const g = this.#game;
		if (action === 'offer' && g.drawOffer === opponent) action = 'accept';

		if (action === 'offer') {
			if (g.drawOffer === me) throw new GameError('You already offered a draw.', 409);
			g.drawOffer = me;
			this.#addMessage(null, `${player.name} offers a draw.`);
		} else if (action === 'accept') {
			if (g.drawOffer !== opponent) throw new GameError('There is no draw offer to accept.', 409);
			this.#finish('1/2-1/2', 'Draw by agreement', player);
		} else if (action === 'decline') {
			if (g.drawOffer !== opponent) throw new GameError('There is no draw offer to decline.', 409);
			g.drawOffer = null;
			this.#addMessage(null, `${player.name} declined the draw offer.`);
		} else {
			throw new GameError('action must be "offer", "accept" or "decline".');
		}
		this.#commit();
	}

	message(player: Player, text: unknown) {
		if (!this.colorsOf(player.id).length) throw new GameError('Take a seat to chat.', 403);
		if (typeof text !== 'string' || !text.trim()) throw new GameError('Message text is empty.');
		this.#addMessage(player.id, text.trim().slice(0, 2000));
		this.#commit();
	}

	/** Give up your seat. Only before the first move, so finished games keep their players. */
	leave(player: Player) {
		const mine = this.colorsOf(player.id);
		if (!mine.length) throw new GameError('You do not hold a seat in the current game.', 403);
		if (this.#finished || this.#game.moves.length > 0)
			throw new GameError('Seats can only be left before the first move. Resign instead.', 409);
		for (const c of mine) {
			if (c === 'white') this.#game.whiteId = null;
			else this.#game.blackId = null;
			this.#addMessage(null, `${player.name} left the ${capitalize(c)} seat.`);
		}
		this.#commit();
	}

	/** Start a new game in this room with the same players, swapping colours by default. */
	rematch(player: Player, opts: { swap?: boolean; abandon?: boolean } = {}) {
		if (!this.colorsOf(player.id).length) throw new GameError('You do not hold a seat in the current game.', 403);
		const g = this.#game;
		const swap = opts.swap !== false;
		if (!this.#finished && g.moves.length === 0) {
			// Nothing played yet: just swap the seats.
			if (!swap) throw new GameError('The game has not started yet; there is nothing to restart.', 409);
			[g.whiteId, g.blackId] = [g.blackId, g.whiteId];
			this.#addMessage(null, `${player.name} swapped colours: ${this.#name('white')} now plays White.`);
			this.#commit();
			return;
		}
		if (!this.#finished) {
			if (!opts.abandon)
				throw new GameError('The game is still in progress. Pass "abandon": true to abandon it and start a new one.', 409);
			g.termination = 'Game abandoned';
			this.#addMessage(null, `${player.name} abandoned the game.`);
			this.#commit();
		}
		const [whiteId, blackId] = swap ? [g.blackId, g.whiteId] : [g.whiteId, g.blackId];
		this.#startGame(whiteId, blackId);
		this.#addMessage(null, `New game: ${this.#name('white')} (White) vs ${this.#name('black')} (Black).`);
		this.#commit();
	}

	// ---------------------------------------------------------------- waiting (agents)

	/** With `onlyNew`, a turn the player has already seen doesn't count (used by pending waiters). */
	#reasons(player: Player, onlyNew = false): SeatReason[] {
		const mine = this.colorsOf(player.id);
		const reasons: SeatReason[] = [];
		if (this.#status === 'active' && mine.includes(this.#turn) && !(onlyNew && this.#noticed(player.id)))
			reasons.push('your_turn');
		if (this.#finished && mine.length && player.seenResultGameId !== this.#game.id) reasons.push('game_over');
		if (this.#messages.some((m) => m.playerId !== null && m.playerId !== player.id && m.id > player.readMessageId))
			reasons.push('messages');
		if (this.#presenceOf(player.id).lostSeat) reasons.push('seat_lost');
		return reasons;
	}

	/**
	 * What a seated player has to react to. With `consume`, unread messages are marked as read and
	 * a finished result as seen, so they are only delivered once.
	 */
	seatEvent(player: Player, consume: boolean): SeatEvent {
		const reasons = this.#reasons(player);
		const unread = this.#messages.filter((m) => m.playerId !== player.id && m.id > player.readMessageId);
		const lostSeat = this.#presenceOf(player.id).lostSeat ?? undefined;
		if (consume) {
			const presence = this.#presenceOf(player.id);
			presence.lostSeat = null;
			const noticed = reasons.includes('your_turn') && presence.noticedTurn !== this.#turnKey();
			if (noticed) presence.noticedTurn = this.#turnKey();
			let changed = false;
			if (unread.length) {
				player.readMessageId = unread.at(-1)!.id;
				changed = true;
			}
			if (reasons.includes('game_over')) {
				player.seenResultGameId = this.#game.id;
				changed = true;
			}
			if (changed) store.savePlayerProgress(player);
			if (changed || noticed) this.#emit();
		}
		return {
			ready: reasons.length > 0,
			reasons,
			color: this.colorsOf(player.id)[0] ?? null,
			messages: consume ? unread.map((m) => this.#chatMessage(m)) : [],
			game: this.view(),
			...(lostSeat ? { lostSeat } : {})
		};
	}

	/**
	 * Long-poll: resolves as soon as the player has something to react to (their turn, the game
	 * ending, or a chat message), or with `ready: false` after `timeoutMs`. Returns immediately if
	 * it already is their turn. `exclusive` waiters (the background waiter) replace each other.
	 */
	waitFor(player: Player, timeoutMs: number, signal?: AbortSignal, opts: { exclusive?: boolean } = {}): Promise<SeatEvent> {
		const presence = this.#presenceOf(player.id);
		if (opts.exclusive) presence.cancelExclusive?.();
		if (this.#reasons(player).length > 0) return Promise.resolve(this.seatEvent(player, true));
		if (timeoutMs <= 0 || signal?.aborted) return Promise.resolve(this.seatEvent(player, false));

		return new Promise((resolve) => {
			let settled = false;
			const finish = (ready: boolean, superseded = false) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				signal?.removeEventListener('abort', onAbort);
				if (presence.cancelExclusive === supersede) presence.cancelExclusive = null;
				presence.waiting--;
				const event = this.seatEvent(player, ready);
				this.#emit();
				resolve(superseded ? { ...event, superseded } : event);
			};
			const supersede = () => finish(false, true);
			const onAbort = () => finish(false);
			const timer = setTimeout(() => finish(false), timeoutMs);
			const unsubscribe = this.subscribe(() => {
				if (this.#reasons(player, true).length > 0) finish(true);
			});
			signal?.addEventListener('abort', onAbort);
			if (opts.exclusive) presence.cancelExclusive = supersede;
			presence.waiting++;
			presence.lastSeen = Date.now();
			this.#emit();
		});
	}
}

class Rooms {
	#rooms = new Map<string, Room>();

	get(code: string): Room | null {
		const normalized = code.trim().toLowerCase();
		if (!ROOM_CODE.test(normalized)) return null;
		let room = this.#rooms.get(normalized);
		if (!room) {
			const row = store.loadRoom(normalized);
			if (!row) return null;
			room = new Room(row);
			this.#rooms.set(normalized, room);
		}
		return room;
	}

	create(): Room {
		let code: string;
		do {
			code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
		} while (store.loadRoom(code));
		store.createRoom(code, new Date().toISOString());
		return this.get(code)!;
	}

	/** The room and player a secret seat key belongs to. */
	byKey(key: unknown): { room: Room; player: Player } | null {
		if (typeof key !== 'string' || !key) return null;
		const row = store.playerByKeyHash(hashKey(key));
		const room = row && this.get(row.room);
		const player = row && room?.player(row.id);
		return room && player ? { room, player } : null;
	}
}

// One registry per process, created on first use and kept on globalThis so it survives Vite HMR.
const g = globalThis as unknown as { __chessRooms?: Rooms };
export const rooms = new Proxy({} as Rooms, {
	get(_, prop) {
		const instance = (g.__chessRooms ??= new Rooms());
		const value = Reflect.get(instance, prop, instance);
		return typeof value === 'function' ? value.bind(instance) : value;
	}
});

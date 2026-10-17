// Shared between the SvelteKit server, the UI and the MCP tools (type-only imports).

export type Color = 'white' | 'black';
export type Result = '1-0' | '0-1' | '1/2-1/2' | '*';
/** Who holds a seat: a person in the browser, or an AI agent over MCP / HTTP. */
export type PlayerKind = 'human' | 'agent';

export interface ChatMessage {
	id: number;
	/** The author, or null for system messages. */
	playerId: number | null;
	/** The seat colour the author holds now (null for system messages, or authors who lost their seat). */
	from: Color | null;
	/** The author's name, or null for system messages. */
	name: string | null;
	text: string;
	/** Number of plies played when the message was sent. */
	ply: number;
	at: string;
}

/** A game as persisted (the room's chat lives in its own table). */
export interface GameRecord {
	id: string;
	room: string;
	createdAt: string;
	updatedAt: string;
	/** Player ids holding each seat, null while the seat is empty. */
	whiteId: number | null;
	blackId: number | null;
	/** Moves in SAN from the standard starting position, with when they were played (null for imported games). */
	moves: { san: string; at: string | null }[];
	result: Result;
	/** Human readable reason the game ended, e.g. "Claude won by checkmate". */
	termination: string | null;
	drawOffer: Color | null;
}

export interface MoveInfo {
	ply: number;
	/** Full-move number this move belongs to. */
	moveNumber: number;
	color: Color;
	san: string;
	uci: string;
	from: string;
	to: string;
	/** Position after the move. */
	fen: string;
}

export interface LegalMove {
	san: string;
	uci: string;
	from: string;
	to: string;
	promotion?: string;
}

export interface SeatView {
	playerId: number;
	name: string;
	kind: PlayerKind;
	/** The player holds an event stream open (a browser tab). */
	connected: boolean;
	/** The player has a waiter running (agents waiting for their turn). */
	waiting: boolean;
	/** Last time the player made a request. */
	lastSeen: string | null;
	/** On this seat's turn: whether the player is known to have seen it is their turn. */
	turnNoticed: boolean;
	/** Highest chat message id the player has been shown (agents). */
	readMessageId: number;
	/** Agent player allowed to enter moves for this seat (it created the seat for its human). */
	relayedBy: number | null;
}

export interface GameView {
	room: string;
	id: string;
	/** Bumped on every change to the room (not on presence changes). */
	version: number;
	createdAt: string;
	updatedAt: string;
	seats: Record<Color, SeatView | null>;
	/** Open event streams that don't belong to a seated player. */
	spectators: number;
	startFen: string;
	fen: string;
	turn: Color;
	ply: number;
	moveNumber: number;
	moves: MoveInfo[];
	lastMove: MoveInfo | null;
	inCheck: boolean;
	legalMoves: LegalMove[];
	/** `waiting` until both seats are taken. */
	status: 'waiting' | 'active' | 'finished';
	result: Result;
	termination: string | null;
	drawOffer: Color | null;
	messages: ChatMessage[];
	pgn: string;
	ascii: string;
	material: { white: number; black: number };
}

export type SeatReason = 'your_turn' | 'game_over' | 'messages' | 'seat_lost';

/** What a seated player (typically an agent) has to react to. */
export interface SeatEvent {
	ready: boolean;
	reasons: SeatReason[];
	/** The seat this player holds in the current game, if any. */
	color: Color | null;
	/** Chat messages the player has not seen before (now marked as read). */
	messages: ChatMessage[];
	game: GameView;
	/** A newer background waiter replaced this one. */
	superseded?: boolean;
	/** With `seat_lost`: the seat this player held and who took it over. */
	lostSeat?: { color: Color; by: string };
}

export interface JoinResult {
	/** Secret seat key: the only credential for acting as this player. */
	key: string;
	playerId: number;
	color: Color;
	game: GameView;
}

export interface GameSummary {
	id: string;
	room: string;
	createdAt: string;
	updatedAt: string;
	white: string | null;
	black: string | null;
	result: Result;
	termination: string | null;
	plies: number;
	current: boolean;
}

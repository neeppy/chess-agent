// Shared between the SvelteKit server, the UI and the MCP server (type-only imports).

export type Color = 'white' | 'black';
/** Who is acting: the person in the browser, or the agent connected over MCP / HTTP. */
export type Side = 'human' | 'agent';
export type Result = '1-0' | '0-1' | '1/2-1/2' | '*';

export interface ChatMessage {
	id: number;
	from: Side | 'system';
	text: string;
	/** Number of plies played when the message was sent. */
	ply: number;
	at: string;
}

/** What gets persisted to data/games/<id>.json. */
export interface GameRecord {
	id: string;
	createdAt: string;
	updatedAt: string;
	humanColor: Color;
	humanName: string;
	agentName: string;
	/** Moves in SAN from the standard starting position, with when they were played (null for imported games). */
	moves: { san: string; at: string | null }[];
	result: Result;
	/** Human readable reason the game ended, e.g. "Claude won by checkmate". */
	termination: string | null;
	drawOffer: Side | null;
	messages: ChatMessage[];
	/** Highest human message id the agent has been shown. */
	agentReadMessageId: number;
	/** Whether the agent has been told the game is over. */
	agentSawResult: boolean;
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

export interface Presence {
	/** An agent (MCP server) holds an event stream open. */
	connected: boolean;
	/** An agent is blocked in wait_for_turn right now. */
	waiting: boolean;
	name: string | null;
	/** Last time the agent called the MCP server or an agent endpoint. */
	lastSeen: string | null;
	/** On the agent's turn: whether the agent has seen that it's its turn. */
	turnNoticed: boolean;
}

export interface GameView {
	id: string;
	/** Bumped on every change to the game (not on presence changes). */
	version: number;
	createdAt: string;
	updatedAt: string;
	humanColor: Color;
	agentColor: Color;
	humanName: string;
	agentName: string;
	white: string;
	black: string;
	startFen: string;
	fen: string;
	turn: Color;
	turnSide: Side;
	ply: number;
	moveNumber: number;
	moves: MoveInfo[];
	lastMove: MoveInfo | null;
	inCheck: boolean;
	legalMoves: LegalMove[];
	status: 'active' | 'finished';
	result: Result;
	termination: string | null;
	drawOffer: Side | null;
	messages: ChatMessage[];
	/** Highest message id the agent has been shown (for "seen" markers). */
	agentReadMessageId: number;
	pgn: string;
	ascii: string;
	material: { white: number; black: number };
	agent: Presence;
}

export type AgentReason = 'your_turn' | 'game_over' | 'messages';

/** Returned by the agent wait endpoint once there is something for the agent to react to. */
export interface AgentEvent {
	ready: boolean;
	reasons: AgentReason[];
	/** Human messages the agent has not seen before (now marked as read). */
	messages: ChatMessage[];
	game: GameView;
	/** A newer background waiter replaced this one. */
	superseded?: boolean;
}

export interface GameSummary {
	id: string;
	createdAt: string;
	updatedAt: string;
	white: string;
	black: string;
	result: Result;
	termination: string | null;
	plies: number;
	current: boolean;
}

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Color, GameRecord, GameSummary, PlayerKind } from '#lib/types.ts';

/**
 * SQLite persistence: data/chess.db (WAL mode).
 *
 *   rooms     a URL (/r/<code>) hosting a series of games
 *   players   whoever took a seat in a room, identified by the hash of their secret seat key
 *   games     one game in a room; white_id / black_id point at players
 *   moves     SAN per ply
 *   messages  the chat, per game
 */
export const DATA_DIR = path.resolve(process.env.CHESS_DATA_DIR ?? 'data');
const DB_FILE = path.join(DATA_DIR, 'chess.db');

type Migration = string | ((d: Database.Database) => void);

const MIGRATIONS: Migration[] = [
	// v1: a single implicit game between "the human" and "the agent".
	`CREATE TABLE games (
		id                    TEXT PRIMARY KEY,
		created_at            TEXT NOT NULL,
		updated_at            TEXT NOT NULL,
		human_color           TEXT NOT NULL CHECK (human_color IN ('white', 'black')),
		human_name            TEXT NOT NULL,
		agent_name            TEXT NOT NULL,
		result                TEXT NOT NULL DEFAULT '*',
		termination           TEXT,
		draw_offer            TEXT,
		agent_read_message_id INTEGER NOT NULL DEFAULT 0,
		agent_saw_result      INTEGER NOT NULL DEFAULT 0,
		pgn                   TEXT NOT NULL DEFAULT ''
	);
	CREATE TABLE moves (
		game_id   TEXT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
		ply       INTEGER NOT NULL,
		san       TEXT NOT NULL,
		played_at TEXT,
		PRIMARY KEY (game_id, ply)
	);
	CREATE TABLE messages (
		game_id TEXT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
		id      INTEGER NOT NULL,
		sender  TEXT NOT NULL,
		text    TEXT NOT NULL,
		ply     INTEGER NOT NULL,
		at      TEXT NOT NULL,
		PRIMARY KEY (game_id, id)
	);
	CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE INDEX games_created_at ON games (created_at);`,

	// v2: rooms and seats. The v1 games move into a read-only room called "legacy".
	(d) => {
		d.exec(`
			CREATE TABLE rooms (
				code            TEXT PRIMARY KEY,
				created_at      TEXT NOT NULL,
				current_game_id TEXT
			);
			CREATE TABLE players (
				id                  INTEGER PRIMARY KEY,
				room_code           TEXT NOT NULL REFERENCES rooms (code) ON DELETE CASCADE,
				key_hash            TEXT UNIQUE,
				kind                TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
				name                TEXT NOT NULL,
				relayed_by          INTEGER REFERENCES players (id),
				created_at          TEXT NOT NULL,
				read_message_id     INTEGER NOT NULL DEFAULT 0,
				seen_result_game_id TEXT
			);
			CREATE TABLE games_v2 (
				id          TEXT PRIMARY KEY,
				room_code   TEXT NOT NULL REFERENCES rooms (code) ON DELETE CASCADE,
				created_at  TEXT NOT NULL,
				updated_at  TEXT NOT NULL,
				white_id    INTEGER REFERENCES players (id),
				black_id    INTEGER REFERENCES players (id),
				result      TEXT NOT NULL DEFAULT '*',
				termination TEXT,
				draw_offer  TEXT CHECK (draw_offer IN ('white', 'black')),
				pgn         TEXT NOT NULL DEFAULT ''
			);
			CREATE TABLE moves_v2 (
				game_id   TEXT NOT NULL REFERENCES games_v2 (id) ON DELETE CASCADE,
				ply       INTEGER NOT NULL,
				san       TEXT NOT NULL,
				played_at TEXT,
				PRIMARY KEY (game_id, ply)
			);
			CREATE TABLE messages_v2 (
				id        INTEGER PRIMARY KEY,
				game_id   TEXT NOT NULL REFERENCES games_v2 (id) ON DELETE CASCADE,
				player_id INTEGER REFERENCES players (id),
				text      TEXT NOT NULL,
				ply       INTEGER NOT NULL,
				at        TEXT NOT NULL
			);`);

		const old = d.prepare('SELECT * FROM games ORDER BY created_at').all() as {
			id: string;
			created_at: string;
			updated_at: string;
			human_color: Color;
			human_name: string;
			agent_name: string;
			result: string;
			termination: string | null;
			draw_offer: 'human' | 'agent' | null;
			agent_saw_result: number;
			pgn: string;
		}[];
		if (old.length) {
			d.prepare('INSERT INTO rooms (code, created_at, current_game_id) VALUES (?, ?, ?)').run(
				'legacy',
				old[0].created_at,
				old.at(-1)!.id
			);
			// Imported players have no seat key, so nobody can act for them: the room is read-only.
			const player = d.prepare(
				'INSERT INTO players (room_code, kind, name, created_at, seen_result_game_id) VALUES (?, ?, ?, ?, ?) RETURNING id'
			);
			const game = d.prepare(
				`INSERT INTO games_v2 (id, room_code, created_at, updated_at, white_id, black_id, result, termination, draw_offer, pgn)
				 VALUES (?, 'legacy', ?, ?, ?, ?, ?, ?, ?, ?)`
			);
			const message = d.prepare(
				'INSERT INTO messages_v2 (game_id, player_id, text, ply, at) VALUES (?, ?, ?, ?, ?)'
			);
			for (const g of old) {
				const human = (player.get('legacy', 'human', g.human_name, g.created_at, null) as { id: number }).id;
				const agent = (
					player.get('legacy', 'agent', g.agent_name, g.created_at, g.agent_saw_result ? g.id : null) as { id: number }
				).id;
				const agentColor: Color = g.human_color === 'white' ? 'black' : 'white';
				const ids = g.human_color === 'white' ? [human, agent] : [agent, human];
				const drawOffer = g.draw_offer === 'human' ? g.human_color : g.draw_offer === 'agent' ? agentColor : null;
				// Nobody can move for keyless players, so unfinished games can never be completed.
				const termination = g.termination ?? (g.result === '*' ? 'Game abandoned' : null);
				game.run(g.id, g.created_at, g.updated_at, ids[0], ids[1], g.result, termination, drawOffer, g.pgn);
				d.prepare('INSERT INTO moves_v2 SELECT game_id, ply, san, played_at FROM moves WHERE game_id = ?').run(g.id);
				const msgs = d
					.prepare('SELECT sender, text, ply, at FROM messages WHERE game_id = ? ORDER BY id')
					.all(g.id) as { sender: string; text: string; ply: number; at: string }[];
				for (const m of msgs)
					message.run(g.id, m.sender === 'human' ? human : m.sender === 'agent' ? agent : null, m.text, m.ply, m.at);
			}
			d.prepare('UPDATE players SET read_message_id = (SELECT coalesce(max(id), 0) FROM messages_v2)').run();
		}

		d.exec(`
			DROP TABLE messages;
			DROP TABLE moves;
			DROP TABLE games;
			DROP TABLE meta;
			ALTER TABLE games_v2 RENAME TO games;
			ALTER TABLE moves_v2 RENAME TO moves;
			ALTER TABLE messages_v2 RENAME TO messages;
			CREATE INDEX games_room ON games (room_code, created_at);
			CREATE INDEX messages_game ON messages (game_id, id);
			CREATE INDEX players_room ON players (room_code);`);
	}
];

let db: Database.Database | null = null;

/** Opened lazily so that importing this module (e.g. during `vite build`) touches nothing. */
function open(): Database.Database {
	if (db) return db;
	fs.mkdirSync(DATA_DIR, { recursive: true });
	const d = new Database(DB_FILE);
	d.pragma('journal_mode = WAL');
	d.pragma('synchronous = NORMAL');

	// Migrations rebuild tables, which needs foreign keys off (it can't change inside a transaction).
	d.pragma('foreign_keys = OFF');
	const version = d.pragma('user_version', { simple: true }) as number;
	for (let v = version; v < MIGRATIONS.length; v++) {
		const step = MIGRATIONS[v];
		d.transaction(() => {
			if (typeof step === 'string') d.exec(step);
			else step(d);
			const broken = d.pragma('foreign_key_check') as unknown[];
			if (broken.length) throw new Error(`migration ${v + 1} left ${broken.length} broken references`);
			d.pragma(`user_version = ${v + 1}`);
		})();
		if (v > 0) console.log(`[chess] database migrated to version ${v + 1}`);
	}
	d.pragma('foreign_keys = ON');
	db = d;
	return d;
}

// ------------------------------------------------------------------- rooms

export interface RoomRow {
	code: string;
	createdAt: string;
	currentGameId: string | null;
}

export function loadRoom(code: string): RoomRow | null {
	return (
		(open()
			.prepare('SELECT code, created_at AS createdAt, current_game_id AS currentGameId FROM rooms WHERE code = ?')
			.get(code) as RoomRow | undefined) ?? null
	);
}

export function createRoom(code: string, createdAt: string) {
	open().prepare('INSERT INTO rooms (code, created_at) VALUES (?, ?)').run(code, createdAt);
}

export function setCurrentGame(code: string, gameId: string) {
	open().prepare('UPDATE rooms SET current_game_id = ? WHERE code = ?').run(gameId, code);
}

// ------------------------------------------------------------------- players

export interface PlayerRow {
	id: number;
	room: string;
	kind: PlayerKind;
	name: string;
	relayedBy: number | null;
	readMessageId: number;
	seenResultGameId: string | null;
}

const PLAYER_COLUMNS = `id, room_code AS room, kind, name, relayed_by AS relayedBy,
	read_message_id AS readMessageId, seen_result_game_id AS seenResultGameId`;

export function createPlayer(p: {
	room: string;
	keyHash: string;
	kind: PlayerKind;
	name: string;
	relayedBy?: number | null;
}): PlayerRow {
	return open()
		.prepare(
			`INSERT INTO players (room_code, key_hash, kind, name, relayed_by, created_at, read_message_id)
			 VALUES (?, ?, ?, ?, ?, ?, (SELECT coalesce(max(id), 0) FROM messages))
			 RETURNING ${PLAYER_COLUMNS}`
		)
		.get(p.room, p.keyHash, p.kind, p.name, p.relayedBy ?? null, new Date().toISOString()) as PlayerRow;
}

export function listPlayers(room: string): PlayerRow[] {
	return open().prepare(`SELECT ${PLAYER_COLUMNS} FROM players WHERE room_code = ?`).all(room) as PlayerRow[];
}

export function playerByKeyHash(keyHash: string): PlayerRow | null {
	return (
		(open().prepare(`SELECT ${PLAYER_COLUMNS} FROM players WHERE key_hash = ?`).get(keyHash) as
			| PlayerRow
			| undefined) ?? null
	);
}

export function savePlayerProgress(p: PlayerRow) {
	open()
		.prepare('UPDATE players SET read_message_id = ?, seen_result_game_id = ? WHERE id = ?')
		.run(p.readMessageId, p.seenResultGameId, p.id);
}

// ------------------------------------------------------------------- games

interface GameRow {
	id: string;
	room_code: string;
	created_at: string;
	updated_at: string;
	white_id: number | null;
	black_id: number | null;
	result: GameRecord['result'];
	termination: string | null;
	draw_offer: Color | null;
}

export function loadGame(id: string): GameRecord | null {
	const d = open();
	const row = d.prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
	if (!row) return null;
	const moves = d
		.prepare('SELECT san, played_at AS at FROM moves WHERE game_id = ? ORDER BY ply')
		.all(id) as GameRecord['moves'];
	return {
		id: row.id,
		room: row.room_code,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		whiteId: row.white_id,
		blackId: row.black_id,
		moves,
		result: row.result,
		termination: row.termination,
		drawOffer: row.draw_offer
	};
}

export function saveGame(r: GameRecord, pgn: string) {
	const d = open();
	d.transaction(() => {
		d.prepare(
			`INSERT INTO games (id, room_code, created_at, updated_at, white_id, black_id, result, termination, draw_offer, pgn)
			 VALUES (@id, @room, @createdAt, @updatedAt, @whiteId, @blackId, @result, @termination, @drawOffer, @pgn)
			 ON CONFLICT (id) DO UPDATE SET
				updated_at = excluded.updated_at, white_id = excluded.white_id, black_id = excluded.black_id,
				result = excluded.result, termination = excluded.termination,
				draw_offer = excluded.draw_offer, pgn = excluded.pgn`
		).run({ ...r, pgn });
		// Moves can be taken back, so drop anything past the current length.
		d.prepare('DELETE FROM moves WHERE game_id = ? AND ply > ?').run(r.id, r.moves.length);
		const move = d.prepare('INSERT OR REPLACE INTO moves (game_id, ply, san, played_at) VALUES (?, ?, ?, ?)');
		r.moves.forEach((m, i) => move.run(r.id, i + 1, m.san, m.at));
	})();
}

export function deleteGame(id: string) {
	open().prepare('DELETE FROM games WHERE id = ?').run(id);
}

export function listGames(room: string): Omit<GameSummary, 'current'>[] {
	return open()
		.prepare(
			`SELECT g.id, g.room_code AS room, g.created_at AS createdAt, g.updated_at AS updatedAt,
				w.name AS white, b.name AS black, g.result, g.termination,
				(SELECT count(*) FROM moves WHERE moves.game_id = g.id) AS plies
			 FROM games g
			 LEFT JOIN players w ON w.id = g.white_id
			 LEFT JOIN players b ON b.id = g.black_id
			 WHERE g.room_code = ? ORDER BY g.created_at DESC`
		)
		.all(room) as Omit<GameSummary, 'current'>[];
}

export function readPgn(id: string): string | null {
	const row = open().prepare('SELECT pgn FROM games WHERE id = ?').get(id) as { pgn: string } | undefined;
	return row?.pgn ?? null;
}

// ------------------------------------------------------------------- chat

export interface MessageRow {
	id: number;
	playerId: number | null;
	text: string;
	ply: number;
	at: string;
}

export function addMessage(gameId: string, playerId: number | null, text: string, ply: number): MessageRow {
	return open()
		.prepare(
			`INSERT INTO messages (game_id, player_id, text, ply, at) VALUES (?, ?, ?, ?, ?)
			 RETURNING id, player_id AS playerId, text, ply, at`
		)
		.get(gameId, playerId, text, ply, new Date().toISOString()) as MessageRow;
}

export function loadMessages(gameId: string): MessageRow[] {
	return open()
		.prepare('SELECT id, player_id AS playerId, text, ply, at FROM messages WHERE game_id = ? ORDER BY id')
		.all(gameId) as MessageRow[];
}

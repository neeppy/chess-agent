import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ChatMessage, GameRecord, GameSummary } from '#lib/types.ts';

/**
 * SQLite persistence: data/chess.db (WAL mode). The game logic keeps the current game in memory
 * and calls saveGame() after every change, which syncs it in one transaction.
 */
export const DATA_DIR = path.resolve(process.env.CHESS_DATA_DIR ?? 'data');
const DB_FILE = path.join(DATA_DIR, 'chess.db');

const MIGRATIONS = [
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
	CREATE INDEX games_created_at ON games (created_at);`
];

let db: Database.Database | null = null;

/** Opened lazily so that importing this module (e.g. during `vite build`) touches nothing. */
function open(): Database.Database {
	if (db) return db;
	fs.mkdirSync(DATA_DIR, { recursive: true });
	db = new Database(DB_FILE);
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('foreign_keys = ON');

	const version = db.pragma('user_version', { simple: true }) as number;
	for (let v = version; v < MIGRATIONS.length; v++) {
		db.transaction(() => {
			db!.exec(MIGRATIONS[v]);
			db!.pragma(`user_version = ${v + 1}`);
		})();
	}
	importLegacyJson(db);
	return db;
}

// ------------------------------------------------------------------- rows

interface GameRow {
	id: string;
	created_at: string;
	updated_at: string;
	human_color: 'white' | 'black';
	human_name: string;
	agent_name: string;
	result: GameRecord['result'];
	termination: string | null;
	draw_offer: GameRecord['drawOffer'];
	agent_read_message_id: number;
	agent_saw_result: number;
	pgn: string;
}

function toRecord(d: Database.Database, row: GameRow): GameRecord {
	const moves = d
		.prepare('SELECT san, played_at AS at FROM moves WHERE game_id = ? ORDER BY ply')
		.all(row.id) as GameRecord['moves'];
	const messages = d
		.prepare('SELECT id, sender AS "from", text, ply, at FROM messages WHERE game_id = ? ORDER BY id')
		.all(row.id) as ChatMessage[];
	return {
		id: row.id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		humanColor: row.human_color,
		humanName: row.human_name,
		agentName: row.agent_name,
		moves,
		result: row.result,
		termination: row.termination,
		drawOffer: row.draw_offer,
		messages,
		agentReadMessageId: row.agent_read_message_id,
		agentSawResult: !!row.agent_saw_result
	};
}

function writeGame(d: Database.Database, r: GameRecord, pgn: string) {
	d.prepare(
		`INSERT INTO games (id, created_at, updated_at, human_color, human_name, agent_name, result,
			termination, draw_offer, agent_read_message_id, agent_saw_result, pgn)
		 VALUES (@id, @createdAt, @updatedAt, @humanColor, @humanName, @agentName, @result,
			@termination, @drawOffer, @agentReadMessageId, @agentSawResult, @pgn)
		 ON CONFLICT (id) DO UPDATE SET
			updated_at = excluded.updated_at, human_name = excluded.human_name,
			agent_name = excluded.agent_name, result = excluded.result,
			termination = excluded.termination, draw_offer = excluded.draw_offer,
			agent_read_message_id = excluded.agent_read_message_id,
			agent_saw_result = excluded.agent_saw_result, pgn = excluded.pgn`
	).run({ ...r, agentSawResult: r.agentSawResult ? 1 : 0, pgn });

	// Moves can be taken back, so drop anything past the current length.
	d.prepare('DELETE FROM moves WHERE game_id = ? AND ply > ?').run(r.id, r.moves.length);
	const move = d.prepare(
		'INSERT OR REPLACE INTO moves (game_id, ply, san, played_at) VALUES (?, ?, ?, ?)'
	);
	r.moves.forEach((m, i) => move.run(r.id, i + 1, m.san, m.at));

	// Messages are append-only.
	const message = d.prepare(
		'INSERT OR IGNORE INTO messages (game_id, id, sender, text, ply, at) VALUES (?, ?, ?, ?, ?, ?)'
	);
	for (const m of r.messages) message.run(r.id, m.id, m.from, m.text, m.ply, m.at);
}

// ------------------------------------------------------------------- API

export function loadGame(id: string): GameRecord | null {
	const d = open();
	const row = d.prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
	return row ? toRecord(d, row) : null;
}

export function saveGame(record: GameRecord, pgn: string) {
	const d = open();
	d.transaction(() => writeGame(d, record, pgn))();
}

export function deleteGame(id: string) {
	open().prepare('DELETE FROM games WHERE id = ?').run(id);
}

export function loadCurrentGameId(): string | null {
	const row = open().prepare("SELECT value FROM meta WHERE key = 'current_game_id'").get() as
		| { value: string }
		| undefined;
	return row?.value ?? null;
}

export function saveCurrentGameId(id: string) {
	writeCurrentGameId(open(), id);
}

function writeCurrentGameId(d: Database.Database, id: string) {
	d.prepare(
		"INSERT INTO meta (key, value) VALUES ('current_game_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
	).run(id);
}

export function listGames(): Omit<GameSummary, 'current'>[] {
	return open()
		.prepare(
			`SELECT id, created_at AS createdAt, updated_at AS updatedAt,
				CASE human_color WHEN 'white' THEN human_name ELSE agent_name END AS white,
				CASE human_color WHEN 'black' THEN human_name ELSE agent_name END AS black,
				result, termination,
				(SELECT count(*) FROM moves WHERE moves.game_id = games.id) AS plies
			 FROM games ORDER BY created_at DESC`
		)
		.all() as Omit<GameSummary, 'current'>[];
}

export function readPgn(id: string): string | null {
	const row = open().prepare('SELECT pgn FROM games WHERE id = ?').get(id) as { pgn: string } | undefined;
	return row?.pgn ?? null;
}

// ------------------------------------------------------------------- legacy import

/**
 * Earlier versions stored each game as data/games/<id>.json (+ .pgn) and the current game id in
 * data/current.json. Import them once into an empty database, then move the files aside.
 */
function importLegacyJson(d: Database.Database) {
	const gamesDir = path.join(DATA_DIR, 'games');
	const currentFile = path.join(DATA_DIR, 'current.json');
	if (!fs.existsSync(gamesDir)) return;
	const hasGames = (d.prepare('SELECT count(*) AS n FROM games').get() as { n: number }).n > 0;
	if (hasGames) return;

	const files = fs.readdirSync(gamesDir).filter((f) => f.endsWith('.json'));
	let imported = 0;
	d.transaction(() => {
		for (const file of files) {
			try {
				const legacy = JSON.parse(fs.readFileSync(path.join(gamesDir, file), 'utf8'));
				const pgnFile = path.join(gamesDir, file.replace(/\.json$/, '.pgn'));
				const pgn = fs.existsSync(pgnFile) ? fs.readFileSync(pgnFile, 'utf8').trimEnd() : '';
				const record: GameRecord = {
					...legacy,
					// Old records stored bare SAN strings without timestamps.
					moves: (legacy.moves as (string | GameRecord['moves'][number])[]).map((m) =>
						typeof m === 'string' ? { san: m, at: null } : m
					)
				};
				writeGame(d, record, pgn);
				imported++;
			} catch (e) {
				console.warn(`[chess] could not import ${file}:`, (e as Error).message);
			}
		}
		try {
			const { currentGameId } = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
			if (currentGameId) writeCurrentGameId(d, currentGameId);
		} catch {
			/* no current game */
		}
	})();

	const legacyDir = path.join(DATA_DIR, 'legacy-json');
	fs.mkdirSync(legacyDir, { recursive: true });
	fs.renameSync(gamesDir, path.join(legacyDir, 'games'));
	if (fs.existsSync(currentFile)) fs.renameSync(currentFile, path.join(legacyDir, 'current.json'));
	console.log(`[chess] imported ${imported} game(s) from JSON files into ${DB_FILE}; originals moved to ${legacyDir}`);
}

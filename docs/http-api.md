# Agentic Chess — HTTP API

Base URL: `http://localhost:5199`. All bodies are JSON: send `content-type: application/json` (form-encoded POSTs are rejected by SvelteKit's CSRF protection). Errors come back as `{ "error": "..." }` with a 4xx status.

Games are played in **rooms** (`/r/<code>`, 6 characters `a-z0-9`). Each room has a White and a Black seat. Taking a seat returns a secret **seat key**: every action for that seat passes it as `seat`. The same operations are available as MCP tools at `POST /mcp` (Streamable HTTP, stateless).

## Playing as an agent

```sh
# 1. Take a free seat (or create a room first: POST /api/rooms {"join": {...}})
curl -X POST localhost:5199/api/rooms/abc123/join -H 'content-type: application/json' \
  -d '{"kind":"agent","name":"My bot"}'
# -> { "key": "<seat key>", "playerId": 7, "color": "black", "game": {...} }

# 2. Look at the game from your seat (marks unread chat messages as read)
curl localhost:5199/api/seat/<seat key>/state

# 3. Move (SAN or UCI), optionally with a chat message
curl -X POST localhost:5199/api/rooms/abc123/move -H 'content-type: application/json' \
  -d '{"seat":"<seat key>","move":"Nf6","message":"Your move!"}'

# 4a. Wait for your turn as a background command (prints plain text when something happens)
curl -s localhost:5199/api/seat/<seat key>/next

# 4b. ...or block on the JSON long-poll (timeout in seconds)
curl 'localhost:5199/api/seat/<seat key>/wait?timeout=600'
```

Prefer 4a if your harness can run commands in the background and wake you when they finish (Claude Code can): you end your turn, so the human can still talk to you in your own conversation while you wait. Each seat keeps one `/next` request: starting a new one ends the previous one with "replaced by a newer one".

Both return as soon as **any** of these is true, otherwise they time out (`{ "ready": false }`, or a "nothing new yet" line from `/next`):

| reason      | when                                                         |
| ----------- | ------------------------------------------------------------ |
| `your_turn` | both seats are taken and it is your seat's turn              |
| `game_over` | the game ended and you haven't been told yet                 |
| `messages`  | someone wrote in the room chat and you haven't seen it yet   |

They return immediately if it is already your turn, so calling them in a loop is safe.

`/wait` and `/state` respond with a `SeatEvent`:

```jsonc
{
	"ready": true,
	"reasons": ["your_turn"],
	"color": "black",             // your seat in the current game
	"messages": [{ "id": 3, "from": "white", "name": "Cosmin", "text": "good luck", "ply": 0, "at": "..." }],
	"game": { /* GameView, see below */ }
}
```

## Endpoints

| Method | Path                                | Body / query                                                         | Notes |
| ------ | ----------------------------------- | -------------------------------------------------------------------- | ----- |
| POST   | `/api/rooms`                        | `{ "join"?: { "color"?: "white" \| "black" \| "any", "name"?, "kind"?: "human" \| "agent" } }` | Creates a room; with `join` also takes a seat (`JoinResult`) |
| GET    | `/api/rooms/<code>`                 |                                                                      | `GameView` of the room's current game |
| GET    | `/api/rooms/<code>/events`          | `?as=<playerId>`                                                     | Server-Sent Events: `state` with the full `GameView` on connect and after every change. Seated players pass `as` so they show as present; others count as spectators |
| POST   | `/api/rooms/<code>/join`            | `{ "color"?: "white" \| "black" \| "any", "name"?, "kind"? }`        | Takes a seat: `{ key, playerId, color, game }`. `"any"` (default) only takes a free seat (`409` if both are taken); a named colour takes over an occupied seat, whose previous holder loses it. In a finished game it starts the next game |
| POST   | `/api/rooms/<code>/move`            | `{ "seat", "move": "e4" \| "e2e4" \| "e8=Q", "message"? }`           | `409` if not your turn or a seat is still empty, `422` if illegal (lists the legal moves) or ambiguous (lists the candidates) |
| POST   | `/api/rooms/<code>/draw`            | `{ "seat", "action": "offer" \| "accept" \| "decline" }`             | An offer stays open until the opponent accepts/declines or makes a move |
| POST   | `/api/rooms/<code>/resign`          | `{ "seat" }`                                                         | |
| POST   | `/api/rooms/<code>/message`         | `{ "seat", "text" }`                                                 | Room chat |
| POST   | `/api/rooms/<code>/takeback`        | `{ "seat" }`                                                         | Undoes your last move (and the reply). Only against an agent |
| POST   | `/api/rooms/<code>/rematch`         | `{ "seat", "swap"?: true, "abandon"? }`                              | New game in the room with the same players. `409` while a game is in progress unless `"abandon": true` |
| POST   | `/api/rooms/<code>/leave`           | `{ "seat" }`                                                         | Frees your seat; only before the first move |
| POST   | `/api/rooms/<code>/whoami`          | `{ "seat" }`                                                         | `{ playerId, name, kind, colors }` for a seat key |
| GET    | `/api/rooms/<code>/games`           |                                                                      | Every game played in the room |
| GET    | `/api/rooms/<code>/pgn`             | `?game=<id>&download`                                                | PGN of the current (or given) game |
| GET    | `/api/rooms/<code>/board.png` / `board.svg` | `?orientation=white\|black&size=480&ply=<n>`                 | Board image; `ply` renders an earlier position |
| GET    | `/api/seat/<key>/next`              | `?timeout=<seconds>` (default 8h, max 24h)                           | Background waiter, plain text |
| GET    | `/api/seat/<key>/wait`              | `?timeout=<seconds>` (default 240, max 3600, `0` = check only)       | Long-poll, `SeatEvent` |
| GET    | `/api/seat/<key>/state`             |                                                                      | `SeatEvent`; marks unread chat messages as read |
| POST   | `/mcp`                              | MCP JSON-RPC                                                         | MCP server (Streamable HTTP, stateless). `GET`/`DELETE` return 405 |

## GameView

```ts
{
	room: string;             // "abc123"
	id: string;               // game id, e.g. "2026-10-17_211503_ab12"
	version: number;          // increases on every change
	seats: {
		white: Seat | null;     // null while the seat is free
		black: Seat | null;
	};
	spectators: number;
	fen: string;
	turn: 'white' | 'black';
	ply: number;              // half-moves played
	moveNumber: number;
	moves: { ply, moveNumber, color, san, uci, from, to, fen }[];
	lastMove: (same) | null;
	inCheck: boolean;
	legalMoves: { san, uci, from, to, promotion? }[];   // empty when the game is over
	status: 'waiting' | 'active' | 'finished';          // waiting until both seats are taken
	result: '1-0' | '0-1' | '1/2-1/2' | '*';
	termination: string | null;   // e.g. "Claude won by checkmate", "Draw by threefold repetition"
	drawOffer: 'white' | 'black' | null;
	messages: { id, from: 'white' | 'black' | null, name: string | null, text, ply, at }[];  // from null = system
	pgn: string;
	ascii: string;             // board as text, White at the bottom
	material: { white: number; black: number };
}

Seat = {
	playerId: number;
	name: string;
	kind: 'human' | 'agent';
	connected: boolean;        // has an event stream open
	waiting: boolean;          // has a waiter running
	lastSeen: string | null;
	turnNoticed: boolean;      // on its turn: has seen that it is its turn
	readMessageId: number;     // highest chat message it has been shown
	relayedBy: number | null;  // agent player allowed to enter moves for this seat
}
```

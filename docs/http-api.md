# Agentic Chess — HTTP API

Base URL: `http://localhost:5199`. All bodies are JSON: send `content-type: application/json` (form-encoded POSTs are rejected by SvelteKit's CSRF protection). Errors come back as `{ "error": "..." }` with a 4xx status.

There is one *current* game. The human plays from the web UI; an agent plays with `"as": "agent"`.
The same operations are available as MCP tools at `POST /mcp` (Streamable HTTP, stateless); everything below can also be done with `curl`.

## Playing as an agent

```sh
# 1. Look at the game (marks unread chat messages as read)
curl localhost:5199/api/agent/state

# 2. Move (SAN or UCI), optionally with a chat message
curl -X POST localhost:5199/api/game/move -H 'content-type: application/json' -d '{"as":"agent","move":"Nf6","message":"Your move!"}'

# 3a. Wait for the reply as a background command (prints plain text when something happens)
curl -s http://localhost:5199/api/agent/next

# 3b. ...or block on the JSON long-poll (timeout in seconds)
curl 'localhost:5199/api/agent/wait?timeout=600'
```

Prefer 3a if your harness can run commands in the background and wake you when they finish (Claude Code can): you end your turn, so the human can still talk to you in your own conversation while you wait. Only one `/api/agent/next` request is kept: starting a new one ends the previous one with "replaced by a newer one". A move you relay for the human (`"enteredBy": "agent"`) doesn't wake a pending waiter, since you already know about it.

Both return as soon as **any** of these is true, otherwise they time out (`{ "ready": false }`, or a "no move yet" line from `/next`):

| reason      | when                                                    |
| ----------- | ------------------------------------------------------- |
| `your_turn` | the game is active and it is the agent's turn           |
| `game_over` | the game ended and the agent hasn't been told yet       |
| `messages`  | the human wrote in the web UI chat and the agent hasn't seen it yet |

They return immediately if it is already the agent's turn, so calling them in a loop is safe.

`/api/agent/wait` responds with an `AgentEvent`:

```jsonc
{
	"ready": true,
	"reasons": ["your_turn"],
	"messages": [{ "id": 3, "from": "human", "text": "good luck", "ply": 0, "at": "..." }],
	"game": { /* GameView, see below */ }
}
```

## Endpoints

| Method | Path                                  | Body / query                                                       | Notes                                                                                           |
| ------ | ------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| GET    | `/api/game`                           |                                                                    | Current `GameView`                                                                              |
| GET    | `/api/agent/state`                    |                                                                    | `AgentEvent`; marks unread messages as read                                                     |
| GET    | `/api/agent/next`                     | `?timeout=<seconds>` (default 8h, max 24h)                         | Background waiter: same triggers as `wait`, answers in plain text describing what happened and the position |
| GET    | `/api/agent/wait`                     | `?timeout=<seconds>` (default 240, max 3600, `0` = check only)     | Long-poll, see above. Keep it under 300s if your HTTP client has a response timeout             |
| POST   | `/api/game/move`                      | `{ "as": "agent", "move": "e4" \| "e2e4" \| "e8=Q", "message"? }` | `409` if not your turn, `422` if illegal (lists the legal moves) or ambiguous (lists the candidates). To relay a move the human told you in chat, send `"as": "human", "enteredBy": "agent"` |
| POST   | `/api/game/draw`                      | `{ "as": "agent", "action": "offer" \| "accept" \| "decline" }`    | An offer stays open until the opponent accepts/declines or makes a move                         |
| POST   | `/api/game/resign`                    | `{ "as": "agent" }`                                                |                                                                                                 |
| POST   | `/api/game/message`                   | `{ "as": "agent", "text": "..." }`                                 | Chat, shown in the UI                                                                           |
| POST   | `/api/game/new`                       | `{ "humanColor": "white" \| "black" \| "random", "humanName"?, "agentName"?, "abandon"? }` | `409` if a game is in progress unless `"abandon": true`                                         |
| POST   | `/api/game/takeback`                  |                                                                    | Human only: undoes the human's last move (and the agent's reply)                                |
| GET    | `/api/game/pgn`                       | `?download`                                                        | PGN of the current game                                                                         |
| GET    | `/api/game/board.png` / `board.svg`   | `?orientation=white\|black&size=480&ply=<n>`                       | Board image; `ply` renders an earlier position                                                  |
| GET    | `/api/games`                          |                                                                    | All saved games (summaries)                                                                     |
| GET    | `/api/games/<id>/pgn`                 | `?download`                                                        | PGN of any saved game                                                                           |
| POST   | `/mcp`                                | MCP JSON-RPC                                                       | MCP server (Streamable HTTP, stateless). `GET`/`DELETE` return 405                              |
| GET    | `/api/events`                         | `?client=agent&name=<name>`                                        | Server-Sent Events: `state` event with the full `GameView` on connect and after every change    |

Agents that hold `/api/events?client=agent` open show up as "connected" in the UI.

## GameView

```ts
{
	id: string;               // e.g. "2026-10-17_211503_ab12"
	version: number;          // increases on every change
	humanColor, agentColor: 'white' | 'black';
	humanName, agentName, white, black: string;
	fen: string;
	turn: 'white' | 'black';
	turnSide: 'human' | 'agent';
	ply: number;              // half-moves played
	moveNumber: number;
	moves: { ply, moveNumber, color, san, uci, from, to, fen }[];
	lastMove: (same) | null;
	inCheck: boolean;
	legalMoves: { san, uci, from, to, promotion? }[];   // empty when the game is over
	status: 'active' | 'finished';
	result: '1-0' | '0-1' | '1/2-1/2' | '*';
	termination: string | null;   // e.g. "Claude won by checkmate", "Draw by threefold repetition"
	drawOffer: 'human' | 'agent' | null;
	messages: { id, from: 'human' | 'agent' | 'system', text, ply, at }[];
	pgn: string;
	ascii: string;             // board as text, White at the bottom
	material: { white: number; black: number };
	agent: { connected: boolean; waiting: boolean; name: string | null; lastSeen: string | null; turnNoticed: boolean };
}
```

# Agentic Chess

Play chess in the browser against an AI agent (Claude Code, Codex, or anything that speaks MCP or HTTP). Self-hostable as a single container.

- Legal moves only (rules by [chess.js](https://github.com/jhlywa/chess.js), board by lichess' [chessground](https://github.com/lichess-org/chessground)).
- Games live in a **SQLite** database and are saved after every move: close the tab, restart the container, come back tomorrow, it picks up where you left off.
- Every game exports as **PGN**, the format lichess, En Croissant, ChessBase, Scid and every Stockfish GUI import (*Copy / Download / Analyze on lichess* in the UI).
- Agents connect over **MCP** at `/mcp` (Streamable HTTP) or the plain **HTTP API** ([docs/http-api.md](docs/http-api.md), also served at `GET /api`).
- Move on the board, or just tell the agent your move in the conversation ("knight e4") and it plays it for you.
- Chat with the agent, offer/accept draws, resign, take back a misclick, browse the move history, flip the board.

## Run it

### Docker (e.g. on a NAS)

```sh
curl -O https://raw.githubusercontent.com/neeppy/chess-agent/main/compose.yaml
docker compose up -d
```

Then open `http://<host>:5199`. The image (`ghcr.io/neeppy/chess-agent`) is built for amd64 and arm64. Set `PUID`/`PGID` in `compose.yaml` to the owner of the data folder; the database ends up in `./data/chess.db`.

There is no login: anyone who can reach the port can play, so keep it on your home network (or put an authenticating reverse proxy in front).

### From source

Needs Node 24+ and pnpm.

```sh
pnpm install
pnpm dev                        # http://localhost:5199
pnpm build && pnpm start        # production build, same port
docker build -t chess-agent .   # or build the image yourself
```

## Play against Claude Code

Register the MCP server once for your user, with the address of wherever the app runs:

```sh
claude mcp add --transport http --scope user chess http://<host>:5199/mcp
```

(Inside this repository `.mcp.json` already points at `http://localhost:5199/mcp`.)

Claude waits for your moves with a background `curl` (see below). To avoid permission prompts, especially when playing from your phone, allow it and the chess tools in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__chess", "Bash(curl -s http://<host>:5199/api/agent/next)"]
  }
}
```

Then, in any session:

```
> Let's play a game of chess. I'll take white.
```

and play however suits you, switching whenever you like:

- **On the board:** make your move in the browser and Claude answers on its own.
- **In the conversation:** type your move ("knight e4", "pawn takes d5", "castle kingside") and Claude plays it for you, then replies with its own. If your move is ambiguous ("knight e2" with two knights able to go there), Claude asks which one.
- **Away from the PC:** continue the same session from your phone or the Claude desktop app with [Remote Control](https://code.claude.com/docs/en/remote-control) (`/remote-control` in the session) and type your moves there.

### How Claude waits without blocking the conversation

After each move Claude starts a **background waiter** (`curl -s http://<host>:5199/api/agent/next`) and ends its turn. The waiter is a request the app holds open until something happens:

- You move on the board → the request finishes and prints the new position, and Claude Code wakes Claude up to reply.
- You write in the web page's chat panel → same.
- You type in the conversation → Claude is idle, so it reads your message right away. If it's a move, Claude plays it for you; the waiter keeps waiting for your *next* board move instead of firing.

Nothing is generated while you think, so no tokens are used whether you take ten seconds or ten hours. Only one waiter runs at a time; a new one replaces an old one.

The page shows what Claude is doing: *watching the board* (a waiter is running), *thinking…*, or *hasn't seen your move*. The last one happens when no waiter is running, for example if you interrupted Claude; just tell it "your move" in the conversation.

### Codex and other agents

Agents that can't run background commands use the blocking `wait_for_turn` tool instead. It wakes on board moves and web chat messages, but while it's blocked you can't talk to the agent in its own conversation. For Codex:

```toml
# ~/.codex/config.toml
[mcp_servers.chess]
url = "http://<host>:5199/mcp"
tool_timeout_sec = 3600          # Codex's default (60s) would cut wait_for_turn short
```

## MCP tools

| Tool                 | What it does                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `view_board_state`   | Board as ASCII + piece list, FEN, whose turn, last move, material, move list, legal moves, unread web chat |
| `move`               | Play a move in SAN (`Nf3`, `O-O`, `e8=Q`) or UCI (`g1f3`); optional web chat `message`. The result says whether to start the waiter |
| `play_opponent_move` | Play the human's move when they state it in the conversation ("knight e4" → `Ne4`); ambiguous moves come back as "Nce4 or Nge4?" |
| `wait_for_turn`      | Blocking wait, for agents that can't run the background waiter                                    |
| `render_board`       | PNG of the board (current or any earlier ply), plus a URL to download it with `curl -o`           |
| `new_game`           | Start a new game (pick a color); refuses to abandon a game in progress unless asked                |
| `offer_draw`, `respond_to_draw`, `resign` | What they say                                                                 |
| `send_message`       | Write in the web page's chat panel                                                                 |

The MCP endpoint is stateless, so restarting or updating the container never breaks a connected agent.

## Data

Everything is in one SQLite database, `$CHESS_DATA_DIR/chess.db` (`/data/chess.db` in the container):

| Table      | Contents                                                              |
| ---------- | --------------------------------------------------------------------- |
| `games`    | players, colors, result, termination, draw offer, PGN                 |
| `moves`    | every move in SAN with the time it was played                         |
| `messages` | the chat log, including system notes (draw offers, takebacks…)       |
| `meta`     | the id of the game in progress                                        |

To back it up, copy `chess.db` while the app is stopped, or run `sqlite3 chess.db ".backup backup.db"` while it runs. Older versions stored games as JSON files; they're imported automatically on first start and moved to `legacy-json/`.

## Configuration

| Env var              | Default                    | What it does                                                            |
| -------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `PORT`, `HOST`       | `5199`, `0.0.0.0` (image)  | Where the server listens                                                |
| `CHESS_DATA_DIR`     | `./data` (`/data` in image) | Where `chess.db` lives                                                 |
| `CHESS_PUBLIC_URL`   | from the request           | Base URL agents are told to use for the waiter; set it behind a reverse proxy |
| `CHESS_WAIT_MINUTES` | `60`                       | Default timeout of `wait_for_turn`                                      |
| `PUID`, `PGID`       | `1000`                     | Container only: user/group the app runs as and that owns `/data`        |
| `TZ`                 | `UTC`                      | Time zone for game ids and PGN dates                                    |

## Publishing

`.github/workflows/docker.yml` builds the image for amd64 and arm64 and pushes it to `ghcr.io/neeppy/chess-agent`:

- every push to `main` → `latest` and `sha-<commit>`
- a tag like `v1.2.0` → `1.2.0` and `1.2`
- pull requests are built but not pushed

The package is private the first time it's published. Make it public under the repository's *Packages* settings, or `docker login ghcr.io` on the NAS before pulling.

## Files

```
src/lib/server/game.ts    # game logic, agent waiting
src/lib/server/store.ts   # SQLite persistence (+ one-time JSON import)
src/lib/server/mcp.ts     # MCP tools, served at /mcp
src/lib/agent-text.ts     # how the game is described to the agent
src/lib/server/render.ts  # board -> SVG/PNG
src/routes/api/           # HTTP API
src/routes/+page.svelte   # the UI
Dockerfile, compose.yaml, docker/entrypoint.sh
```

## Credits

Piece set "cburnett" by Colin M.L. Burnett (CC BY-SA 3.0 / GPLv2+), via chessground (GPL-3.0). chess.js is BSD-2.

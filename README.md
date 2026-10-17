# Agentic Chess

Play chess in the browser with friends or AI agents (Claude Code, Codex, or anything that speaks MCP or HTTP). Self-hostable as a single container.

- **Rooms:** every game lives in a room with its own link (`/r/abc123`). Anyone with the link can take a free seat or watch live.
- **Humans and agents alike:** a seat is held by whoever took it, a person in the browser or an agent over MCP. Agent vs agent works too.
- Legal moves only (rules by [chess.js](https://github.com/jhlywa/chess.js), board by lichess' [chessground](https://github.com/lichess-org/chessground)).
- Games live in a **SQLite** database and are saved after every move: close the tab, restart the container, come back tomorrow, it picks up where you left off.
- Every game exports as **PGN**, the format lichess, En Croissant, ChessBase, Scid and every Stockfish GUI import (*Copy / Download / Analyze on lichess* in the UI).
- Chat, draw offers, resignations, rematches, takebacks against agents, move history, flipping the board.

## Run it

### Docker (e.g. on a NAS)

```sh
curl -O https://raw.githubusercontent.com/neeppy/chess-agent/main/compose.yaml
docker compose up -d
```

Then open `http://<host>:5199`. The image (`ghcr.io/neeppy/chess-agent`) is built for amd64 and arm64. Set `PUID`/`PGID` in `compose.yaml` to the owner of the data folder; the database ends up in `./data/chess.db`.

### From source

Needs Node 24+ and pnpm.

```sh
pnpm install
pnpm dev                        # http://localhost:5199
pnpm build && pnpm start        # production build, same port
docker build -t chess-agent .   # or build the image yourself
```

## Rooms and seats

Create a room on the home page and share its link. Each room has a White and a Black seat:

- **Taking a seat** gives you a secret *seat key*. Your browser remembers it, so the same link brings you back to your seat; agents pass it to every tool. The key is the only credential: there are no accounts.
- **Spectators** are everyone else with the link. They watch live, but can't move or chat.
- **Seats can be taken over.** A spectator can take an occupied seat (*Take over* on the player's bar); the previous holder loses it and the game continues from the current position. Taking a seat after a game has ended starts the next game, so finished games keep the players who played them. Agents only take over a seat when asked.
- The game starts once both seats are taken. **Rematch** starts a new game in the same room with colours swapped; the room keeps every game (*Games* in the header).
- A **seat link** (`/r/abc123#seat=<key>`) hands a seat to another browser. Agents use it to give you the seat they created for you.

There are no accounts or passwords: whoever has a room link can play in it, so share links with the people you want to play.

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
    "allow": ["mcp__chess", "Bash(curl -s http://<host>:5199/api/seat/*)"]
  }
}
```

Then, in any session:

- **"Let's play chess, I'll take white."** Claude creates a room, takes Black, and sends you a seat link for White. Open it and play on the board, or type your moves in the conversation ("knight e4", "castle kingside") and Claude enters them for you. If a move is ambiguous ("knight e2" with two knights able to go there), it asks which one.
- **"Join chess room abc123."** Create the room yourself on the home page (or let a friend do it), then send Claude the code or link. Claude takes the free seat; you play on the board.
- **Away from the PC:** continue the same session from your phone or the Claude desktop app with [Remote Control](https://code.claude.com/docs/en/remote-control) (`/remote-control` in the session) and type your moves there.

### How Claude waits without blocking the conversation

After each move Claude starts a **background waiter** (`curl -s http://<host>:5199/api/seat/<its key>/next`) and ends its turn. The waiter is a request the app holds open until something happens:

- Its opponent moves on the board → the request finishes and prints the new position, and Claude Code wakes Claude up to reply.
- Someone writes in the room chat → same.
- You type in the conversation → Claude is idle, so it reads your message right away. If it's a move it entered for you, the waiter keeps waiting for your *next* board move instead of firing.

Nothing is generated while you think, so no tokens are used whether you take ten seconds or ten hours. Each seat has at most one waiter; a new one replaces an old one.

The opponent's bar shows what an agent is doing: *watching the board* (a waiter is running), *thinking…*, or *hasn't seen the move*. The last one happens when no waiter is running, for example if you interrupted Claude; just tell it "your move" in the conversation.

### Codex and other agents

Agents that can't run background commands use the blocking `wait_for_turn` tool instead. It wakes on board moves and chat messages, but while it's blocked you can't talk to the agent in its own conversation. For Codex:

```toml
# ~/.codex/config.toml
[mcp_servers.chess]
url = "http://<host>:5199/mcp"
tool_timeout_sec = 3600          # Codex's default (60s) would cut wait_for_turn short
```

## MCP tools

Every tool that acts takes the agent's seat key as `seat`.

| Tool                 | What it does                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `create_room`        | New room; with `play_as` the agent takes a seat, with `opponent_name` it also creates the human's seat and returns a seat link for them |
| `join_room`          | Take a free seat in a room, by code or link                                                         |
| `view_board_state`   | Board as ASCII + piece list, FEN, seats, whose turn, last move, material, move list, legal moves, unread chat; with just a room code, as a spectator |
| `move`               | Play a move in SAN (`Nf3`, `O-O`, `e8=Q`) or UCI (`g1f3`); optional chat `message`. The result says how to wait |
| `play_opponent_move` | Enter the move the human typed in the conversation, for a seat the agent created for them; ambiguous moves come back as "Nce4 or Nge4?" |
| `wait_for_turn`      | Blocking wait, for agents that can't run the background waiter                                    |
| `render_board`       | PNG of the board (current or any earlier ply), plus a URL to download it with `curl -o`           |
| `rematch`            | New game in the same room, colours swapped by default                                              |
| `offer_draw`, `respond_to_draw`, `resign` | What they say                                                                 |
| `send_message`       | Write in the room chat                                                                             |

The MCP endpoint is stateless, so restarting or updating the container never breaks a connected agent. The plain HTTP API is in [docs/http-api.md](docs/http-api.md) (also served at `GET /api`).

## Data

Everything is in one SQLite database, `$CHESS_DATA_DIR/chess.db` (`/data/chess.db` in the container):

| Table      | Contents                                                              |
| ---------- | --------------------------------------------------------------------- |
| `rooms`    | room code and its current game                                        |
| `players`  | who took a seat in a room: name, human or agent, hash of the seat key |
| `games`    | the players on each seat, result, termination, draw offer, PGN        |
| `moves`    | every move in SAN with the time it was played                         |
| `messages` | the chat, including system notes (seats taken, draw offers, takebacks…) |

The database migrates itself on start. Games from before rooms existed are in the read-only room `/r/legacy`.

To back it up, copy `chess.db` while the app is stopped, or run `sqlite3 chess.db ".backup backup.db"` while it runs.

## Configuration

| Env var              | Default                    | What it does                                                            |
| -------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `PORT`, `HOST`       | `5199`, `0.0.0.0` (image)  | Where the server listens                                                |
| `CHESS_DATA_DIR`     | `./data` (`/data` in image) | Where `chess.db` lives                                                 |
| `CHESS_PUBLIC_URL`   | from the request           | Base URL agents are told to use for links and the waiter; set it behind a reverse proxy |
| `CHESS_WAIT_MINUTES` | `60`                       | Default timeout of `wait_for_turn`                                      |
| `PUID`, `PGID`       | `1000`                     | Container only: user/group the app runs as and that owns `/data`        |
| `TZ`                 | `UTC`                      | Time zone for game ids and PGN dates                                    |

## Publishing

`.github/workflows/docker.yml` builds the image for amd64 and arm64 and pushes it to `ghcr.io/neeppy/chess-agent`:

- every push to `main` → `latest` and `sha-<commit>`
- a tag like `v1.2.0` → `1.2.0` and `1.2`
- pull requests are built but not pushed

The package follows the repository's visibility: for a public repository anyone can pull it, for a private one run `docker login ghcr.io` on the NAS first.

## Files

```
src/lib/server/rooms.ts   # rooms, seats, game logic, agent waiting
src/lib/server/store.ts   # SQLite persistence and migrations
src/lib/server/mcp.ts     # MCP tools, served at /mcp
src/lib/agent-text.ts     # how a game is described to an agent
src/lib/server/render.ts  # board -> SVG/PNG
src/lib/seats.ts          # seat keys remembered by the browser
src/routes/api/           # HTTP API
src/routes/+page.svelte   # home page (create / join a room)
src/routes/r/[code]/      # the room page
Dockerfile, compose.yaml, docker/entrypoint.sh
```

## Credits

Piece set "staunty" by sadsnake1 ([CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)), from [lichess.org](https://github.com/lichess-org/lila). Board by chessground (GPL-3.0). chess.js is BSD-2.

# Agentic Chess Game

The purpose of this project is to create a chess platform that I can use to play chess against a agent.

## What do we have now?

The current app is just a minimal SvelteKit app created using `npx sv create`. Only tailwindcss was installed.
Don't bother with tests or linting or formatting. This is a fully vibecoded app.

## Requirements

- chess game should be playable and illegal moves should not be possible
- in first instance, the game state should be persisted somewhere (maybe a file for now)
  - if I close the window or leave, the game should be resumable from that point
- either a documented HTTP server or an MCP server should be exposed so that agents like Claude Code / Codex can easily make moves and see the board state
  - available tools should be: move, view_board_state, render_board (to save an image of the board)
  - if you think I missed a tool that an agent might need, feel free to add it
- a UI should be available for me to be able to move the pieces - I'll let you find PNG images or SVGs for the chess pieces
- a history of all moves should be preserved in a notation that I can import in stockfish or some other engine to review how a game went (PGN I think?)
  - will let you see which one works best

## Open Questions

- is it possible for the MCP to trigger the agent somehow? Basically, if I make a UI move, the agent should react. Polling could be an option (maybe a wait tool?), but only if it keep the agent idle. I don't want the agent to waste tokens waiting for a move if I walk out in the middle of the game with the intention of resuming in a few hours

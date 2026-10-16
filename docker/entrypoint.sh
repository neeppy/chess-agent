#!/bin/sh
# Runs the app as PUID:PGID (default 1000:1000) and makes sure the data directory belongs to that
# user, so a bind-mounted NAS folder works without fiddling with permissions. If the container is
# already started as a non-root user (compose `user:`), it just runs the app.
set -e

if [ "$(id -u)" = "0" ]; then
	PUID="${PUID:-1000}"
	PGID="${PGID:-1000}"
	mkdir -p "$CHESS_DATA_DIR"
	if [ "$(stat -c %u:%g "$CHESS_DATA_DIR")" != "$PUID:$PGID" ]; then
		chown -R "$PUID:$PGID" "$CHESS_DATA_DIR" || echo "warning: could not chown $CHESS_DATA_DIR to $PUID:$PGID" >&2
	fi
	exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
fi

exec "$@"

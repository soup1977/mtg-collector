#!/bin/sh
# Starts as root only to give /data and /backups to PUID:PGID (Unraid: 99:100), then runs the app as that user.
set -e
PUID="${PUID:-99}"
PGID="${PGID:-100}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data /backups
  chown -R "$PUID:$PGID" /data
  chown "$PUID:$PGID" /backups
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
fi
exec "$@"

#!/bin/sh
# Access codes and session credentials must not enter OS core dumps.
ulimit -c 0 || exit 1
exec "$@"

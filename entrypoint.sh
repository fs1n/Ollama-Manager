#!/bin/sh
set -e

# Start proxy on port 8080
node /app/proxy.js &
PROXY_PID=$!

# Start HTTP server on port 3000 for index.html
http-server /app -p 3000 -c-1 &
SERVER_PID=$!

# Keep container running
wait $PROXY_PID $SERVER_PID

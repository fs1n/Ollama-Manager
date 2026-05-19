FROM node:26-alpine

WORKDIR /app

# Copy application files
COPY proxy.js .
COPY index.html .

# Install http-server to serve static files
RUN npm install --global http-server

# Create entrypoint script
RUN cat > entrypoint.sh << 'ENTRYPOINT_EOF'
#!/bin/sh
# Start proxy on port 8080
node proxy.js &
PROXY_PID=$!

# Start HTTP server on port 3000 for index.html
http-server . -p 3000 -c-1 &
SERVER_PID=$!

# Keep container running
wait $PROXY_PID $SERVER_PID
ENTRYPOINT_EOF

RUN chmod +x entrypoint.sh

EXPOSE 3000 8080

CMD ["./entrypoint.sh"]

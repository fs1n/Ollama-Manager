FROM node:26-alpine

WORKDIR /app

# Copy application files
COPY proxy.js .
COPY index.html .

# Install http-server to serve static files
RUN npm install --global http-server

# Copy entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 3000 8080

CMD ["/app/entrypoint.sh"]

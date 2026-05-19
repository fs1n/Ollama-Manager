#!/usr/bin/env node
const http = require('http');
const https = require('https');
const { URL } = require('url');
const querystring = require('querystring');

const PORT = process.env.PORT || 8080;

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function forwardRequest(targetUrl, req, res) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid URL' }));
  }

  const client = target.protocol === 'https:' ? https : http;

  const proxyReq = client.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      headers: {
        ...req.headers,
        host: target.host,
      },
    },
    (proxyRes) => {
      setCorsHeaders(req, res);
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad gateway' }));
  });

  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(req, res);
    res.writeHead(204);
    return res.end();
  }

  // Health check
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  // Query parameter mode: /api/proxy?url=https://...
  if (req.url.startsWith('/api/proxy?')) {
    const query = querystring.parse(req.url.split('?')[1]);
    if (!query.url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing url parameter' }));
    }
    return forwardRequest(query.url, req, res);
  }

  // Legacy mode: /https://example.com/path
  if (req.url.startsWith('/http://') || req.url.startsWith('/https://')) {
    const targetUrl = req.url.slice(1);
    return forwardRequest(targetUrl, req, res);
  }

  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Use /api/proxy?url=<encoded-url> or /<full-url>' }));
});

server.listen(PORT, () => {
  console.log(`CORS proxy listening on http://localhost:${PORT}`);
  console.log(`Use: /api/proxy?url=https://example.com/path or /https://example.com/path`);
});

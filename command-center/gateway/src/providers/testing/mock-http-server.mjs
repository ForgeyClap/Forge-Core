// Test support (also meant for B8's mock providers): an in-process node:http server on 127.0.0.1 with
// a random port. Records every request (method, path, headers, parsed body) and lets a handler answer
// with JSON, an SSE stream, NDJSON or a raw status. No network beyond the loopback interface.

import http from 'node:http';

export async function startMockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const url = new URL(req.url, 'http://127.0.0.1');
      const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
      requests.push(record);
      try {
        await handler(record, helpers(res));
      } catch (err) {
        if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); }
        res.end('mock handler error: ' + (err && err.message));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: 'http://127.0.0.1:' + port,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function helpers(res) {
  return {
    json(status, obj, headers = {}) {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    },
    text(status, text, headers = {}) {
      res.writeHead(status, { 'content-type': 'text/plain', ...headers });
      res.end(text);
    },
    // Writes raw SSE text pieces with an optional delay, exactly as given (tests control framing).
    async sse(pieces, { delayMs = 0, status = 200 } = {}) {
      res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const p of pieces) {
        res.write(p);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
      res.end();
    },
    async ndjson(objs, { delayMs = 0 } = {}) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const o of objs) {
        res.write(JSON.stringify(o) + '\n');
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
      res.end();
    },
    // Sends headers and some data, then stalls without ending (idle-timeout tests).
    stall(firstPiece = '') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (firstPiece) res.write(firstPiece);
    },
    // Never answers: the request body has been received but no headers are sent (header-wait tests).
    hang() { /* intentionally nothing */ },
    // Drops the connection after the body was received (ECONNRESET-after-send tests).
    reset() { res.socket.destroy(); },
    // Waits, then continues (slow-headers tests).
    delay(ms) { return new Promise((r) => setTimeout(r, ms)); },
    raw: res,
  };
}

// Helper to build one SSE event string.
export function sseData(obj, event) {
  return (event ? 'event: ' + event + '\n' : '') + 'data: ' + (typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n\n';
}

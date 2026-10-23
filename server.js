// XSLT polyfill reverse proxy for the ThermWet Ventbox 400 (Teco SoftPLC)
// The device serves XML pages with an xml-stylesheet PI - browsers transform
// them natively today, but XSLT support is being removed (Chrome M158,
// 2026-11-17). This proxy injects the xslt-polyfill <script> element into
// every XML response that carries an xml-stylesheet PI. Browsers with native
// XSLT ignore the extra element (native transform runs first), browsers
// without XSLT execute it and the polyfill performs the transform in JS/WASM

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// prettier-ignore
if (!process.env.THERMWET_HOST) { console.error('THERMWET_HOST env var is required (e.g. "192.168.1.78" or "http://192.168.1.78")'); process.exit(1); }
// scheme optional - bare host or host:port both resolve to http
let UPSTREAM;
try {
  UPSTREAM = new URL(/^https?:\/\//.test(process.env.THERMWET_HOST) ? process.env.THERMWET_HOST : `http://${process.env.THERMWET_HOST}`);
} catch {
  // prettier-ignore
  console.error(`THERMWET_HOST is not a valid address: "${process.env.THERMWET_HOST}"`); process.exit(1);
}
const PORT = Number(process.env.PORT || 8080);
const MAX_XML_BODY = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);

// TECO web server has a very low connection limit - cap upstream parallelism
// so concurrent page loads queue instead of exhausting it. Keep-alive stays
// on: the device appears to bind login state to the TCP connection, so
// connection-per-request breaks auth
const UPSTREAM_AGENT = new http.Agent({
  keepAlive: true,
  maxSockets: Number(process.env.UPSTREAM_MAX_SOCKETS || 2),
});

// headers valid only on a single hop - must not be relayed either direction
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization'];
// headers injected by front proxies - the device must see the request as if
// the client connected directly, otherwise its host/session checks misbehave
const FORWARDED = ['forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-server', 'x-forwarded-proto', 'x-forwarded-port'];

/**
 * Return headers minus hop-by-hop entries, including any extra header names
 * listed inside the Connection header value
 * @param {http.IncomingHttpHeaders} headers original headers
 * @returns {object} safe-to-forward headers
 */
function stripHopByHop(headers) {
  const extra = String(headers.connection || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const out = { ...headers };
  for (const h of [...HOP_BY_HOP, ...FORWARDED, ...extra]) delete out[h];
  return out;
}

/**
 * Swap scheme+host of a Referer-style URL for the upstream origin. Embedded
 * devices often validate Referer/Origin against their own host and reject
 * requests carrying the public proxy hostname
 * @param {string} value original header value
 * @returns {string} value rewritten to the upstream origin, or input on parse failure
 */
function toUpstreamOrigin(value) {
  try {
    const u = new URL(value);
    u.protocol = UPSTREAM.protocol;
    u.host = UPSTREAM.host;
    return u.toString();
  } catch {
    return value;
  }
}

/**
 * Build client-facing response headers from an upstream response: strips
 * hop-by-hop entries, drops cookie Domain attributes pointing at the device
 * (browser would reject them) and relativizes absolute Location redirects
 * so the browser stays on the proxy host
 * @param {http.IncomingHttpHeaders} upHeaders upstream response headers
 * @returns {object} response headers
 */
function responseHeaders(upHeaders) {
  const h = stripHopByHop(upHeaders);
  const sc = h['set-cookie'];
  if (sc) h['set-cookie'] = (Array.isArray(sc) ? sc : [sc]).map((c) => c.replace(/;\s*domain=[^;]*/gi, ''));
  if (h.location && h.location.startsWith(UPSTREAM.origin)) h.location = h.location.slice(UPSTREAM.origin.length) || '/';
  return h;
}

const POLYFILL_URL_PATH = '/xslt-polyfill.min.js';
const POLYFILL_FILE = path.join(__dirname, 'xslt-polyfill.min.js');

// XHTML namespace is required for the script to execute inside an XML doc
const INJECT_SNIPPET = Buffer.from(
  `\n<script xmlns="http://www.w3.org/1999/xhtml" src="${POLYFILL_URL_PATH}" charset="utf-8"></script>`,
  'utf8'
);

/**
 * Find the byte offset right after the root element's start tag.
 * Skips BOM, XML declaration, processing instructions, comments and doctype
 * @param {Buffer} buf XML response body
 * @returns {number} insert offset, or -1 when no injectable root tag is found
 */
function findInsertOffset(buf) {
  let i = 0;
  const n = buf.length;
  if (n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  while (i < n) {
    // skip whitespace between prolog nodes
    while (i < n && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
    if (i >= n || buf[i] !== 0x3c) return -1; // '<'
    const next = buf[i + 1];
    if (next === 0x3f) { // '?' - processing instruction, skip to '?>'
      const end = buf.indexOf('?>', i + 2);
      if (end === -1) return -1;
      i = end + 2;
    } else if (next === 0x21) { // '!' - comment or doctype
      if (buf[i + 2] === 0x2d && buf[i + 3] === 0x2d) { // '<!--'
        const end = buf.indexOf('-->', i + 4);
        if (end === -1) return -1;
        i = end + 3;
      } else {
        const end = buf.indexOf('>', i + 2);
        if (end === -1) return -1;
        i = end + 1;
      }
    } else {
      // root start tag - scan to '>' honoring quoted attribute values
      let quote = 0;
      for (let j = i + 1; j < n; j++) {
        const c = buf[j];
        if (quote) {
          if (c === quote) quote = 0;
        } else if (c === 0x22 || c === 0x27) { // '"' or "'"
          quote = c;
        } else if (c === 0x3e) { // '>'
          if (buf[j - 1] === 0x2f) return -1; // self-closing root, nothing inside
          return j + 1;
        }
      }
      return -1;
    }
  }
  return -1;
}

/**
 * Serve the vendored polyfill bundle
 * @param {http.ServerResponse} res client response
 */
function servePolyfill(res) {
  fs.stat(POLYFILL_FILE, (err, st) => {
    if (err) {
      res.writeHead(500).end('polyfill file missing');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': st.size,
      // immutable - file content changes only on manual upgrade
      'cache-control': 'public, max-age=86400, immutable',
    });
    fs.createReadStream(POLYFILL_FILE).pipe(res);
  });
}

/**
 * Forward an upstream response to the client, injecting the polyfill
 * into XML documents that reference an XSL stylesheet
 * @param {http.IncomingMessage} upRes upstream response
 * @param {http.ServerResponse} res client response
 */
function handleUpstreamResponse(upRes, res) {
  const contentType = String(upRes.headers['content-type'] || '');
  if (!/xml/i.test(contentType)) {
    // non-XML (css, js, images, redirects) - stream through untouched
    res.writeHead(upRes.statusCode, responseHeaders(upRes.headers));
    upRes.pipe(res);
    return;
  }

  // XML responses are small - buffer, rewrite, forward
  const chunks = [];
  let size = 0;
  let done = false;
  const fail = (msg) => {
    if (done) return;
    done = true;
    if (res.headersSent) return res.destroy();
    // prettier-ignore
    res.writeHead(502, { 'content-type': 'text/plain' }).end(msg);
  };
  upRes.on('data', (c) => {
    size += c.length;
    if (size > MAX_XML_BODY) {
      // too big to buffer+rewrite - fail fast instead of eating memory
      fail('Upstream XML too large');
      upRes.destroy();
      return;
    }
    chunks.push(c);
  });
  upRes.on('end', () => {
    if (done) return;
    done = true;
    const body = Buffer.concat(chunks);
    let out = body;
    if (body.includes('<?xml-stylesheet')) {
      const off = findInsertOffset(body);
      if (off >= 0) out = Buffer.concat([body.subarray(0, off), INJECT_SNIPPET, body.subarray(off)]);
    }
    // body changed (or at least buffered) - fix up length header
    const headers = { ...responseHeaders(upRes.headers), 'content-length': out.length };
    res.writeHead(upRes.statusCode, headers);
    res.end(out);
  });
  upRes.on('aborted', () => fail('Upstream response aborted'));
  upRes.on('error', () => fail('Upstream response error'));
  // 'close' fires after a clean 'end' too - the done flag filters that out
  upRes.on('close', () => fail('Upstream connection closed mid-response'));
}

/**
 * Proxy a client request to the device
 * @param {http.IncomingMessage} req client request
 * @param {http.ServerResponse} res client response
 */
function proxyRequest(req, res) {
  const headers = {
    ...stripHopByHop(req.headers),
    host: UPSTREAM.host,
    // request plain identity so injected bodies never hit gzip surprises
    'accept-encoding': 'identity',
  };
  // device may reject form posts whose Referer/Origin carry the public hostname
  if (headers.origin) headers.origin = UPSTREAM.origin;
  if (headers.referer) headers.referer = toUpstreamOrigin(headers.referer);
  const upReq = http.request(
    {
      host: UPSTREAM.hostname,
      port: UPSTREAM.port || 80,
      agent: UPSTREAM_AGENT,
      path: req.url,
      method: req.method,
      headers,
    },
    (upRes) => handleUpstreamResponse(upRes, res)
  );
  upReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => upReq.destroy(new Error('upstream timeout')));
  upReq.on('error', (e) => {
    if (res.headersSent) return res.destroy();
    // prettier-ignore
    res.writeHead(502, { 'content-type': 'text/plain' }).end(`Upstream error: ${e.message}`);
  });
  req.pipe(upReq);
  // client went away mid-flight - no point finishing the upstream request
  res.on('close', () => upReq.destroy());
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === POLYFILL_URL_PATH) return servePolyfill(res);
  proxyRequest(req, res);
});

// prettier-ignore
server.listen(PORT, () => console.log(`thermwet-xslt-proxy: http://0.0.0.0:${PORT} -> ${UPSTREAM.origin}`));

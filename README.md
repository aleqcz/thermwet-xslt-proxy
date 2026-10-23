# thermwet-xslt-proxy

Reverse proxy for the ThermWet Ventbox 400 (gen 1, Teco SoftPLC web UI).

The device serves `*.xml` pages carrying an `xml-stylesheet` PI - browsers
transform them with built-in XSLT. That support is being removed (Chrome
M158 = 2026-11-17, Firefox/WebKit plan the same). The proxy injects the
official `xslt-polyfill` `<script>` element into every XML response, so the
transformation happens in JS/WASM inside the browser instead.

- With native XSLT still present, browsers transform first and ignore the
  injected script - no behavior change today.
- After removal, the injected script runs and the polyfill replaces the
  document with the transformed result.

Everything else (POST forms, `SoftPLC` cookie, css/js, redirects) passes
through untouched, so login and control keep working.

## Run

```sh
docker compose up -d --build
# UI at http://<docker-host>:8080/
```

Or without Docker (Node 18+):

```sh
THERMWET_HOST=192.168.1.78 PORT=8080 node server.js
```

## Config

The device address lives in `docker-compose.yml` (`environment:`) - it is
not hardcoded anywhere else.

| Env            | Default   | Meaning                                        |
|----------------|-----------|------------------------------------------------|
| `THERMWET_HOST`| *required*| Ventbox address - `192.168.1.78`, `host:port` or `http://host` |
| `PORT`         | `8080`    | Proxy listen port                              |
| `UPSTREAM_TIMEOUT_MS` | `15000` | Timeout for the whole upstream request+response |

## Polyfill

Vendored `xslt-polyfill.min.js`, npm `xslt-polyfill@1.0.31`
(<https://github.com/mfreed7/xslt_polyfill>, WASM libxslt, single-file
build). To upgrade, download a newer `@<version>` file from unpkg and
rebuild the image.

## Notes

- The device is HTTP-only on the LAN. Put the proxy behind a TLS
  terminator if it should ever be reachable from outside.
- The published port binds `0.0.0.0` - anyone who can reach the host
  can open the UI (same exposure as the device itself). Use
  `127.0.0.1:8080:8080` in `ports:` to keep it local.
- The polyfill re-fetches the XML and XSL via `fetch()` - same-origin by
  construction here, so no CORS issues.

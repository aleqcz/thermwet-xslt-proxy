# thermwet-xslt-proxy

Reverzní proxy pro ThermWet Ventbox 400 (1. generace, web UI Teco SoftPLC).

Zařízení servíruje stránky `*.xml` s processing instruction
`xml-stylesheet` - prohlížeče je transformují vestavěným XSLT. Tato
podpora se ruší (Chrome M158 = 17. 11. 2026, Firefox/WebKit plánují
totéž). Proxy do každé XML odpovědi vloží `<script>` element
oficiálního `xslt-polyfill`, takže transformace proběhne v JS/WASM
uvnitř prohlížeče.

- Dokud prohlížeč nativní XSLT má, transformuje nejdřív on a vložený
  script ignoruje - chování se dnes nemění.
- Po odstranění XSLT se script spustí a polyfill nahradí dokument
  transformovaným výsledkem.

Vše ostatní (POST formuláře, cookie `SoftPLC`, css/js, redirecty)
prochází beze změny, takže přihlášení a ovládání fungují dál.

## Spuštění

```sh
docker compose up -d --build
# UI na http://<docker-host>:8080/
```

Nebo bez Dockeru (Node 18+):

```sh
THERMWET_HOST=192.168.1.78 PORT=8080 node server.js
```

## Konfigurace

Adresa zařízení se nastavuje v `docker-compose.yml` (sekce
`environment:`) - nikde jinde hardcodovaná není.

| Env             | Výchozí   | Význam                                               |
|-----------------|-----------|------------------------------------------------------|
| `THERMWET_HOST` | *povinné* | Adresa Ventboxu - `192.168.1.78`, `host:port` nebo `http://host` |
| `PORT`          | `8080`    | Port, na kterém proxy poslouchá                      |
| `UPSTREAM_TIMEOUT_MS` | `15000` | Timeout celého upstream requestu+response      |

## Polyfill

`xslt-polyfill.min.js` je zkopírovaný přímo v repozitáři (vendored),
npm `xslt-polyfill@1.0.31`
(<https://github.com/mfreed7/xslt_polyfill>, WASM libxslt, single-file
build). Upgrade = stáhnout novější soubor `@<verze>` z unpkg a přebuildovat
image.

## Poznámky

- Zařízení umí jen HTTP v LAN. Pokud má být proxy dostupná zvenčí,
  dej před ní TLS terminátor.
- Publikovaný port binduje na `0.0.0.0` - UI otevře každý, kdo dosáhne
  na hosta (stejná expozice jako samotné zařízení). Pro lokální provoz
  použij `127.0.0.1:8080:8080` v `ports:`.
- Polyfill znovu fetchnete XML i XSL přes `fetch()` - vše jde přes
  stejný origin proxy, takže CORS nevadí.

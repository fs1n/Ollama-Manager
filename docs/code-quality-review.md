# Code-Qualität, Duplikate und CI-Standards

Read-only-Audit der Codebase. Es wurden keine Quelldateien verändert.

| | |
|---|---|
| **Repo** | fs1n/Ollama-Manager |
| **Branch** | `feat/ollaya-backend` |
| **HEAD** | `9d7a9a7` |
| **Umfang** | 5.996 Zeilen TypeScript/CSS |
| **Stand** | 2026-09-29 |

## Methodik

Sechs Subagents prüften getrennte Achsen: Server-Kern (`src/index.ts`),
Security/Correctness, Frontend (`public/src/`), CSS, Tests/CI und das neu
hinzugekommene Backend-Modul (`src/backends.ts`). Jede kritische Aussage wurde
anschließend gegen einen laufenden Serverprozess oder einen Mock-Upstream
nachgeprüft; die Verifikationstabelle in Abschnitt 2 trennt Agentenbefunde von
eigener empirischer Bestätigung.

Die Duplikatmessung erfolgte mit jscpd 4 über 4.424 Zeilen (Tests und Fixtures
ausgeschlossen), die Coverage mit `bun test --coverage` auf Bun 1.3.6.

---

## 1. Gesamtbild

| Kennzahl | Wert |
|---|---|
| Duplikatrate (jscpd) | **0,32 %** bei 8 Zeilen/60 Tokens, 0,77 % bei 5/40 |
| Tests | 80 grün, 213 Assertions, 0 Fail, ~300 ms |
| Coverage `src/index.ts` | **23,7 % Funcs** / 50,6 % Lines |
| Coverage Frontend | 2 von 15 Modulen (~8,7 %) |
| Lint | Exit 0, 8 Warnungen (`noExplicitAny`) |
| `tsc` | 0 Diagnosen in beiden tsconfigs |
| Erzwungene CI-Checks auf `main` | **0** (kein Branch-Schutz) |

Drei Dinge prägen das Bild.

**Die Disziplin ist echt, nicht zufällig.** 0,32 % Duplikation erreichen sonst
nur stark refaktorierte Bibliotheken. Auth-Token, HTML-Parser, Markdown-Renderer
und Format-Helfer stehen bei 100 % Coverage, Lint und beide Typprüfungen laufen
fehlerfrei, der Lockfile ist im CI mit `--frozen-lockfile` fixiert, das
Docker-Image läuft als Non-Root. Die Kommentare erklären durchgängig das *Warum*
— etwa in `src/index.ts:168`, warum beim Streaming kein fester Gesamt-Timeout
gesetzt werden darf — und nicht das *Was*.

**Die Schwachstellen sind konzentriert, nicht diffus.** Alles, was wirklich weh
tut, sitzt in `src/index.ts`: 1.490 Zeilen, 23,7 % Funktions-Coverage, keine
Testbarkeit ohne vollen Server-Boot, und dort liegen beide unauthentifizierten
Denial-of-Service-Pfade. Daneben steht die CI als zweites Problem: sie *kann
nichts blockieren*.

**Der Weg ist kurz.** Weil die Duplikation bereits niedrig ist, lautet die
Aufgabe nicht „aufräumen“, sondern „die drei strukturellen Schnitte ziehen, die
Testbarkeit freischalten“. Danach wird jede weitere Verbesserung durch CI
durchsetzbar statt nur empfehlenswert.

---

## 2. Verifikation

| Aussage | Prüfmethode | Ergebnis |
|---|---|---|
| Duplikatrate niedrig | jscpd, zwei Schwellwerte | bestätigt (0,32 % / 0,77 %) |
| Unauth. Heap-Wachstum via `POST /api/logout` | Live-Server, Kontrollgruppe, 6.000 Req. | bestätigt, 13,6 MB GC-fest |
| Rate-Limit auf `/api/auth` umgehbar | Live-Server, drei Key-Typen | bestätigt, nur Strings begrenzt |
| Unescapte Ausgabe in `renderCaps`/`renderSizes` | Sink + Datenquelle verfolgt | Sink bestätigt, durch CSP entschärft |
| Router-Crash bei Backslash im Hash | WHATWG-URL-Parser | bestätigt |
| `/api/backends/ollama/../../tags` umgeht das 404 | Live-Server, echtes Ollama als Diskriminator | bestätigt, 200 statt 404 |
| Hop-by-Hop-Header erreichen den Upstream | Mock-Upstream protokolliert Header | bestätigt |
| `/health` verrät Inventar ohne Session | Live-Server mit `MASTER_KEY` | bestätigt inkl. Version |
| `GET /%` erzeugt unauth. 500 | Live-Server | bestätigt |
| `main` ist ungeschützt | `gh api …/branches/main/protection` | bestätigt, 404 |
| Path-Traversal zur Ollaya möglich | 20+ Payloads, Live-Server + Unit | **widerlegt** |
| Content-Length/Transfer-Encoding-Desync | Live-Probe | **widerlegt**, 400 vor dem Relay |

### Zwei Negativergebnisse

Sie sind so wertvoll wie die Funde. Die vermutete Path-Traversal- und
Allowlist-Lücke im neuen Backend-Relay existiert nicht: `SEGMENT_RE` verbietet
`%` vollständig, `/api`-Pfade werden per exaktem `Set.has()` verglichen statt per
Prefix, und die geprüfte Zeichenkette ist identisch mit der später verwendeten —
es gibt also kein Check-then-Decode-Fenster. Ein Content-Length-Desync ist
ebenfalls nicht erreichbar. Beide Pfade sind sauber gebaut.

---

## 3. Duplikat-Analyse

Bei 8 Zeilen/60 Tokens findet jscpd genau **einen** Clone. Bei 5/40 sind es vier
— das ist die vollständige Liste.

| # | Fund | Stellen | Zeilen | Kern |
|---|---|---|---|---|
| A | Focus-Trap doppelt | `ui/confirm.ts:32`, `ui/modal.ts:50` | 14 | Identische Tab-Falle, aber mit **abweichendem Selektor**: `button:not([disabled])` gegen die volle Focusable-Liste. Die beiden Dialoge verhalten sich unterschiedlich. |
| B | Log-Panel doppelt | `pages/chat.css:69`, `pages/models.css:59` | 8 | `.embed-result` und `.pull-log` sind deklarationsgleich; `max-height` (200/160) und `line-height` (1,7/1,8) driften ohne Grund. |
| C | Card-Header-Muster | `index.html:122`, `index.html:390` | 5 | Statisches Markup-Muster, mehrfach wiederholt; dazu sechsmal derselbe Empty-State-Block. |
| D | Stat-Extraktion doppelt | `library.ts:112`, `library.ts:189` | 7 | Zwei Schleifen mit derselben Regex-Extraktion, mit **Label-Drift**: einmal `Pulls`, einmal `Downloads`. Ändert der Upstream die Beschriftung, liefert einer der beiden Parser still `null`. |

Drei der vier Fälle sind also nicht bloß Wiederholung, sondern schon
auseinandergelaufen. Genau das ist das Argument, sie zusammenzuziehen: nicht
Zeilen sparen, sondern Divergenz unmöglich machen.

### Strukturelle Duplikation

Wichtiger als die wörtlichen Clones ist die Wiederholung unterhalb jeder
Token-Schwelle. Sie ist der eigentliche Grund, warum die Datei schwer zu ändern
ist.

| Muster | Vorkommen | Vorschlag | Ersparnis |
|---|---|---|---|
| Cache + TTL + In-Flight-Promise | 3× `index.ts:316,441,494` | `createTtlCache<T>()` | ~45 Z. |
| `{cached, stale}`-Envelope | 6× `index.ts:431,479,486,513,524,528` | `catalogResponse()` | ~12 Z. |
| Scrape-Request inkl. `10_000`-Timeout | 4× `index.ts:335,353,447,501` | `SCRAPE_TIMEOUT_MS` + `scrapeFetch()` | ~15 Z. |
| LiteLLM-Auth-Header | 4× `index.ts:576,584,614,665` | `litellmHeaders()` | ~10 Z. |
| Backend-Probe-Fan-out | 2× `index.ts:306,1371` | `probeAll()` mit TTL | ~12 Z. |
| Register-/Delete-Block im Sync | 2× `index.ts:610,661` | `postModel()` + `pushDetail()` | ~40 Z. |
| Streaming-Button + Abort-Guard + NDJSON-Loop | 3× Frontend, `models.ts:216` | `streamNdjson()` + `setStreamingButton()` | ~60 Z. |
| Empty-State-Literal | 12× TS + 6× HTML | `emptyState(icon, html)` | ~20 Z. |
| `getElementById(…) as T` ohne Prüfung | 68 Stellen | `byId<T>(id)` | Typsicherheit |

Zusammen grob 175 Zeilen echter Löschung statt Verschiebung. Der Frontend-Anteil
ist der lohnendere: dort sind 13 von 15 Modulen ungetestet, und der kopierte
Stream-/Abort-/Busy-Stack ist genau der Code, der davon am meisten profitieren
würde.

---

## 4. Befunde

### Kritisch

#### K1 — Unauthentifiziertes, permanent wachsendes Revocation-Map

`src/index.ts:1351`, `src/auth.ts:50`

`POST /api/logout` steht **vor** dem Auth-Gate, nimmt den Token aus Cookie oder
`x-session-token`-Header und prüft weder Signatur noch Format. Der Wert wird
direkt als Map-Schlüssel abgelegt. `tokenExpiry()` liest nur
`Number(token.split(".")[0])` — eine gefälschte Zukunft-Expiry ist endlich und
wird vom stündlichen Sweep (`if (now > expiry) delete`) deshalb **nie** entfernt.

Empirisch belegt mit Kontrollgruppe: 6.000 Requests an `/api/session` (schreibt
nicht in die Map) ließen den RSS *fallen*; 6.000 Requests an `/api/logout` mit je
eindeutigem 4-KB-Token hoben ihn um **13,6 MB**, und der Wert blieb nach 5
Sekunden GC-Wartezeit stehen. Rund 2,3 KB Retention pro Request, bei 100 req/s
etwa 800 MB pro Stunde bis zum OOM.

**Fix:** Revocation nur eintragen, wenn `verifySessionToken()` erfolgreich war;
Map-Größe deckeln (älteste evakuieren); Token über ~200 Byte ablehnen.

#### K2 — Rate-Limit auf dem Login greift nur für Strings

`src/index.ts:1318`, `src/index.ts:142`

Der Limit-Check läuft oben korrekt, aber `recordAuthFailure()` wird erst *nach*
`timingSafeCompare()` erreicht. Diese Funktion ruft `Buffer.from(a)` auf und
wirft bei einem Nicht-String; der äußere `catch` macht daraus ein 400, und der
Fehlversuch wird nie gezählt.

Live gemessen, drei Varianten:

```
{"key":{}}   → 400 400 400 400 400 400 400 400   # nie begrenzt
{"key":123}  → 400 400 400 400 400 400 400 400   # nie begrenzt
{"key":"x"}  → 401 401 401 401 401 429 429 429   # Limit greift
```

Erschwerend liegt `await req.json()` vor jeder Prüfung, und `Bun.serve` setzt
kein `maxRequestBodySize` — der Default liegt bei 128 MB. Ein unauthentifizierter
Client kann also beliebig viele 128-MB-Bodies parsen lassen, ohne dass die Bremse
anspringt, die genau dafür da ist.

**Fix:** `typeof key !== "string"` vor dem Vergleich ablehnen und *jeden*
Fehlversuch zählen; Rate-Limit und Content-Type vor dem Body-Parsen prüfen;
explizites kleines `maxRequestBodySize` für die Auth-Route.

### Hoch

#### H1 — Unescapte Remote-Daten im Katalog-Renderer

`public/src/pages/catalog.ts:35`, `src/library.ts:87`

`renderCaps()` und `renderSizes()` interpolieren roh in `class="cap-${c}"` und in
Textknoten, während die direkten Nachbarzeilen derselben Datei `escHtml()` und
`escAttr()` verwenden. Die Werte stammen aus `badge.text.trim()` von gescraptem
ollama.com-Markup, und `node-html-parser` dekodiert dabei HTML-Entities — aus
`<img src=x onerror=…>` im Badge-Text wird also echtes Markup.

Ehrliche Kalibrierung: Der Sink ist real, und der Attribut-Ausbruch über ein
Anführungszeichen im Badge-Text ist erreichbar (Injection zusätzlicher Klassen
wie `installed` oder `running`, also UI-Spoofing). Code-Ausführung wird heute von
der CSP blockiert, deren `script-src 'self'` ohne `unsafe-inline` Inline-Handler
unterbindet. Die Ausnutzbarkeit hängt damit am Vertrauen in ollama.com-Markup,
nicht an direkter Nutzereingabe. Es ist eine Verteidigungslücke, kein offenes
Scheunentor — aber sie fällt in dem Moment, in dem irgendwann `unsafe-inline`
nötig wird.

**Fix:** `escHtml()` in beiden Renderern, Klassen-Suffix auf `[a-z0-9-]`
beschränken.

#### H2 — `idleTimeout: 60` kappt die Zeit bis zum ersten Byte

`src/index.ts:1272`, `src/index.ts:168`

Der Kommentar an der Stelle behauptet, der Wert betreffe die Streaming-Routen
nicht, weil diese eigene Timeouts hätten. Das ist falsch: Bun wendet
`idleTimeout` auf die Client-Verbindung an. Ein Kaltstart eines großen Modells,
der länger als 60 Sekunden bis zum ersten NDJSON-Byte braucht, verliert die
Verbindung — der `PROXY_CONNECT_TIMEOUT_MS = 600_000` ist für genau diesen Fall
toter Code. Dasselbe trifft `POST /api/litellm/sync`, das die gesamte
Synchronisation abwartet, bevor es antwortet.

**Fix:** `idleTimeout` auf ≥ 600 setzen, oder den Sync-Trigger sofort mit `202`
zurückkehren lassen und den Status pollen.

### Mittel

#### M1 — Hop-by-Hop- und Forwarding-Header erreichen den Upstream

`src/backends.ts:136`

`upstreamHeaders()` löscht exakt vier Namen; alles andere wird durchgereicht.
Gegen einen Mock-Upstream gemessen sah dieser:

```
x-forwarded-for: 1.2.3.4        proxy-authorization: Basic cHJveHk=
x-forwarded-proto: https        te: trailers
connection: X-Sneak             x-sneak: boom
```

Der vom Client nominierte `Connection`-Header `x-sneak` kam mit an — der
klassische Hop-by-Hop-Vektor aus RFC 7230. Korrekt entfernt wurden `cookie` und
`x-session-token`. Der Befund ist insofern inkonsistent mit dem Rest der
Codebase, als der eigene Login-Limiter `X-Forwarded-For`-Spoofing ausdrücklich
absichert, das Relay aber nicht. Ein `proxy-authorization` sollte nie nach oben
wiederholt werden.

**Fix:** Hop-by-Hop-Menge entfernen (`connection`, `te`, `transfer-encoding`,
`upgrade`, `keep-alive`, `proxy-authorization`), zusätzlich jeden im
`Connection`-Header nominierten Namen und die `x-forwarded-*`-Familie.

#### M2 — Upstream-Antworten gehen ungefiltert an den Client

`src/index.ts:277`

Antwort-Header und Body werden unverändert weitergereicht. Ein Mock-Upstream, der
die erhaltene `Authorization` zurückspiegelt, gab den Schlüssel über den Manager
an den Aufrufer zurück; zusätzlich landete ein `set-cookie` des Upstreams auf der
**Manager-Origin** (Cookie-Shadowing). Der Mechanismus ist belegt, die praktische
Erreichbarkeit eingeschränkt, weil im Repo kein Allowlist-Endpunkt Header
reflektiert. Die Vertraulichkeit des Schlüssels hängt damit am Verhalten Dritter
statt am eigenen Code.

**Fix:** `set-cookie` und Hop-by-Hop-Antwort-Header entfernen; Antwort-Header
verwerfen, deren Wert `backend.apiKey` enthält.

#### M3 — `/health` ist öffentlich und gibt das Backend-Inventar preis

`src/index.ts:1370`

Mit gesetztem `MASTER_KEY` gemessen:

```
GET /health        → 200  {"status":"ok","ollama":…,"backends":[{"id":"ollama",
                            "status":"connected","version":"0.34.4"}]}
GET /api/backends  → 401  {"error":"Unauthorized"}
```

Dieselbe Information, die hinter dem Auth-Gate liegt, ist unauthentifiziert
erreichbar, inklusive Versionsnummern. Zusätzlich hat keine der beiden Routen
einen Cache oder Single-Flight: zehn Requests lösen zwanzig Upstream-Probes aus
(Timeouts sind mit 2 s vorhanden, aber jeder Request bindet einen Socket).

**Fix:** gemeinsames `probeAll()` mit kurzer TTL; das `backends`-Array im
öffentlichen `/health` weglassen oder hinter die Session legen, damit der
Docker-Healthcheck weiter funktioniert.

#### M4 — Die Detail-Caches wachsen unbegrenzt

`src/index.ts:441`, `src/index.ts:1448`

`detailCache` hat keine Größengrenze, und die TTL wird nur beim Lesen geprüft —
abgelaufene Einträge werden nie gelöscht. Der Routen-Regex auf den Modellnamen
hat keine Längenbegrenzung. Millionen distinkter Namen erzeugen damit ebenso
viele permanente Einträge, und jeder Fehlschlag landet vollständig im Log.
Zusätzlich wird pro Name ein ausgehender HTTPS-Request ausgelöst, ohne globale
Nebenläufigkeitsgrenze.

**Fix:** Namenslänge deckeln, LRU-Eviction, den stündlichen Sweep auch hier
greifen lassen, Log-Eintrag kürzen.

#### M5 — Tests können den Server nicht im Prozess starten

`src/index.ts:1272`, `src/index.test.ts:4`

Der Import von `src/index.ts` ruft `Bun.serve()` auf Modulebene auf und
registriert stündliche Timer. Damit bindet jeder Testlauf Port 3000 und stirbt
mit `EADDRINUSE`, wenn dort etwas lauscht; fehlt `dist/public/index.html`, wirft
schon der `readFileSync` beim Import. Deshalb testet `server.test.ts` als
Kindprozess — und wird von `bun --coverage` nicht instrumentiert. Das ist der
eigentliche Grund, warum `handleRequest`, `forwardToBackend` und
`withSecurityHeaders` bei 0 % liegen.

**Fix:** `Bun.serve()` hinter `import.meta.main` legen und reine Helfer
importierbar halten. Das schaltet die gesamte Router- und Relay-Schicht für
In-Process-Tests frei und ist die Voraussetzung dafür, dass ein
Coverage-Schwellwert überhaupt erreichbar ist.

### Niedrig

- **Unauth. 500 vor dem Auth-Gate:** `decodeURIComponent` auf dem Static-Pfad
  ohne try/catch — `GET /%` ergab live **500** und eine Log-Zeile, pro Request
  wiederholbar. `src/index.ts:1402`
- **404-Vertrag gilt nicht für alle URLs:** `/api/backends/ollama/../../tags`
  normalisiert aus dem Prefix heraus, fällt in den Legacy-Alias und liefert live
  **200 mit echter Modellliste** statt 404. Die Kontrolle
  `/api/backends/ollama/%2e%2e/tags` liefert korrekt 404. Kein Rechtezugewinn,
  aber der dokumentierte Vertrag ist falsch und die geloggte Pfadangabe weicht
  vom Upstream-Pfad ab. `src/index.ts:1430`
- **Kein Methoden-Check** auf `/health`, `/api/app-version`,
  `/api/openapi.json`, `/api/docs` und `/api/catalog/library`. `POST /health`
  löst unauthentifiziert den vollen Backend-Probe aus, `POST
  /api/catalog/library` einen kompletten Scrape. `src/index.ts:1363`
- **`normalizeHost()` akzeptiert jedes Schema** und verliert Pfade:
  `http://h?x=y` ergibt `http://h:11435/?x=y`, wodurch jedes Relay falsch
  umgeleitet wird; `file:///etc/passwd` wird akzeptiert; ein Tippfehler wie
  `http://h:99999` bricht den Start ohne Hinweis auf die Variable ab.
  `OLLAMA_HOST` durchläuft die Funktion gar nicht. `src/backends.ts:96`
- **Router bricht bei Backslash im Hash ab:** der `location.hash` behält einen
  Backslash (der URL-Parser encodiert ihn nicht), der Selektor in `nav.ts:61` ist
  dann syntaktisch kaputt und `querySelector` wirft. Da `startInitialPage()` in
  `public/src/app.ts:28` ohne try/catch auf Top-Level läuft und die
  `checkSession()`-IIFE erst in Zeile 30 folgt, reißt der Fehler den Rest ab —
  bei gesetztem `MASTER_KEY` erscheint das Login-Overlay nicht mehr.
- **Cache-Invalidierung unvollständig:** `pullModel()` und `copyModel()`
  aktualisieren den Modell-Cache nicht; ein neu gezogenes Modell fehlt bis zum
  manuellen Refresh in der Liste und allen Dropdowns. `ensureModels()` cached ein
  fehlgeschlagenes Promise dauerhaft, ein einzelner transienter Fehler leert
  damit die Dropdowns für die restliche Session.
  `public/src/state/models.ts:44`
- **Doppelklick-Lücke:** `showConfirm` hat keinen Re-Entrancy-Guard. Ein zweiter
  Klick überschreibt `okBtn.onclick`, das erste Promise bleibt ewig offen und
  sein `document`-Keydown-Listener wird nie entfernt.
  `public/src/ui/confirm.ts:46`
- **Tote Regeln:** `.form-row.cols3` ist dreifach definiert und null Mal
  verwendet (`cols2` dagegen wird genutzt); `.catalog-card.installed` steht
  zweimal mit gleicher Spezifität, der erste Block wird immer verworfen;
  `nav { flex-direction: row }` im Responsive-Layer ist wirkungslos, weil `nav`
  ein Grid ist.
- **Stale Referenzen:** ein Kommentar verweist auf das längst ersetzte
  `forwardToOllama`; README und Code behaupten, die Web-UI nutze
  `/api/backends/*`, während `public/src/**` ausschließlich die alten
  `/api/*`-Pfade aufruft; drei exportierte Funktionen haben keinen Importeur;
  `src/__fixtures__/library.sample.html` wird nirgends referenziert und ist
  gleichzeitig die einzige Fixture, die MoE- und Sub-Billion-Größenbadges
  abdeckt.
- **Supply Chain:** alle acht Actions sind auf bewegliche Major-Tags statt auf
  SHAs gepinnt, `bun-version: latest` macht den Toolchainlauf nicht
  reproduzierbar, und `typescript` fehlt als devDependency, sodass `bunx tsc`
  bei jedem CI-Lauf eine neue Version aus der Registry zieht.

### Was diese Änderung nebenbei repariert hat

Der Vorgänger `forwardToOllama` entfernte `origin`, `referer` und `cookie`, aber
**nicht** `x-session-token`. Jede über den Legacy-Proxy geleitete Anfrage hat
damit das Session-Token des Managers an Ollama weitergegeben. Das neue
`upstreamHeaders()` schließt diese Lücke, und der Test belegt es gegen den
Upstream. Auth-Kern, Pfadvalidierung, CSP, Path-Traversal-Schutz und
Cookie-Konfiguration sind sauber gebaut und wurden korrekt verifiziert.

---

## 5. Struktur und Teststand

Der Coverage-Gesamtwert von 91,6 % Zeilen täuscht. Bun instrumentiert nur
Module, die der Testprozess importiert; die 13 ungetesteten Frontend-Module
erscheinen deshalb gar nicht in der Tabelle. Die ehrliche Verteilung:

| Datei | Zeilen | Coverage (Funcs) | Anmerkung |
|---|---:|---:|---|
| `src/auth.ts` | 64 | 100 % | Token-Roundtrip, Tampering, Malformed — vorbildlich |
| `src/library.ts` | 266 | 100 % | Gegen echte Snapshots; keine Negativpfade getestet |
| `src/backends.ts` | 178 | 90 % | Traversal-Negatives vorhanden; Probe-Timeout ungetestet |
| Frontend (13 Module) | ~1.413 | 8,7 % | 2 von 15 Modulen; kein DOM-Harness, daher nicht testbar |
| `src/index.ts` | 1.490 | 23,7 % | Router, Relay, Security-Header, Sync, beide Cache-Pfade |

Ungetestet sind damit genau die Laufzeit- und Sicherheitsschichten:
`handleRequest()` (176 Zeilen), `forwardToBackend()` (45), `withIdleTimeout()`,
`withSecurityHeaders()`, die Logout-Revocation, das Login-Rate-Limit, beide
Katalog-Caches inklusive `stale`-Fallback und die komplette LiteLLM-Synchronisation
(146 Zeilen). Es fehlt **kein** Test für die reinen Helfer — es fehlt die
Fähigkeit, den Server im Prozess zu starten.

### Modul-Schnitt

| Neues Modul | Übernimmt | Zeilen |
|---|---|---:|
| `src/openapi.ts` | die 478-zeilige Inline-Spec + Swagger-Shell | 478 |
| `src/catalogs.ts` | Scrape-Fetch, drei Cache-Stacks, beide Katalogrouten | 217 |
| `src/litellm.ts` | Sync, Status, Scheduler | 190 |
| `src/session.ts` | Revocation, Rate-Limit, Cookie-Helfer | 85 |
| `src/http.ts` | `log`/`jsonError`, `withIdleTimeout`, CSP | 130 |
| `src/routes.ts` | Routentabelle statt 179-zeiliger if-Kette | 180 |

Nach dem Schnitt bleiben rund 330 Zeilen Bootstrap in `index.ts`. Der wichtigste
Nebeneffekt ist nicht die Zeilenzahl, sondern dass die Reihenfolge „public vor
Gate“ dann **Daten** ist statt Statement-Reihenfolge. Heute hängt die
sicherheitskritische Eigenschaft, die `CLAUDE.md` ausdrücklich als schützenswert
markiert, allein daran, dass niemand die Zeilen umsortiert.

---

## 6. CI-Plan

Die Pipeline ist inhaltlich fast vollständig — Lint, zwei Typprüfungen,
Frontend-Build, Tests. Sie ist nur nicht in der Lage, irgendetwas zu verhindern.

Der entscheidende Befund ist nicht ein fehlender Job, sondern die fehlende
Klammer um die vorhandenen. `main` hat keinen Branch-Schutz (`gh api` antwortet
mit 404 „Branch not protected“), es gibt also keine Required Status Checks. Und
`.github/workflows/docker-image.yml` besteht ausschließlich aus `uses:`-Schritten
— **kein einziger `run:`-Schritt**, mithin keine Zeile Lint, Typprüfung oder
Test. Ein rotes `main` lässt sich heute taggen und als Multi-Arch-Image nach GHCR
schieben.

Die Reihenfolge folgt daraus: erst die Klammer, dann die Messung, dann die
Verschärfung. Alles gleichzeitig zu bauen, erzeugt eine rote Pipeline, die
niemand mehr liest.

### P0 — Die Pipeline muss blockieren können

*Aufwand: etwa eine Stunde, kein Codeänderungsbedarf.*

1. **Branch-Schutz auf `main`** aktivieren, den `check`-Job als Required Status
   Check, „require branches to be up to date“ dazu. Das ist die eine Einstellung
   mit dem größten Effekt.
2. **Tags dürfen nicht ungeprüft veröffentlichen.** Entweder `ci.yml` um
   `workflow_call` erweitern und im Release-Workflow als Gate voranstellen, oder
   minimal die fünf Schritte duplizieren:

   ```yaml
   jobs:
     build:
       needs: verify          # ci.yml um „workflow_call:" erweitern
       runs-on: ubuntu-latest
   ```

   Zusätzlich im Release-Workflow prüfen, dass der Tag zu `package.json` passt —
   heute ist `0.2.3` nirgends gegen den Tag abgeglichen.
3. **Testisolation reparieren:** `Bun.serve()` hinter `import.meta.main`. Heute
   bindet jeder Testlauf Port 3000 und scheitert mit `EADDRINUSE`, wenn dort
   etwas läuft. Das ist zugleich der Hebel für P1.

### P1 — Qualität sichtbar und reproduzierbar machen

*Aufwand: etwa ein halber Tag, wenige Zeilen Konfiguration.*

Erst messen, dann fordern. Ein Coverage-Schwellwert auf heutigem Stand wäre nur
rot; nach P0.3 ist er erreichbar.

**Coverage mit Schwelle.** `src/index.ts` steht bei 23,7 % Funcs und ist heute
unsichtbar.

```toml
# bunfig.toml
[test]
coverageThreshold = { lines = 0.75, functions = 0.6 }
coverageReporter = ["text", "lcov"]
```

```yaml
# ci.yml — Tests mit Coverage statt blank
- name: Test
  run: bun test --coverage

- name: Coverage-Artefakt
  if: always()
  uses: actions/upload-artifact@<sha>
  with: { name: lcov, path: coverage/lcov.info }
```

**Toolchain fixieren.** `typescript` als devDependency aufnehmen und durch
`bun run typecheck` ersetzen; `bun-version` auf eine feste Version oder
`bun-version-file` setzen. Heute kann ein neues TS-Minor die Pipeline ohne einen
einzigen Commit rot machen.

**Versorgungskette absichern.** Alle acht Actions auf Commit-SHAs pinnen,
besonders im Workflow mit `packages: write`. Dependabot für Actions und
Dependencies, dazu ein zunächst unverbindlicher Audit:

```yaml
- name: Audit
  run: bun audit --audit-level=high || true   # erst beobachten, dann blockieren
```

**Laufzeit und Kosten.** `concurrency` mit `cancel-in-progress`, Cache für
`~/.bun/install/cache`, `timeout-minutes` (die E2E-Tests starten Kindprozesse und
können hängen), und `paths-ignore` für reine Doku-PRs.

**Docker prüfen, bevor getaggt wird.** Der Dockerfile-Build läuft heute
ausschließlich beim Release, ein kaputtes `COPY` fällt also erst dort auf. Ein
Smoke-Test gegen den eigenen Healthcheck:

```yaml
- name: Image bauen und Healthcheck prüfen
  run: |
    docker build --build-arg BUILD_VERSION=ci -t om:ci .
    docker run -d --name om -p 3100:3000 om:ci
    for i in $(seq 30); do curl -fsS http://localhost:3100/health && break; sleep 1; done
    docker rm -f om
```

### P2 — Die Latte heben

*Fortlaufend.*

**Typprüfung verschärfen.** Beide tsconfigs setzen nur `strict: true`. Es fehlen
unter anderem `noUncheckedIndexedAccess` (diese Codebase indiziert ständig in
Arrays), `verbatimModuleSyntax` (Typ- und Wertimporte werden bereits gemischt,
also nahezu kostenlos), `noImplicitOverride`, `noImplicitReturns` sowie
`noUnusedLocals`/`noUnusedParameters`. Schrittweise aktivieren, Datei für Datei,
damit die Pipeline nicht in einem Rutsch rot wird.

**Lint scharf stellen.** `noExplicitAny` ist auf `warn` heruntergestuft, und
Biome beendet sich mit Exit 0 auf Warnungen — die acht Fundstellen sind für die
Pipeline also unsichtbar. Auf `error` heben, sobald die acht Stellen typisiert
sind. Dazu zwei Aufräumarbeiten: `public/index.html` liegt außerhalb von
`files.includes` und wird **gar nicht** gelintet (die CSP-Regel „keine
Inline-Skripte“ ist damit ungeprüft), und `.biomeignore` ist wirkungslos, weil es
das Ignore-Format vor Biome 2.0 nutzt und die genannten Pfade ohnehin
ausgeschlossen sind.

**Duplikate als Ratsche, nicht als Programm.** Bei 0,32 % wäre ein scharfer
Schwellwert schädlich. Sinnvoll ist ein jscpd-Lauf mit ~2 % Limit, der erst
greift, wenn echte Kopien entstehen:

```yaml
- name: Duplikat-Ratsche
  run: bunx jscpd@4 --min-lines 8 --min-tokens 60 --threshold 2 src public
```

**Frontend testbar machen.** 13 von 15 Modulen sind heute nicht testbar, nicht
bloß ungetestet — es fehlt ein DOM-Harness. Der lohnendste erste Test ist
`public/src/api.ts`: `readNdjsonLines()` verarbeitet Chunk-Grenzen, Teilzeilen und
fehlerhaftes JSON, und der 401-Overlay-Pfad ist sicherheitsrelevant. Danach der
Hash-Router, der den in diesem Report belegten Backslash-Crash enthält.

**Die untested Security-Fläche schließen.** Sobald P0.3 erledigt ist, sind
Logout-Revocation, Login-Rate-Limit inklusive der Nicht-String-Umgehung,
`TRUST_PROXY` und das `Secure`-Cookie-Flag, die Security-Header und der
Static-Traversal-Guard als In-Process-Tests erreichbar. Jeder dieser Tests hätte
einen der Befunde in diesem Report vorab gefangen.

---

## 7. Reihenfolge

Die Befunde sind nach Wirkung sortiert, nicht nach Fundort. Die beiden
kritischen Punkte sind klein und isoliert behebbar; die CI-Klammer aus P0 ist
Voraussetzung dafür, dass die Korrekturen nicht zurückfallen.

| Priorität | Maßnahme | Ort | Aufwand |
|---|---|---|---|
| **Kritisch** | Revocation nur nach Signaturprüfung eintragen, Map deckeln | `index.ts:1351` | klein |
| **Kritisch** | Nicht-String-Keys ablehnen, jeden Fehlversuch zählen, Body-Limit setzen | `index.ts:1318` | klein |
| **P0** | Branch-Schutz + Release-Gate + `import.meta.main` | Workflows, `index.ts:1272` | klein |
| **Hoch** | `escHtml()` in beiden Katalog-Renderern, Klasse beschränken | `catalog.ts:35` | klein |
| **Hoch** | `idleTimeout` anheben oder Sync asynchron machen | `index.ts:1282` | klein |
| **P1** | Coverage-Schwelle, TS pinnen, Actions SHA-pinnen, Docker-Smoke | Workflows | mittel |
| **Mittel** | Hop-by-Hop-Header und `set-cookie` filtern | `backends.ts:136` | klein |
| **Mittel** | `probeAll()` mit TTL, `/health` entschlacken | `index.ts:1370` | mittel |
| **Mittel** | Cache-Modul extrahieren, drei Stacks auf einen reduzieren | `index.ts:316` | mittel |
| **Mittel** | `openapi.ts` auslagern (478 Zeilen, rein mechanisch) | `index.ts:728` | klein |
| **Mittel** | Modul-Schnitt + Routentabelle, dann In-Process-Tests | `index.ts` | groß |
| **P2** | tsconfig verschärfen, Lint auf `error`, DOM-Harness, Duplikat-Ratsche | Konfiguration | fortlaufend |
| **Niedrig** | Tote CSS-Regeln, stale Referenzen, orphan Fixture, Doku-Drift | verteilt | klein |

**Die kurze Fassung:** zwei kleine Sicherheitsfixes, drei Workflow-Korrekturen,
ein mechanischer Auslagerungsschnitt. Danach hält die Pipeline die Qualität, die
der Code heute schon weitgehend hat.

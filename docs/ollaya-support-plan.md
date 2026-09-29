# Plan: Ollaya-Support im Ollama Manager

Stand: 2026-09-29, basierend auf `ollaya-dev/ollaya@b88bf19` und dessen normativem API-Vertrag
(`docs/api.md`).

## 1. Was ist Ollaya, und was bedeutet das für uns?

[Ollaya](https://github.com/ollaya-dev/ollaya) ist "Ollama für Decision Models": ein lokaler
Daemon (Rust, Standard-Port **11435**), der Modelle wie `laya`, `winnow:e4b`, `decider`, `kev`,
`nli` … per Name pullt und ausliefert. Ein Decision Model generiert **keinen Text**, sondern
beantwortet typisierte Fragen (`choice`, `score`, `noul`) zu einem `state` mit kalibrierten
Wahrscheinlichkeiten.

Die Management-API ist bewusst Ollama-kompatibel, was den Grossteil unserer UI wiederverwendbar
macht:

| Endpoint | Ollama | Ollaya | Auswirkung auf den Manager |
|---|---|---|---|
| `GET /api/version`, `GET /api/tags`, `GET /api/ps` | ✓ | ✓ gleiche Form | Dashboard, Models, Running funktionieren weitgehend unverändert |
| `POST /api/pull` (NDJSON) | ✓ | ✓ gleiche Statuszeilen | Pull-UI wiederverwendbar; Pre-Stream-Fehler kommen als echte HTTP-Fehler (404/422/502) |
| `DELETE /api/delete`, `POST /api/copy` | ✓ | ✓ | unverändert |
| `POST /api/show` | ✓ | ✓ aber **ohne** `template`, **mit** `questions`, `router`, `capabilities` (`choice/score/noul/act`), `model_info` | Detail-Modal anpassen |
| `POST /api/create` | Modelfile + `files`/Blobs | strukturiertes JSON (`from`, `questions`, `calibration`, `parameters`, `license`, `description`) | eigenes Formular (optional, Phase 3) |
| `/api/chat`, `/api/generate`, `/api/embed` | ✓ | **404** | für Ollaya ausblenden |
| `POST /api/decide` | – | **neu** | neue Seite "Decide" |
| `/v1/systemone`, `/v1/decisions`, `/v1/models` | – | TypeSafe-kompatibel | optional durchreichen |

Weitere Unterschiede, die wir abfangen müssen:

- **Fehler-Body**: `{"error": "...", "code": "MODEL_NOT_FOUND", "detail": [...]}` – `error` bleibt
  ein String, `api.ts` kann ihn also weiter anzeigen; `code`/`detail` können wir zusätzlich nutzen
  (z.B. Validierungsfehler pro Frage anzeigen).
- **`/api/ps`**: `expires_at` kann `null` sein (= "forever"), zusätzlich `device` und
  `context_length`. Routers erscheinen nie.
- **`details.format`**: `onnx`, `gguf` oder `router`; Router haben `parameter_size: ""` und
  `quantization_level: ""`.
- **Auth**: Wenn `OLLAYA_API_KEY` gesetzt ist, verlangt Ollaya `Authorization: Bearer <key>`
  für alles ausser `GET /`.
- **Host/Origin-Check**: Ollaya lehnt fremde `Origin` und (bei Loopback-Bind) fremde `Host`-Header
  mit 403 ab. Unser Proxy strippt `origin`/`referer` bereits und setzt `host` auf das Upstream-Ziel –
  das gleiche Muster funktioniert auch hier.
- **Katalog**: ollaya.dev liefert einen statischen JSON-Index unter
  `https://ollaya.dev/search.json` (`models[].name/description/caps/rank/updated/tags[]`) – kein
  HTML-Scraping nötig.
- **LiteLLM**: Decision Models sind keine Chat/Completion-Modelle; ein Sync nach LiteLLM ergibt
  keinen Sinn. → Bewusst **ausser Scope**.

## 2. Architekturentscheidung

**Empfehlung: Ollaya als optionales, zweites Backend neben Ollama** (nicht als Ersatz).

- Neue Env-Variablen: `OLLAYA_HOST` (unset = Feature aus) und `OLLAYA_API_KEY` (optional).
- Da Ollama und Ollaya dieselben Pfade (`/api/tags`, `/api/pull`, …) verwenden, bekommt Ollaya
  einen eigenen Proxy-Präfix: **`/api/ollaya/*` → `${OLLAYA_HOST}/api/*`** (und
  `/api/ollaya/v1/*` → `${OLLAYA_HOST}/v1/*`). Der bestehende Ollama-Proxy bleibt unverändert,
  keine Breaking Changes.
- Im Frontend gibt es einen **Backend-Umschalter** (Ollama | Ollaya) im Header/der Sidebar, der nur
  erscheint, wenn der Server Ollaya als konfiguriert meldet. Die Seiten Models, Running, Pull, Copy,
  Dashboard und Catalog arbeiten dann gegen das gewählte Backend; Chat/Generate/Embed werden bei
  Ollaya ausgeblendet und durch "Decide" ersetzt.

Verworfene Alternativen:

- *`OLLAMA_HOST` einfach auf Ollaya zeigen lassen*: funktioniert heute schon teilweise (Tags, Pull,
  Delete), aber Chat bricht, `show` zeigt Unsinn, Katalog zeigt Ollama-Modelle – kein echter Support.
- *Mode-Flag `BACKEND=ollama|ollaya`*: einfacher, erlaubt aber nicht, beide Instanzen aus einer UI
  zu verwalten (typisch: beide laufen auf demselben GPU-Host).

## 3. Umsetzung in Phasen

### Phase 1 – Backend-Grundlage (`src/`)

1. **Config** in `src/index.ts`: `OLLAYA_HOST` (Default: unset; ohne Schema `http://` annehmen,
   ohne Port `11435`), `OLLAYA_API_KEY`, `OLLAYA_ENABLED`.
2. **Proxy verallgemeinern**: `forwardToOllama(req)` → `forwardUpstream(req, upstream)` mit
   `{ baseUrl, pathRewrite, extraHeaders }`. Header-Stripping (`origin`, `referer`, `cookie`)
   bleibt für beide Ziele identisch. Für Ollaya:
   - eingehendes `Authorization` löschen und, falls gesetzt, `Authorization: Bearer
     ${OLLAYA_API_KEY}` serverseitig setzen (der Key verlässt nie den Server);
   - `STREAMING_API_PATHS` gilt für die umgeschriebenen Pfade (`/api/pull`, `/api/create`).
3. **Routing** in `handleRequest()`: `/api/ollaya/...` **nach** dem `MASTER_KEY`-Auth-Gate
   behandeln (Reihenfolge laut CLAUDE.md beibehalten), vor dem Ollama-Fallback. Wenn Ollaya nicht
   konfiguriert ist: `404 {"error":"Ollaya not configured"}`.
   Pfad-Whitelist: nur bekannte Ollaya-Pfade durchreichen (`version`, `tags`, `ps`, `show`, `pull`,
   `delete`, `copy`, `create`, `decide`, `v1/systemone`, `v1/decisions`, `v1/models`), kein
   Path-Traversal über `..`.
4. **Capabilities-Endpoint**: `/api/app-version` (oder neu `/api/backends`, hinter dem Auth-Gate)
   liefert `{ ollama: true, ollaya: OLLAYA_ENABLED }`, damit das Frontend den Umschalter anzeigen kann.
5. **`/health`**: zusätzlich `ollaya: "connected" | "unreachable" | "disabled"` und `ollayaVersion`
   via `GET ${OLLAYA_HOST}/api/version` (2s-Timeout, mit Bearer-Key). HTTP-Status bleibt 200.
6. **Katalog**: `/api/catalog/ollaya` holt `https://ollaya.dev/search.json`, validiert/normalisiert
   es (neue Funktion in `src/library.ts`, z.B. `parseOllayaSearchIndex()`), In-Memory-Cache 1 h wie
   beim Ollama-Katalog. Tags kommen direkt aus `models[].tags[]`, eine Detail-Route ist zunächst
   nicht nötig.
7. **OpenAPI-Spec** um die neuen Routen ergänzen; Startup-Log um `ollaya: OLLAYA_HOST` erweitern.
8. **Tests** (`src/*.test.ts`): Pfad-Rewrite und Whitelist, Header-Stripping + Bearer-Injection,
   Auth-Gate greift auch für `/api/ollaya/*`, 404 wenn deaktiviert, Parser für `search.json`
   (Fixture), Health-Ausgabe.

### Phase 2 – Frontend: Verwaltung (`public/src/`)

1. **Backend-State**: neues Modul `public/src/state/backend.ts` (`currentBackend`, `apiBase()` →
   `/api` oder `/api/ollaya`, Change-Event). Auswahl im `localStorage` merken (in `try/catch`).
2. **`api.ts`**: Hilfsfunktion `backendPath("/tags")`; Fehlertext aus `error` wie bisher, bei
   Ollaya zusätzlich `code` und die `detail[].msg` anzeigen.
3. **`state/models.ts`**: Cache pro Backend (sonst mischen sich Modelllisten beim Umschalten).
4. **Umschalter-UI** in `public/index.html` + `nav.ts`: Segment-Control "Ollama | Ollaya",
   nur sichtbar, wenn der Server Ollaya meldet. Beim Wechsel aktuelle Seite neu laden;
   Nav-Einträge Chat/Generate/Embeddings/LiteLLM bei Ollaya ausblenden, "Decide" einblenden.
   Keine Inline-Handler (CSP) – Event-Delegation wie bestehend.
5. **Dashboard**: Status beider Backends anzeigen (aus `/health`), Kennzahlen aus dem aktiven
   Backend.
6. **Models-Seite**: Spalten `format` (onnx/gguf/router), `parameter_size`, `quantization_level`;
   Router markieren. Detail-Modal für Ollaya: `capabilities`, `questions` (eingebettetes Schema),
   `router.routes`, `model_info` (`general.languages`, `general.source`), `license`,
   `parameters` statt `template`.
7. **Running-Seite**: `expires_at: null` → "forever", `device` (cpu/cuda:0/metal) und
   `context_length` anzeigen; "Unload" via `POST /api/decide {model, keep_alive: 0}` (ohne `state`).
8. **Pull-Seite**: gleicher NDJSON-Reader; Texte "from ollaya.dev"; Hinweis, dass ein Router seine
   Ziele mitpullt. Pre-Stream-HTTP-Fehler (404 "not found in registry", 502) sauber anzeigen.
9. **Copy/Delete**: unverändert, nur gegen `apiBase()`.
10. **Catalog-Seite**: zweite Datenquelle `/api/catalog/ollaya`; Karten mit `description`, `caps`,
    Featured-Tags; Sortierung nach `rank` (kein Pull-Count vorhanden). Klick → Pull gegen Ollaya.

### Phase 3 – Frontend: Decide-Playground (neu, `public/src/pages/decide.ts`)

1. Modell-Auswahl (aus Ollaya-`/api/tags`), Textarea für `state` (Text oder JSON), Frage-Editor:
   Liste von Fragen mit Id, Typ (`choice`/`score`/`noul`), `instructions`, `criteria`
   (Label→Beschreibung bzw. Level-Liste). Alternativ Roh-JSON-Editor.
2. Wenn `/api/show` eingebettete `questions` liefert: vorbefüllen und "Built-in questions
   verwenden" anbieten (dann `questions` weglassen).
3. Presets (z.B. Support-Triage wie im Ollaya-README) als Startpunkt.
4. `POST /api/ollaya/decide` (nicht streamend, per AbortController abbrechbar); optional
   `extras: ["laya"]`, `keep_alive`, Bild-Upload für Vision-Modelle (`capabilities`/`decider:2b-vision`,
   Base64-PNG in `images`).
5. Ergebnis-Rendering: pro Frage Balken der `probabilities`, hervorgehobene `choice`/`score`/`noul`,
   `confidence`, `routing` (bei `laya`), `state_truncated`-Warnung, `usage.input_tokens`,
   `load_duration`/`eval_duration` (ns → ms).
6. Validierungsfehler (`422` mit `detail[].loc`) direkt an der betroffenen Frage anzeigen.
7. Optional: "Als Modell speichern" → `POST /api/ollaya/create` mit `from` + aktuellem Fragen-Set
   (+ `parameters.precision`, `description`), Fortschritt über den NDJSON-Reader.

### Phase 4 – Betrieb, Doku, CI

1. **README** + **CLAUDE.md**: neue Env-Variablen (`OLLAYA_HOST`, `OLLAYA_API_KEY`), Architektur
   (zweiter Proxy-Präfix), Hinweis dass LiteLLM nur Ollama betrifft.
2. **docker-compose.yml**: optionaler `ollaya`-Service (`ghcr.io/ollaya-dev/ollaya`, bzw. `:cuda`)
   bzw. `OLLAYA_HOST=http://host.docker.internal:11435`. Hinweis: Ollaya auf dem Host bindet
   standardmässig nur `127.0.0.1` → für Docker `OLLAYA_HOST=0.0.0.0` + `OLLAYA_API_KEY` setzen.
3. **Dockerfile**: keine Änderung nötig.
4. **CI**: bestehende Lint/Typecheck/Build/Test-Pipeline deckt alles ab; optional ein
   Integrations-Job mit dem CPU-Image von Ollaya und einem kleinen Modell (Smoke-Test Pull → Tags
   → Decide) – wegen Download-Grösse (hunderte MB) eher manuell/nightly.

## 4. Risiken und offene Fragen

- **API-Stabilität**: Ollaya ist jung; die Doku nennt sich aber "normative contract" und
  versioniert (§12). Wir verlassen uns nur auf dokumentierte Felder und behandeln unbekannte
  defensiv.
- **`search.json`** ist als Navbar-Typeahead gedacht, nicht als offizielle API – Format kann sich
  ändern. Parser tolerant bauen, bei Fehler leere Liste + Hinweis statt Absturz.
- **Sicherheit**: `/api/ollaya/*` erlaubt Pull/Delete/Create – gleiche Risiken wie beim
  Ollama-Proxy. Die bestehende `MASTER_KEY`-Warnung auf Ollaya ausweiten.
- **Idle-Timeout**: `/api/decide` streamt nicht; grosse Modelle können beim ersten Laden lange
  brauchen (`OLLAYA_LOAD_TIMEOUT` Default 5 min). Unser `PROXY_CONNECT_TIMEOUT_MS` (10 min bis zu
  den Response-Headern) reicht dafür; im Frontend einen Lade-Hinweis ("Modell wird geladen …")
  anzeigen.
- **Offen**: Soll der Umschalter pro Seite oder global sein? (Empfehlung: global.) Sollen beide
  Backends gleichzeitig auf dem Dashboard erscheinen? (Empfehlung: ja, nur Status + Anzahl.)

## 5. Aufwandsschätzung

| Phase | Umfang | Grobe Schätzung |
|---|---|---|
| 1 Backend | Proxy-Refactor, Routing, Health, Katalog, Tests | 1–1,5 Tage |
| 2 Verwaltung | Backend-State, Umschalter, Anpassungen Models/Running/Pull/Catalog | 1,5–2 Tage |
| 3 Decide-Playground | neue Seite inkl. Frage-Editor und Ergebnis-Ansicht (+ Create optional) | 2 Tage |
| 4 Doku/Betrieb | README, CLAUDE.md, Compose | 0,5 Tage |

Phase 1 + 2 liefern bereits vollwertiges Modell-Management für Ollaya; Phase 3 ist der eigentliche
Mehrwert (Decision Models ausprobieren) und kann separat gemergt werden.

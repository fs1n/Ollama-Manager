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
| `/api/chat`, `/api/generate`, `/api/embed` | ✓ | **404** | nur Ollama-Modelle anbieten |
| `POST /api/decide` | – | **neu** | neue Seite "Decide" |
| `/v1/systemone`, `/v1/decisions`, `/v1/models` | – | TypeSafe-kompatibel | durchreichen (auch relevant für LiteLLM, siehe §4) |

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

## 2. Architektur: Ollama und Ollaya parallel

**Entscheidung: kein Umschalter.** Die UI zeigt immer **alle konfigurierten Backends
gleichzeitig**. Jedes Modell, jeder laufende Prozess und jeder Pull gehört sichtbar zu einem
Backend, und Aktionen gehen automatisch an das richtige Backend.

### 2.1 Backend-Registry (Server)

- Neue Env-Variablen: `OLLAYA_HOST` (unset = Ollaya aus) und `OLLAYA_API_KEY` (optional).
- Intern eine Liste statt Einzelwerte, damit später weitere Instanzen (z.B. zwei GPU-Hosts)
  ohne Umbau dazukommen können:

  ```ts
  type BackendKind = "ollama" | "ollaya";
  interface Backend {
    id: string;          // "ollama", "ollaya" – stabil, erscheint in URLs
    kind: BackendKind;
    label: string;       // "Ollama", "Ollaya"
    baseUrl: string;     // OLLAMA_HOST / OLLAYA_HOST
    apiKey?: string;     // OLLAYA_API_KEY, nur serverseitig
  }
  ```

### 2.2 Einheitliches URL-Schema

Der Manager-Server leitet Anfragen der Oberfläche an die Backends weiter, weil der Browser sie
nicht direkt erreichen kann: Sie laufen meist nur auf `localhost` des Servers, lehnen fremde
Origins ab, und Login (`MASTER_KEY`) sowie `OLLAYA_API_KEY` sollen auf dem Server bleiben. Da
Ollama und Ollaya dieselben Pfade haben (`/api/tags`, `/api/pull`, …), muss die URL sagen,
**welches** Backend gemeint ist. Dafür gilt für alle Backends dasselbe Schema:

| Manager-Route | Ziel |
|---|---|
| `GET /api/backends` | Liste aller Backends mit Status, Version und Fähigkeiten |
| `/api/backends/{id}/{pfad}` | `${baseUrl}/api/{pfad}` des Backends `{id}` |
| `/api/backends/{id}/v1/{pfad}` | `${baseUrl}/v1/{pfad}` – zunächst nur für Ollaya freigeschaltet (TypeSafe-kompatible API) |

Beispiele:

```
/api/backends/ollama/tags     → Ollama  /api/tags
/api/backends/ollaya/tags     → Ollaya  /api/tags
/api/backends/ollaya/decide   → Ollaya  /api/decide
/api/backends/ollaya/v1/models → Ollaya /v1/models
```

- **Kein Backend ist "Haupt-Backend"** – alle werden gleich adressiert; ein weiterer Host wäre
  einfach `/api/backends/gpu2/…`.
- **`{id}`** muss `^[a-z0-9-]+$` entsprechen und in der Registry existieren, sonst
  `404 {"error":"Unknown backend"}`. Nicht konfigurierte Backends (z.B. `OLLAYA_HOST` unset)
  existieren schlicht nicht.
- **Pfad-Whitelist pro Typ**: Ollaya nur die dokumentierten Pfade (`version`, `tags`, `ps`,
  `show`, `pull`, `delete`, `copy`, `create`, `decide`, `v1/systemone`, `v1/decisions`,
  `v1/models`); Ollama wie heute alle `/api/*`-Pfade, aber (noch) keine `/v1/*`-Pfade. Kein Path-Traversal über `..` oder `%2e%2e`.
- **Legacy-Alias**: Die bisherigen Ollama-Routen `/api/*` (z.B. `/api/tags`) bleiben als Alias für
  `/api/backends/ollama/*` erhalten, weil sie in der OpenAPI-Doku stehen und externe Skripte sie
  nutzen können. Sie werden in der OpenAPI-Spec als *deprecated* markiert; die eigene Oberfläche
  nutzt nur noch das neue Schema.
- **Reihenfolge in `handleRequest()`**: öffentliche Routen → statische Dateien →
  `MASTER_KEY`-Auth-Gate → `/api/backends` und `/api/backends/{id}/…` → Manager-eigene Routen
  (`/api/catalog/*`, `/api/litellm/*`) → Legacy-Alias zu Ollama.

### 2.3 Fähigkeiten

- **`GET /api/backends`** (hinter dem Auth-Gate) liefert pro Backend `id`, `kind`, `label`,
  `status` (`connected`/`unreachable`), `version` und die **Fähigkeiten**:
  `ollama` → `chat`, `generate`, `embed`, `create-modelfile`; `ollaya` → `decide`,
  `create-questions`. Das Frontend blendet Features anhand der Fähigkeiten ein, nicht anhand
  des Backend-Namens.

### 2.4 Datenmodell im Frontend

- `public/src/state/backends.ts`: lädt `/api/backends` einmal beim Start (und bei Reconnect),
  bietet `backendUrl(backendId, "/tags")` → `/api/backends/${backendId}/tags`.
- `public/src/state/models.ts` wird **aggregiert**: `tags` und `ps` werden für alle
  Backends **parallel** mit `Promise.allSettled` geholt. Jedes Modell bekommt ein Feld
  `backend`; der eindeutige Schlüssel ist `${backend}/${name}` (derselbe Name, z.B. `nli`, kann
  in beiden Backends existieren).
- **Teilausfälle**: Ist ein Backend nicht erreichbar, zeigen die Seiten die Modelle der anderen
  weiter an und darüber einen Hinweis-Banner ("Ollaya nicht erreichbar – letzter Fehler …").
  Kein Backend blockiert das andere; jedes hat sein eigenes Timeout.

### 2.5 Seiten im Parallelbetrieb

| Seite | Verhalten |
|---|---|
| **Dashboard** | Eine Karte pro Backend (Status, Version, Anzahl Modelle, laufende Modelle, belegter RAM/VRAM) plus eine Summenzeile. Polling beider Backends unabhängig. |
| **Models** | Eine gemeinsame Tabelle mit Spalte/Badge **Backend** und Filter-Chips *Alle / Ollama / Ollaya* (Auswahl in `localStorage`). Zusatzspalten `format` (gguf/onnx/router) und Quantisierung. Show/Delete/Copy gehen an das Backend des Modells. |
| **Running** | Gemeinsame Liste mit Backend-Badge; `device` (cpu/cuda:0/metal) und `expires_at: null` → "forever". *Unload*: Ollama wie bisher, Ollaya über `POST /api/backends/ollaya/decide {model, keep_alive: 0}`. |
| **Pull** | Eingabefeld + **Ziel-Backend-Auswahl** (Default: Ollama; Vorschlag anhand bekannter Namen aus dem Ollaya-Katalog). Mehrere Pulls können gleichzeitig laufen, jeder mit Backend-Badge im Fortschritt. |
| **Copy** | Nur innerhalb desselben Backends (Quell-Modell bestimmt das Backend). |
| **Catalog** | Zwei Quellen nebeneinander: *ollama.com* und *ollaya.dev*, als Tabs oder Quellen-Filter. Ein Klick auf "Pull" geht automatisch an das passende Backend; "installiert" wird pro Backend geprüft. |
| **Chat / Generate / Embeddings** | Modell-Dropdown zeigt nur Modelle von Backends mit Fähigkeit `chat`/`generate`/`embed` (also Ollama). |
| **Decide** (neu) | Modell-Dropdown nur mit Modellen von Backends mit Fähigkeit `decide` (Ollaya). |
| **LiteLLM** | Zwei Abschnitte: Ollama-Sync (wie bisher) und Ollaya-über-TypeSafe-Pass-through (siehe §4). |

Nav-Einträge erscheinen, sobald **mindestens ein** Backend die Fähigkeit hat; ist Ollaya nicht
konfiguriert, sieht die UI exakt aus wie heute.

### 2.6 Verworfene Alternativen

- *Globaler Umschalter Ollama/Ollaya*: einfacher, aber man sieht nie beide gleichzeitig und muss
  für einen Überblick ständig hin- und herwechseln.
- *`OLLAMA_HOST` auf Ollaya zeigen lassen*: Tags/Pull/Delete funktionieren zufällig, Chat bricht,
  `show` und Katalog passen nicht – kein echter Support.
- *Ollama unter `/api/*` lassen und nur Ollaya unter einem Präfix (`/api/ollaya/*`)*: kleinerer
  Umbau, macht Ollama aber zum Sonderfall und passt nicht zu einem Manager für mehrere Backends.
- *Modelllisten serverseitig zusammenführen* (`/api/all/tags`): spart Requests, versteckt aber
  Teilausfälle und bricht die 1:1-Kompatibilität des Proxys. Aggregation im Frontend ist
  transparenter.

## 3. Umsetzung in Phasen

### Phase 1 – Backend-Grundlage (`src/`)

1. **Config + Registry** in `src/index.ts` (oder neu `src/backends.ts`): `OLLAYA_HOST` (ohne Schema
   `http://` annehmen, ohne Port `11435`), `OLLAYA_API_KEY`, Liste `BACKENDS`.
2. **Proxy verallgemeinern**: `forwardToOllama(req)` → `forwardToBackend(req, backend, upstreamPath)`.
   Header-Stripping (`origin`, `referer`, `cookie`) bleibt für alle Backends identisch. Für Ollaya:
   - eingehendes `Authorization` löschen und, falls gesetzt, `Authorization: Bearer
     ${OLLAYA_API_KEY}` serverseitig setzen (der Key verlässt nie den Server);
   - `STREAMING_API_PATHS` wird gegen den **Upstream-Pfad** geprüft (`/api/pull`,
     `/api/create`, …), nicht gegen die Manager-Route.
3. **Routing** in `handleRequest()` nach §2.2: `/api/backends/{id}/…` parsen, Backend nachschlagen,
   Whitelist prüfen, weiterleiten. Legacy-`/api/*` ruft dieselbe Funktion mit dem Ollama-Backend
   auf, damit es nur einen Proxy-Pfad gibt.
4. **`GET /api/backends`** wie in §2.3 (Status-Probe mit 2s-Timeout, parallel).
5. **`/health`**: zusätzlich `backends: [{id, status, version}]`; die bisherigen Felder `ollama`
   und `ollamaVersion` bleiben für Kompatibilität (Docker-Healthcheck). HTTP-Status bleibt 200.
6. **Katalog**: `/api/catalog/ollaya` holt `https://ollaya.dev/search.json`, normalisiert es
   (neu in `src/library.ts`: `parseOllayaSearchIndex()`), In-Memory-Cache 1 h wie beim
   Ollama-Katalog.
7. **OpenAPI-Spec** um die neuen Routen ergänzen; Startup-Log listet alle Backends; die
   `MASTER_KEY`-Warnung erwähnt auch Ollaya.
8. **Tests** (`src/*.test.ts`): Pfad-Rewrite und Whitelist, Header-Stripping + Bearer-Injection,
   Legacy-Alias liefert dasselbe wie `/api/backends/ollama/*`, Auth-Gate greift für
   `/api/backends/*`, 404 bei unbekannter/nicht konfigurierter Id, `/api/backends` bei
   erreichbarem/unerreichbarem Backend, Parser für `search.json` (Fixture).

### Phase 2 – Frontend: parallele Verwaltung (`public/src/`)

1. `state/backends.ts` + aggregiertes `state/models.ts` (§2.4).
2. **`api.ts`**: bei Ollaya-Fehlern zusätzlich `code` und `detail[].msg` anzeigen.
3. Wiederverwendbare **Backend-Badge**-Komponente und Filter-Chips (Event-Delegation,
   keine Inline-Handler wegen CSP).
4. Seiten gemäss Tabelle §2.5 umbauen: Dashboard, Models (inkl. Detail-Modal mit `capabilities`,
   `questions`, `router.routes`, `model_info`, `license`, `parameters` für Ollaya), Running, Pull,
   Copy, Catalog, Modell-Dropdowns in Chat/Generate/Embed nach Fähigkeit filtern.
5. **Tests** für die reinen Hilfsfunktionen (Aggregation, Schlüsselbildung, Filter,
   `expires_at`-Formatierung) in `public/src/utils`.

### Phase 3 – Decide-Playground (`public/src/pages/decide.ts`)

1. Modell-Auswahl (Ollaya-Modelle), Textarea für `state` (Text oder JSON), Frage-Editor:
   Fragen mit Id, Typ (`choice`/`score`/`noul`), `instructions`, `criteria`; alternativ Roh-JSON.
2. Liefert `/api/show` eingebettete `questions`: vorbefüllen oder "Built-in questions verwenden".
3. Presets (z.B. Support-Triage wie im Ollaya-README).
4. `POST /api/backends/ollaya/decide` (per AbortController abbrechbar); optional `extras: ["laya"]`,
   `keep_alive`, Bild-Upload (Base64-PNG in `images`) für Vision-Modelle.
5. Ergebnis: pro Frage Wahrscheinlichkeitsbalken, `choice`/`score`/`noul`, `confidence`,
   `routing` (bei `laya`), `state_truncated`-Warnung, Tokens, Lade-/Rechenzeit (ns → ms).
   Hinweis "Modell wird geladen …" beim Kaltstart.
6. Validierungsfehler (`422`, `detail[].loc`) direkt an der betroffenen Frage.
7. Optional: "Als Modell speichern" → `POST /api/backends/ollaya/create` mit `from` + Fragen-Set.

### Phase 4 – LiteLLM (siehe §4)

1. LiteLLM-Seite in zwei Abschnitte teilen: *Ollama → Model-Sync* (unverändert) und
   *Ollaya → TypeSafe-Pass-through*.
2. Ollaya-Abschnitt: **Prüfung statt Sync**. Der Server ruft `GET ${LITELLM_URL}/typesafe/v1/models`
   mit `LITELLM_KEY` auf und vergleicht mit `GET ${OLLAYA_HOST}/v1/models`:
   - gleiche Modelle → "Ollaya ist über LiteLLM erreichbar" (grün);
   - andere Modelle (z.B. `jev-latest`) → "LiteLLM zeigt auf TypeSafe-Cloud, nicht auf Ollaya";
   - 404 → "LiteLLM-Version ohne TypeSafe-Pass-through (ab v1.103.0-rc)".
3. Setup-Anleitung in der UI mit den nötigen LiteLLM-Env-Variablen (vorbefüllt mit
   `OLLAYA_HOST`).
4. Neue Route `GET /api/litellm/ollaya-status`; Tests mit gemockten Upstreams.

### Phase 5 – Doku, Betrieb, CI

1. **README** + **CLAUDE.md**: neue Env-Variablen, Backend-Registry, URL-Schema
   `/api/backends/{id}/…`, Legacy-Alias, LiteLLM-Hinweise.
2. **docker-compose.yml**: optionaler `ollaya`-Service (`ghcr.io/ollaya-dev/ollaya`, bzw. `:cuda`)
   oder `OLLAYA_HOST=http://host.docker.internal:11435`. Ollaya auf dem Host bindet standardmässig
   nur `127.0.0.1` → für Docker `OLLAYA_HOST=0.0.0.0` + `OLLAYA_API_KEY` setzen.
3. **CI**: bestehende Pipeline deckt alles ab; optional ein manueller/nächtlicher Smoke-Test mit
   dem CPU-Image von Ollaya (Pull → Tags → Decide), da Modelle hunderte MB gross sind.

## 4. LiteLLM und Decision Models

**Kurz: LiteLLM unterstützt Decision Models, aber nicht als registrierte Modelle – ein "Sync" wie
bei Ollama ist deshalb weder möglich noch nötig.**

- LiteLLM hat seit **v1.103.0-rc** eine TypeSafe-Integration (für Jev, das Cloud-Decision-Model,
  dessen API Ollaya nachbildet). Das ist ein reiner **Pass-through**: Alles unter
  `/typesafe/*` wird an `TYPESAFE_API_BASE` (Default `https://api.typesafe.ai`) weitergeleitet,
  z.B. `POST /typesafe/v1/systemone`, `GET /typesafe/v1/models`. LiteLLM setzt dabei
  `TYPESAFE_API_KEY` ein; Clients brauchen nur einen LiteLLM-Virtual-Key. Logging und
  Kostenerfassung laufen über `usage.input_tokens` aus der Antwort.
- Es gibt **keine** `model_list`-Einträge und kein `/model/new` dafür – LiteLLM leitet einfach
  jede Modellbezeichnung durch.
- Ollayas `/v1/systemone`, `/v1/decisions` und `/v1/models` sind laut Ollaya-Doku
  **wire-identisch** mit TypeSafe. Damit genügt auf der LiteLLM-Seite:

  ```sh
  TYPESAFE_API_BASE=http://<ollaya-host>:11435
  TYPESAFE_API_KEY=<OLLAYA_API_KEY>   # beliebiger Wert, falls Ollaya ohne Key läuft
  ```

  Danach sind alle lokal installierten Ollaya-Modelle automatisch über
  `LITELLM/typesafe/v1/systemone` nutzbar, ohne dass der Manager etwas registrieren muss. Neu
  gepullte Modelle sind sofort verfügbar.

Einschränkungen, die wir in der UI erklären sollten:

- **Nur ein Ziel**: `TYPESAFE_API_BASE` ist eine einzige Env-Variable – LiteLLM zeigt entweder
  auf die TypeSafe-Cloud oder auf Ollaya, nicht auf beide.
- **Nicht per API konfigurierbar**: Der Manager kann die Env-Variable von LiteLLM nicht setzen,
  nur prüfen und anleiten.
- **Kosten**: LiteLLMs Preistabelle kennt nur `typesafe/jev-*`; lokale Ollaya-Modelle werden
  vermutlich mit 0 $ oder ohne Preis geloggt. Das ist für lokale Modelle korrekt, sollte aber
  getestet werden.
- **Kein OpenAI-Format**: Decision Models sind über `/chat/completions` nicht erreichbar – Clients
  müssen den TypeSafe-SDK oder `/typesafe/v1/systemone` direkt nutzen.
- **Nicht verifiziert**: Das Zusammenspiel LiteLLM ↔ Ollaya ist aus beiden Dokus abgeleitet, aber
  noch nicht praktisch getestet. Erster Schritt von Phase 4 ist ein manueller Test.

## 5. Risiken und offene Fragen

- **API-Stabilität**: Ollaya ist jung; die Doku ist aber ein versionierter "normative contract"
  (§12). Wir verlassen uns nur auf dokumentierte Felder und behandeln unbekannte defensiv.
- **`search.json`** ist als Typeahead der Website gedacht, nicht als offizielle API. Parser
  tolerant bauen, bei Fehler leere Liste + Hinweis statt Absturz.
- **Sicherheit**: `/api/backends/*` erlaubt Pull/Delete/Create – gleiche Risiken wie der
  Ollama-Proxy, gleicher Schutz durch `MASTER_KEY`.
- **Last durch Parallel-Polling**: Das Dashboard fragt jetzt zwei Backends ab. Unkritisch
  (`/api/tags`/`/api/ps` sind billig), aber Polling-Intervall pro Backend beibehalten und bei
  unerreichbarem Backend mit Backoff abfragen.
- **Namenskollisionen**: gleicher Modellname in beiden Backends → immer über
  `${backend}/${name}` adressieren, in der UI per Badge unterscheiden.
- **Offen**: Sollen später mehrere Instanzen pro Typ unterstützt werden (z.B.
  `OLLAMA_HOSTS=gpu1=…,gpu2=…`)? Die Registry ist darauf vorbereitet, umgesetzt wird zunächst
  je eine Instanz.

## 6. Aufwandsschätzung

| Phase | Umfang | Grobe Schätzung |
|---|---|---|
| 1 Backend | Registry, Proxy-Refactor, Routing, `/api/backends`, Health, Katalog, Tests | 1,5 Tage |
| 2 Parallele Verwaltung | aggregierter State, Badges/Filter, alle Verwaltungsseiten | 2–2,5 Tage |
| 3 Decide-Playground | Frage-Editor, Ergebnis-Ansicht (+ Create optional) | 2 Tage |
| 4 LiteLLM | Status-Prüfung + Anleitung, manueller Integrationstest | 0,5–1 Tag |
| 5 Doku/Betrieb | README, CLAUDE.md, Compose | 0,5 Tage |

Phase 1 + 2 liefern bereits vollwertiges paralleles Modell-Management; Phase 3 und 4 können
separat gemergt werden.

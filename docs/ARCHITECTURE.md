# Architecture

TestDesk is a single Node.js process: an Express app serving a JSON API and a static, build-free web UI, backed by SQLite and a folder of evidence files. There is no separate database server, queue or cache.

## 1. System context

```mermaid
flowchart LR
  subgraph Users
    QA[Tester / QA]
    ADM[Admin]
    CLI[Client / UAT approver]
  end
  CI[CI pipeline<br/>Maven, Gradle, pytest,<br/>Playwright, Jest...]

  subgraph Host["Server / VM / container"]
    RP[Reverse proxy<br/>Nginx / Caddy - TLS]
    APP[TestDesk<br/>Node.js 22 + Express]
    DATA[(DATA_DIR<br/>testmgmt.db + uploads/)]
  end

  CLAUDE[Anthropic API<br/>Claude]
  LOCAL[Self-hosted LLM<br/>Ollama / vLLM / LM Studio]
  JIRA[Jira Cloud / Server]

  QA & ADM & CLI -- HTTPS, session cookie --> RP
  CI -- HTTPS, Bearer tdk_... --> RP
  RP -- HTTP :3000 --> APP
  APP --> DATA
  APP -- HTTPS, optional --> CLAUDE
  APP -- HTTP, optional --> LOCAL
  APP -- HTTPS REST, read-only, optional --> JIRA
```

## 2. Internal components

```mermaid
flowchart TB
  subgraph Browser["Browser - public/ (plain HTML/CSS/JS, no build)"]
    UI[app.js, ui.js, api.js]
    V[views: spec, plans, generator,<br/>tokens, settings, misc]
  end

  subgraph Server["src/ - Express"]
    SRV[server.js<br/>static files, security headers,<br/>error handler]
    AUTH[auth.js<br/>sessions, passwords, roles,<br/>Bearer API tokens]
    ROUTES[routes.js<br/>REST API /api]
    SVC[services.js<br/>suites, cases, plans,<br/>copy / move]
    IMP[importExport.js<br/>Excel / CSV via exceljs]
    REP[reports/<br/>SIT, UAT, BAST<br/>HTML + PDF, ID / EN]
    AUTO[automation/<br/>spec sync, results,<br/>JUnit XML parser]
    AIR[aiRoutes.js + ai/<br/>generator, providers,<br/>extract, jira]
    SET[settings.js<br/>DB values + env fallback]
    DB[db.js<br/>node:sqlite, WAL]
  end

  FS[(uploads/<br/>evidence files)]
  SQL[(testmgmt.db)]

  UI --> V
  V -- fetch /api --> SRV
  SRV --> ROUTES
  ROUTES --> AUTH
  ROUTES --> SVC & IMP & REP & AUTO & AIR
  AUTO --> AUTH
  AIR --> SET
  SVC & IMP & REP & AUTO & AIR & SET & AUTH --> DB
  DB --> SQL
  ROUTES -- multer --> FS
  REP -- reads evidence --> FS
```

## 3. Data model

```mermaid
erDiagram
  projects ||--o{ suites : has
  suites ||--o{ suites : "nested"
  suites ||--o{ test_cases : contains
  test_cases ||--o{ test_steps : has
  projects ||--o{ test_plans : has
  test_plans ||--o{ plan_cases : includes
  test_cases ||--o{ plan_cases : "scheduled as"
  plan_cases ||--o{ executions : "run as"
  executions ||--o{ execution_steps : "step results"
  executions ||--o{ attachments : evidence
  test_plans ||--o{ signoffs : "vendor / client"
  users ||--o{ sessions : has
  users ||--o{ api_tokens : owns
  projects ||--o{ ai_generations : logs
  settings }o--|| projects : "global (AI, Jira)"
```

## 4. Key flows

### SIT / UAT execution, approval and BAST

```mermaid
sequenceDiagram
  actor T as Tester
  actor C as Client
  participant A as TestDesk API
  participant D as SQLite + uploads/
  T->>A: Create plan (SIT/UAT), add cases
  T->>A: POST /plan-cases/:id/executions (result + evidence)
  A->>D: execution, steps (snapshot), attachment files
  C->>A: POST /executions/:id/approval (approve / reject)
  T->>A: POST /plans/:id/signoffs (vendor)
  C->>A: POST /plans/:id/signoffs (client)
  T->>A: GET /plans/:id/report?type=bast&format=pdf
  A->>D: read results, evidence, signatures
  A-->>T: PDF / HTML report
```

### CI automation

```mermaid
sequenceDiagram
  participant CI as CI job
  participant A as TestDesk API
  participant D as SQLite
  CI->>A: PUT /api/projects/:prefix/automation/cases (Bearer tdk_...)
  A->>D: upsert suites / cases from test code
  CI->>A: POST .../automation/results or /junit (JSON or JUnit XML)
  A->>D: executions with build number + CI link
  CI->>A: POST /api/plans/:id/automation/evidence
```

### AI test case generation

```mermaid
sequenceDiagram
  actor Q as QA
  participant A as TestDesk API
  participant X as extract.js
  participant J as Jira
  participant L as Claude or OpenAI-compatible LLM
  Q->>A: POST /projects/:id/ai/generate (text, files, Jira keys)
  A->>X: PDF / DOCX / XLSX / text to prompt text
  A->>J: GET issues (read-only)
  A->>L: prompt + JSON schema
  L-->>A: draft cases + open questions
  A-->>Q: editable drafts (nothing saved yet)
  Q->>A: POST /projects/:id/ai/create (selected drafts)
  A->>A: create cases, log in ai_generations
```

## 5. Design notes

| Topic | Decision |
|-------|----------|
| Storage | SQLite file (`node:sqlite`, WAL mode) + `uploads/` folder, both under `DATA_DIR` |
| Scaling | Single process, single writer. Scale **up**, not out. Do not run multiple instances against one `DATA_DIR` |
| Auth | HttpOnly `SameSite=Lax` session cookie for browsers; `Authorization: Bearer tdk_...` tokens for CI |
| Roles | Admin, Tester, Client (see README) |
| Secrets | AI/Jira keys can live in the DB (Settings) or in environment variables |
| Frontend | Static files served by Express; no build step |

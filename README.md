# TestDesk — Test Case Management, SIT/UAT Execution & BAST

A self-hosted, open-source web tool for software houses and IT vendors that deliver to banks, multifinance and corporates. It replaces the usual Excel + Word + WhatsApp-screenshot workflow with:

- **Test specification** (TestLink-style): test suites (folders) that can be nested, renamed, moved and copied; test cases with standard fields and steps; copy/move cases between suites.
- **Import / export** of test cases from Excel (`.xlsx`) or CSV, with English and Bahasa Indonesia column names.
- **Test plans** per environment (**SIT** or **UAT**) with a timeline, build/version, and assignees.
- **Execution** with step-by-step results, actual result, defect reference and **evidence attachments** (drag-and-drop, file picker, or paste a screenshot with Ctrl+V).
- **Client approval**: the client approves or rejects each UAT result (or approves all passed results at once) and signs off the plan.
- **Reports**: SIT Report, UAT Report and **BAST (Berita Acara Serah Terima)** in **Bahasa Indonesia or English**, as **PDF or HTML**, including evidence screenshots and signatures.
- **AI Test Case Generator**: paste a user story or BRD/FSD/TSD text, attach requirement documents, or link Jira issues; the AI drafts test cases that QA reviews, edits and creates directly in Test Specification (or downloads in the Excel import layout). Works with Claude or with a self-hosted open-source model.

Tech stack: Node.js + Express, SQLite (built into Node, no database server), plain HTML/CSS/JavaScript (no build step). Dependencies: `express`, `multer`, `exceljs`, `pdfkit`, and for the AI generator `@anthropic-ai/sdk`, `mammoth` (Word) and `unpdf` (PDF).

## Requirements

- Node.js **22.13 or newer** (uses the built-in `node:sqlite` module)

## Getting started

```bash
npm install
npm run seed     # optional: loads a demo project, demo users and sample results
npm start
```

Open http://localhost:3000 and log in.

| User | Password | Role |
|------|----------|------|
| `admin` | `admin123` (or the value of `ADMIN_PASSWORD` on first start) | Admin |
| `tester` | `demo123` (only after `npm run seed`) | Tester / QA |
| `client` | `demo123` (only after `npm run seed`) | Client / UAT approver |

**Change the admin password after the first login** (user menu → Change password), and delete the demo users and project before going live.

For development, `npm run dev` restarts the server when files change.

## Configuration (environment variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Listen address. Use `0.0.0.0` to allow other machines on the network |
| `DATA_DIR` | `./data` | SQLite database (`testmgmt.db`) and uploaded evidence (`uploads/`) |
| `ADMIN_PASSWORD` | `admin123` | Password of the `admin` user created on first start |
| `MAX_UPLOAD_MB` | `25` | Maximum size per evidence file |
| `REPORT_TIMEZONE` | `Asia/Jakarta` | Time zone used for dates in reports |
| `PDF_FONT_REGULAR` / `PDF_FONT_BOLD` | Arial / DejaVu Sans if found | TTF fonts used in PDF reports |
| `ANTHROPIC_API_KEY` | – | Claude API key for the AI generator (alternative to entering it in Settings) |
| `AI_PROVIDER` / `AI_MODEL` / `AI_BASE_URL` / `AI_API_KEY` | `anthropic` / `claude-sonnet-5-5` | AI generator defaults when Settings is left blank (`openai` = any OpenAI-compatible server) |
| `AI_EFFORT` / `AI_MAX_INPUT_CHARS` | `high` / `400000` | Claude effort level; largest requirement text accepted per generation |
| `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` | – | Jira connection (alternative to Settings) |

Values entered under **Settings** win over environment variables. API keys entered there are stored in the database; use the environment variables if you prefer to keep secrets out of it.

**Backup:** copy the whole `DATA_DIR` folder (database + evidence files) while the server is stopped.

## Roles

| | Admin | Tester | Client |
|---|:-:|:-:|:-:|
| Manage projects and users | ✔ | | |
| Create/edit suites, test cases, plans; import; AI generator | ✔ | ✔ | |
| AI and Jira settings | ✔ | | |
| Execute tests, upload evidence | ✔ | ✔ | |
| Approve / reject results | ✔ | | ✔ |
| Sign off as vendor | ✔ | ✔ | |
| Sign off as client | ✔ | | ✔ |
| View everything and generate reports | ✔ | ✔ | ✔ |

## Test case fields

Following common practice (IEEE 829 / ISTQB / TestLink):

| Field | Notes |
|-------|-------|
| Test Case ID | Auto-generated from the project prefix (`CBS-1`, `CBS-2`, …), or kept from your import file |
| Title | Required |
| Objective / Description | |
| Preconditions / Postconditions | |
| Priority | Critical, High, Medium, Low |
| Test Type | Functional, Negative, Regression, Integration, Performance, Security, Usability |
| Execution Type | Manual, Automated |
| Status | Draft, Ready, Obsolete (obsolete cases are not added to new plans) |
| Requirement ID | Traceability to BRD / FSD / user story |
| Tags, Estimated minutes | |
| Steps | Step No, Test Step (action), Test Data, Expected Result |

Each saved change increases the test case **version**. Execution results keep a snapshot of the steps they were run against, so reports stay accurate after a test case changes.

## Importing from Excel / CSV

Download the template from **Import / Export**. The layout is **one row per test step**:

| Test Suite | Test Case ID | Test Case Title | … | Step No | Test Step | Test Data | Expected Result |
|---|---|---|---|---|---|---|---|
| Payments / Transfer | | Transfer between own accounts | … | 1 | Open Transfer menu | | Transfer form is displayed |
| | | | | 2 | Fill destination and amount | Rp50.000 | Confirmation page is displayed |

- A row with a new Test Case ID or Title starts a new test case; rows with those cells blank add steps to it.
- If all steps are in one cell, numbered (`1. …` `2. …`), they are split into separate steps.
- `Test Suite` accepts a path (`Payments / Transfer`); missing suites are created.
- An existing Test Case ID in the project **updates** that case, so you can export, edit in Excel and re-import.
- Common header names are recognised, including Bahasa Indonesia (`Modul`, `Judul`, `Skenario`, `Prasyarat`, `Langkah Pengujian`, `Data Uji`, `Hasil yang Diharapkan`, `Prioritas`), and priority values such as `Tinggi`/`Sedang`/`Rendah`.
- CSV files may use comma, semicolon or tab as the separator.

## AI Test Case Generator

Open it from **Test Specification** (**✦ AI** above the tree, or **✦ Generate with AI** on a suite) or from **Import / Export**.

1. **Requirements** – any mix of:
   - pasted text (user stories, acceptance criteria, BRD/FSD/TSD sections);
   - attached documents: `.pdf`, `.docx`, `.xlsx`, `.txt`, `.md`, `.csv`, `.json`, `.feature` (up to 10 files, 30 MB each);
   - Jira issues by key or URL (`PAY-142`, `https://company.atlassian.net/browse/PAY-142`). Summary, description, acceptance-criteria custom fields, sub-tasks and linked issues are read. **Check** previews them first.
2. **Options** – target suite (existing, or a new one), language (English / Bahasa Indonesia), roughly how many cases, coverage (positive, negative, boundary, security, end-to-end), whether to group into sub-suites by feature, and free-text instructions. When the target suite already has test cases, their titles are sent so the AI fills gaps instead of repeating them.
3. **Review** – the drafts appear as an editable list: title, priority, type, suite, requirement ID, tags, objective, preconditions and steps. Untick or remove drafts you don't want. The AI also lists **open questions**: gaps or contradictions in the requirements to raise with the business analyst.
4. **Create** – selected drafts become real test cases (status *Draft* by default, tagged `ai-generated`, Jira key in *Requirement ID*). Or **Download Excel / CSV** in the import layout, finish them in Excel, and import them on the Import / Export page.

Nothing is saved until you click **Create**. Drafts survive navigating away within the same browser tab. Every generation is logged (who, model, sources, token usage) under **Recent generations**.

### Choosing the AI (admin → Settings)

| Provider | When to use it | Setup |
|---|---|---|
| **Claude** (Anthropic API, default model `claude-sonnet-5-5`) | Best quality; reads PDFs directly, including tables and scanned pages | API key from console.anthropic.com. Billed per token by Anthropic. |
| **Open-source model** via any OpenAI-compatible server: Ollama, LM Studio, vLLM, llama.cpp, LocalAI | Requirements must stay on your own network, or no API budget | e.g. install [Ollama](https://ollama.com), run `ollama pull qwen2.5:14b`, then set Server URL `http://localhost:11434/v1` and model `qwen2.5:14b` |

With an open-source model, larger models (14B+ parameters) give noticeably better test cases. Scanned PDFs without a text layer need Claude, or paste the text instead.

On Claude Sonnet 5.5 / Opus 5.5, requests use Anthropic's server-side refusal fallback (`fallbacks: "default"`), so a rare safety decline is retried on another Claude model instead of failing.

### Jira (admin → Settings)

- **Jira Cloud:** URL `https://yourcompany.atlassian.net`, the account email, and an API token from id.atlassian.com → Security → API tokens.
- **Jira Server / Data Center:** URL, leave email blank, and a personal access token.

Access is read-only. Use an account that can see the projects testers will reference. When Jira is configured, Jira keys in a test case's Requirement ID link to the issue.

## Typical workflow

1. **Projects** (⚙ next to the project selector): create a project with client and vendor names and an ID prefix.
2. **Test Specification**: create suites and test cases, import them from Excel, or generate them with AI from requirements and Jira issues.
3. **Test Plans**: create a SIT plan (or open a suite and click **▶ Run suite**), set the build and dates, and assign testers.
4. **Execute**: record results per step, attach screenshots and logs, and log defect references. Use **Save & next** to move through the plan.
5. Repeat with a **UAT** plan. The client logs in, reviews each result with its evidence, and approves or rejects it.
6. **Sign-off** tab: the vendor and the client sign the plan.
7. **Reports**: generate the SIT Report, UAT Report or BAST in Bahasa Indonesia or English, as PDF or HTML.

## API

All screens use a JSON API under `/api` (cookie session). Main endpoints:

```
POST /api/auth/login                       GET  /api/projects/:id/tree
POST /api/suites  PUT/DELETE /api/suites/:id   POST /api/suites/:id/move | /copy
POST /api/cases   PUT/DELETE /api/cases/:id    POST /api/cases/bulk {action: copy|move|delete}
POST /api/projects/:id/import (multipart)  GET  /api/projects/:id/export?format=xlsx|csv
POST /api/plans   GET/PUT/DELETE /api/plans/:id POST /api/plans/:id/cases
POST /api/plan-cases/:id/executions (multipart: data + evidence[])
POST /api/executions/:id/approval          POST /api/plans/:id/signoffs
GET  /api/plans/:id/report?type=sit|uat|bast&lang=id|en&format=pdf|html
POST /api/projects/:id/ai/generate (multipart: data + documents[])   POST /api/projects/:id/ai/create
POST /api/projects/:id/ai/export {cases, format}   GET /api/jira/issues?keys=PAY-1,PAY-2
GET/PUT /api/settings   POST /api/settings/test-ai | /test-jira   GET /api/ai/status
```

## Project layout

```
src/
  server.js          Express app
  db.js              SQLite schema and helpers
  auth.js            Sessions, passwords, roles
  routes.js          REST API
  services.js        Suites, cases, plans, copy/move logic
  importExport.js    Excel/CSV import and export
  seed.js            Demo data
  settings.js        Admin settings (AI, Jira) with environment-variable fallbacks
  aiRoutes.js        AI generator, settings and Jira API
  ai/                Generator prompt and schema, Claude / OpenAI-compatible clients,
                     document text extraction, Jira client
  reports/           SIT/UAT/BAST builder, HTML and PDF renderers, ID/EN strings
public/              Single-page web UI (no build step)
```

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Bungas Trisasongko.

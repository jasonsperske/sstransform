# sstransform

Two Claude-powered workflows over `.xlsx` spreadsheets, run locally in the browser:

- **Transform** — map a source workbook into a destination workbook's column shape. Claude proposes a JavaScript transformation per target column; you refine, preview, and export.
- **Merge** — combine two workbooks (left + right) into one. Claude proposes both the row-matching logic and per-column merge logic; you refine, preview, and export.

Projects are saved to the browser's IndexedDB (`sstransform` database) so transformations and merge rules can be reused against new source files with matching columns. Existing `localStorage` projects are migrated on first load. Each project carries sync metadata (`updatedAt`, `serverUpdatedAt`, `dirty`, `deleted`) so a future account-connected mode can push/pull projects between devices.

## Requirements

- Node.js 25+ (pinned via `.nvmrc` — run `nvm use` in the repo root)
- An Anthropic API key

## Setup

```bash
git clone <this-repo> sstransform
cd sstransform
npm install
cp .env.example .env
```

Edit `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
PORT=3000
```

Optional — enable federated login (Google / Microsoft). See
[Authentication](#authentication) below.

## Run

```bash
npm start       # production-style run
npm run dev     # auto-reload via nodemon (watches server.js and views/)
```

Open http://localhost:3000.

## Database

User identity and sessions live in SQLite at `data/sstransform.sqlite`
(created on first boot — the `data/` directory is gitignored). Schema
changes ship as ordered files under `migrations/`; `lib/db.js` runs any
pending migration at server startup, so `npm start` on a fresh checkout
just works.

The same runner is exposed as an npm script:

```bash
npm run db:build              # apply pending migrations
npm run db:build -- --status  # show applied vs pending
```

Applied migrations are recorded in the `_migrations` table, so re-runs
are no-ops.

## Authentication

Auth is entirely opt-in. If no provider is configured, the header shows
no sign-in controls and every visitor is served an anonymous session —
the app behaves exactly as before. To enable login:

1. Register an OAuth 2.0 / OpenID Connect client with each provider you
   want:
   - **Google** — Google Cloud Console → _Credentials_ → _OAuth 2.0
     Client ID_. Authorized redirect URI: `<base>/auth/google/callback`.
   - **Microsoft** — Microsoft Entra → _App registrations_ → _New
     registration_. Redirect URI: `<base>/auth/microsoft/callback`.
     `MICROSOFT_TENANT` (default `common`) controls which account types
     can sign in.
2. Put the resulting `CLIENT_ID`/`CLIENT_SECRET` values into `.env`
   (template in `.env.example`). A provider's Sign in button only
   renders when both values are set for it, so you can enable Google
   only, Microsoft only, or both.
3. Restart the server. The Sign in controls appear in the header.

### Session model

- Every visitor — logged in or not — gets a row in the `sessions` table
  and an HMAC-signed `sst.sid` cookie. Anonymous sessions have
  `userId = NULL`.
- On successful login, the existing session's `userId` is updated in
  place. The cookie is unchanged, so anything attached to the session
  (current and future) follows the user into their account without a
  migration step.
- Logout deletes the session row and clears the cookie.

### Token storage

The federated identity (provider subject, email, name, picture) is
stored in the `users` table. OAuth access/refresh tokens are **never
stored in plaintext** — only their SHA-256 hashes land in
`oauth_tokens`, along with the `expiresAt` stamp. Identity extraction
happens from the `id_token` claims returned over TLS from the
provider's token endpoint; we don't re-call the provider after login.

### Environment variables

| Var | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OIDC client |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Microsoft OIDC client |
| `MICROSOFT_TENANT` | `common` (default), `organizations`, `consumers`, or a tenant id |
| `OAUTH_REDIRECT_BASE` | Public base URL for callbacks; derived from request when unset |
| `SESSION_SECRET` | HMAC secret for session cookie; auto-generated to `data/.session-secret` when unset |
| `DATABASE_PATH` | SQLite file path; defaults to `data/sstransform.sqlite` |

## Projects

The home page (`/`) lists every saved project with its type badge, column counts, and last-saved time. Click **New project ▾** to create a `Transform` or `Merge` project; each gets a random id and is navigable at `/transform/<id>` or `/merge/<id>`. Project state (name, headers, transformations or match/column rules) is persisted to IndexedDB as you work. Deleting a project is a one-click action from the list — when an account is connected, deletes are tombstoned so they propagate to other devices before being hard-removed.

### Storage layout

Persistence lives in the `sstransform` IndexedDB database (see `public/db.js`):

- `projects` — one record per project, keyed by `id`. Indexes: `by_updatedAt`, `by_dirty`, `by_deleted`, `by_type`.
- `meta` — key/value records. `meta:schema` is a self-describing snapshot of the current store/index/keyPath layout (so a rebuild or external introspection tool can read the schema without parsing source). `meta:migrations` is an append-only log of every schema migration that has been applied to this client. Bump `CURRENT_SCHEMA.version` and push an entry into `MIGRATIONS` to evolve the schema; both the schema descriptor and the migration log will be updated on the next open.

### Sync (scaffolded)

`public/sync.js` exposes `Sync.syncAll()` and `Sync.syncOne(id)`. They're invoked on the `/` route and on `/transform/:id` / `/merge/:id` deep-link loads respectively, but `Sync.isEnabled()` returns false until accounts are wired up — every call is a no-op today. Once an account module flips `Sync.configure({ enabled: true, ... })` and provides endpoint URLs + auth fetch options, the existing call sites will start exchanging projects with the server (last-writer-wins on `updatedAt` vs `serverUpdatedAt`, with tombstone propagation).

## Transform projects (`/transform/<id>`)

1. **Source** — pick a `.xlsx` and a sheet. Choose how many sample rows to send to Claude as context.
2. **Destination** — pick a `.xlsx` whose header row defines the target schema. Data rows in this file are ignored. When a saved project already has target headers the section is locked and greyed out; click **Edit destination** to replace it.
3. **Transformations** — click **Propose transformations**. Claude returns one `{targetColumn, code, notes}` per destination column. You can:
   - Edit any snippet inline (auto-saved).
   - Use the per-column **Refine** box to adjust one column at a time.
   - Use the bottom **Refine all** box to apply feedback across every column (e.g. "phone numbers in E.164 format").
   - See a live sample preview against the source rows, with cell errors highlighted.
   - If the project name is empty, Claude also returns a suggested name based on the source data.
4. **Output** — click **Transform** to apply the snippets across all source rows, then **Download xlsx** to save the result.

## Merge projects (`/merge/<id>`)

1. **Left** — pick the first `.xlsx`.
2. **Right** — pick the second `.xlsx`. Headers may differ between the two files; rows may only exist on one side.
3. **Match & Merge** — choose which side wins conflicts (`priority: left | right`) and click **Propose merge**. Claude returns:
   - A **matchCode** function body — `(leftRow, rightRow) => truthy if the rows represent the same entity`.
   - A **matchColumns** summary — a chip list showing the column pairs it compares and the strategy for each (`exact`, `lowercase/trim`, `levenshtein <= 2`, …).
   - A set of output columns, each with its own `(left, right, priority) => value` function body.
   - A suggested project name when the name is empty.
4. **Joining logic** — refine how rows are matched independently of the column mappings. Each output column also has its own refine input, so you can fix one column without disturbing the rest. A collapsed **Show match code** panel exposes the raw matchCode for direct editing.
5. **Preview** — the first `sample rows` of each side are merged live, so you can see the combined sheet before committing.
6. **Output** — click **Merge all rows** to apply the rules to every row, then **Download xlsx**.

### The `levenshteinDistance` helper

The merge runtime exposes a global `levenshteinDistance(a, b)` function (null-safe, coerces non-strings via `String()`), and Claude is told about it in the prompt. It uses this for fuzzy text matching when the sample data shows inconsistent casing, punctuation, or typos — e.g.:

```js
const norm = (x) => String(x || '').toLowerCase().trim().replace(/\s+/g, ' ');
const ln = norm(leftRow['Company']);
const rn = norm(rightRow['Company']);
return ln && rn && levenshteinDistance(ln, rn) <= 2;
```

## How it works

- **Frontend** (`public/`, `views/`) — EJS layouts share the shell; SheetJS parses/writes `.xlsx` entirely in the browser, so spreadsheet data never leaves the machine except for the sample rows + headers sent to Claude. Generated code snippets are executed via `new Function(...)`.
- **Backend** (`server.js`) — Express app that renders the two project views and exposes two Claude-backed endpoints:
  - `POST /api/transform` — returns `{ transformations[], suggestedName }` constrained by a JSON schema.
  - `POST /api/merge` — returns `{ matchCode, matchNotes, matchColumns[], columns[], suggestedName }` constrained by a JSON schema. Supports scoped refinements via `refineColumn` or `refineMatch` so the UI can refine one piece without re-rolling the whole proposal.
- Model: `claude-opus-4-7` with adaptive thinking enabled.

## Security note

Generated snippets (transform bodies, matchCode, merge column code) execute in the browser via `new Function`. Only run this tool against spreadsheets and API responses you trust.

## License

MIT — see [LICENSE](LICENSE).

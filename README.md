# sstransform

Two Claude-powered workflows over `.xlsx` spreadsheets, run locally in the browser:

- **Transform** — map a source workbook into a destination workbook's column shape. Claude proposes a JavaScript transformation per target column; you refine, preview, and export.
- **Merge** — combine two workbooks (left + right) into one. Claude proposes both the row-matching logic and per-column merge logic; you refine, preview, and export.

Projects are saved to browser `localStorage` so transformations and merge rules can be reused against new source files with matching columns.

## Requirements

- Node.js 18+
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

## Run

```bash
npm start       # production-style run
npm run dev     # auto-reload via nodemon (watches server.js and views/)
```

Open http://localhost:3000.

## Projects

The home page (`/`) lists every saved project with its type badge, column counts, and last-saved time. Click **New project ▾** to create a `Transform` or `Merge` project; each gets a random id and is navigable at `/transform/<id>` or `/merge/<id>`. Project state (name, headers, transformations or match/column rules) is persisted to `localStorage` as you work. Deleting a project is a one-click action from the list.

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

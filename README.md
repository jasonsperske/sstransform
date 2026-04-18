# sstransform

Map one spreadsheet's columns into another's shape. Upload a source `.xlsx` and a destination `.xlsx` (whose headers define the target schema), and Claude proposes a JavaScript transformation for each target column. Refine, preview, and export a new workbook.

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

Edit `.env` and set your API key:

```
ANTHROPIC_API_KEY=sk-ant-...
PORT=3000
```

## Run

```bash
npm start
```

Open http://localhost:3000.

## Usage

1. **Source** — pick a `.xlsx`; choose a sheet if the file has multiple. Adjust the sample row count (sent to Claude as context).
2. **Destination** — pick a `.xlsx` whose header row defines the target columns. Data in this file is ignored; only the headers matter.
3. **Transformations** — click **Propose transformations**. Claude returns a JS function body per target column that takes a `row` object keyed by source headers. You can:
   - Edit any generated snippet inline.
   - Use the overall feedback box to refine all columns at once (e.g. "phone numbers in E.164 format").
   - See a live sample preview against the source rows.
4. **Output** — click **Transform** to apply the snippets across all source rows, then **Download xlsx** to save the result.

## How it works

- The frontend (`public/`) parses xlsx in the browser via SheetJS — your spreadsheet data never leaves the machine except for the sample rows + headers sent to Claude.
- The backend (`server.js`) exposes `POST /api/transform`, which calls the Anthropic API (`claude-opus-4-7`) with a JSON-schema-constrained response asking for one `{ targetColumn, code, notes }` entry per destination column.
- The returned `code` is a JS function body; the browser wraps each in `new Function('row', code)` and runs it over every source row to produce the output workbook.

## Security note

Generated snippets are executed in the browser via `new Function`. Only run this tool against spreadsheets and API responses you trust.

## License

MIT — see [LICENSE](LICENSE).

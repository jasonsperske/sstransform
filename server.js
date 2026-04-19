import express from 'express';
import expressLayouts from 'express-ejs-layouts';
import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

app.set('view engine', 'ejs');
app.set('views', 'views');
app.use(expressLayouts);
app.set('layout', 'layout');

const homeScripts = ['/db.js', '/projects.js', '/sync.js', '/home.js'];
const transformScripts = [
  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
  '/db.js',
  '/projects.js',
  '/sync.js',
  '/app.js',
];
const mergeScripts = [
  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
  '/db.js',
  '/projects.js',
  '/sync.js',
  '/tools.js',
  '/merge.js',
];

app.get('/', (req, res) => {
  res.render('index', {
    title: 'sstransform',
    subtitle: "map one spreadsheet's columns into another's shape",
    bodyScripts: homeScripts,
  });
});

app.get('/transform/:id?', (req, res) => {
  res.render('transform', {
    title: 'sstransform — transform',
    subtitle: "map one spreadsheet's columns into another's shape",
    projectId: req.params.id || null,
    bodyScripts: transformScripts,
  });
});

app.get('/merge/:id?', (req, res) => {
  res.render('merge', {
    title: 'sstransform — merge',
    subtitle: 'merge two spreadsheets into one',
    projectId: req.params.id || null,
    bodyScripts: mergeScripts,
  });
});

const client = new Anthropic();

const transformationsSchema = {
  type: 'object',
  properties: {
    transformations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          targetColumn: { type: 'string' },
          code: {
            type: 'string',
            description: 'JavaScript function body. Receives `row` (object keyed by source column names). Must contain a return statement. Empty string if no reasonable mapping exists.'
          },
          notes: {
            type: 'string',
            description: 'Short explanation of the mapping, or why no mapping was possible.'
          }
        },
        required: ['targetColumn', 'code', 'notes'],
        additionalProperties: false
      }
    },
    suggestedName: {
      type: 'string',
      description: 'Short descriptive project name when requested via suggestName; empty string otherwise.'
    }
  },
  required: ['transformations', 'suggestedName'],
  additionalProperties: false
};

function buildPrompt({ sourceHeaders, targetHeaders, sourceSample, existingTransformations, refinementComment, targetColumn, suggestName }) {
  let msg = `You are mapping data from a source spreadsheet to a destination spreadsheet format.

Source columns: ${JSON.stringify(sourceHeaders)}
Target columns: ${JSON.stringify(targetHeaders)}

Sample source rows:
${JSON.stringify(sourceSample, null, 2)}
`;

  if (existingTransformations && existingTransformations.length) {
    msg += `\nCurrent transformations:\n${JSON.stringify(existingTransformations, null, 2)}\n`;
  }

  if (refinementComment) {
    msg += `\nUser feedback: ${refinementComment}\n`;
    if (targetColumn) {
      msg += `Focus the refinement on the target column "${targetColumn}" (leave others unchanged).\n`;
    }
  }

  msg += `
For each target column, produce a JavaScript function body that transforms a source row into the target value.

Rules:
- The body receives a single argument \`row\` — an object whose keys are the source column names exactly as listed above.
- Use bracket notation \`row['Column Name']\` (source column names may contain spaces or punctuation).
- The body MUST end with a return statement.
- Do NOT include the function declaration wrapper — body only.
- Keep code concise, defensive (tolerate undefined/null), and pure (no I/O, no globals beyond standard JS).
- If no reasonable mapping exists for a target column, set code to an empty string and explain in notes.
- You may combine multiple source columns, parse dates, split/join strings, convert units, etc.

Example entry:
{
  "targetColumn": "Full Name",
  "code": "return [(row['FirstName']||''),(row['LastName']||'')].filter(Boolean).join(' ');",
  "notes": "Joins FirstName and LastName with a space, dropping empties."
}

${existingTransformations && existingTransformations.length ? 'Return the full updated transformation set (one entry per target column).' : 'Return one entry for every target column listed above.'}

${suggestName
  ? 'Also propose a short project name (3–6 words) for `suggestedName`. This is a data-transformation project; describe what is being transformed based on the source columns and sample values (e.g. "Customer contacts transform", "Invoice line items transform", "Sensor readings transform"). Do not use quotes or punctuation around the name.'
  : 'Set `suggestedName` to an empty string.'}`;

  return msg;
}

app.post('/api/transform', async (req, res) => {
  try {
    const { sourceHeaders, targetHeaders, sourceSample } = req.body;
    if (!Array.isArray(sourceHeaders) || !Array.isArray(targetHeaders)) {
      return res.status(400).json({ error: 'sourceHeaders and targetHeaders must be arrays' });
    }

    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: buildPrompt(req.body) }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: transformationsSchema
        }
      }
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) {
      return res.status(502).json({ error: 'No text block in Claude response' });
    }
    const data = JSON.parse(textBlock.text);
    res.json(data);
  } catch (err) {
    console.error('transform error:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

const mergeSchema = {
  type: 'object',
  properties: {
    suggestedName: {
      type: 'string',
      description: 'Short descriptive project name when requested via suggestName; empty string otherwise.'
    },
    matchCode: {
      type: 'string',
      description: 'JS function body with signature (leftRow, rightRow). Returns truthy if the two rows represent the same entity. Must end with a return statement.'
    },
    matchNotes: {
      type: 'string',
      description: 'One-line explanation of the matching strategy.'
    },
    matchColumns: {
      type: 'array',
      description: 'Structured summary of which columns matchCode compares. One entry per column pair — if matchCode ANDs/ORs several pairs, list each pair.',
      items: {
        type: 'object',
        properties: {
          left: {
            type: 'string',
            description: 'Left column name (or a short expression when the match combines columns, e.g. "FirstName + LastName").'
          },
          right: {
            type: 'string',
            description: 'Corresponding right column name or expression.'
          },
          strategy: {
            type: 'string',
            description: 'Short phrase describing how the pair is compared — e.g. "exact", "lowercase/trim", "levenshtein <= 2", "date equality".'
          }
        },
        required: ['left', 'right', 'strategy'],
        additionalProperties: false
      }
    },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          code: {
            type: 'string',
            description: 'JS function body with signature (left, right, priority). Returns the merged value for this column. left or right may be null when the row was only present in one source. Must end with a return statement.'
          },
          notes: { type: 'string' },
        },
        required: ['name', 'code', 'notes'],
        additionalProperties: false,
      }
    }
  },
  required: ['suggestedName', 'matchCode', 'matchNotes', 'matchColumns', 'columns'],
  additionalProperties: false
};

function buildMergePrompt({ leftHeaders, rightHeaders, leftSample, rightSample, priority, existingMatchCode, existingMatchColumns, existingColumns, refinementComment, refineColumn, refineMatch, suggestName }) {
  let msg = `You are merging two spreadsheets (left and right) into a single combined spreadsheet.

Left columns: ${JSON.stringify(leftHeaders)}
Right columns: ${JSON.stringify(rightHeaders)}
Priority (which side wins conflicts): ${priority}

Sample left rows:
${JSON.stringify(leftSample, null, 2)}

Sample right rows:
${JSON.stringify(rightSample, null, 2)}
`;

  if (existingMatchCode) {
    msg += `\nCurrent matchCode:\n${existingMatchCode}\n`;
  }
  if (existingMatchColumns && existingMatchColumns.length) {
    msg += `\nCurrent matchColumns:\n${JSON.stringify(existingMatchColumns, null, 2)}\n`;
  }
  if (existingColumns && existingColumns.length) {
    msg += `\nCurrent columns:\n${JSON.stringify(existingColumns, null, 2)}\n`;
  }
  if (refinementComment) {
    msg += `\nUser feedback: ${refinementComment}\n`;
  }
  if (refineColumn) {
    msg += `\nFocus the refinement on the output column named "${refineColumn}" ONLY. Leave matchCode, matchColumns, and every other output column unchanged from the current values above. Still return the complete current state for every field.\n`;
  }
  if (refineMatch) {
    msg += `\nFocus the refinement on matchCode and matchColumns ONLY (the row-matching logic). Leave every output column unchanged from its current code and notes. Still return the complete current state for every field.\n`;
  }

  msg += `
Available runtime helper (globally available — do NOT redefine it, just call it):
- levenshteinDistance(a, b) → number. Returns the edit distance between two strings (null-safe; non-string inputs are coerced via String()). Use this for fuzzy text matching when free-text fields (names, addresses, company names) may have minor typos, casing, or punctuation differences. Typical thresholds:
    - short fields (≤ 10 chars): distance <= 1 or 2
    - longer fields: distance / Math.max(a.length, b.length) < 0.15–0.25
  Always normalize (lowercase, trim, collapse whitespace) before calling it so trivial differences don't inflate the distance.

Produce:

1. matchCode — a JavaScript function body with signature (leftRow, rightRow). Returns truthy if the two rows represent the same underlying entity.
   - leftRow and rightRow are plain objects keyed by the column names listed above.
   - Use bracket notation: leftRow['Column Name'] (column names may contain spaces or punctuation).
   - Normalize before comparing, e.g. String(x || '').toLowerCase().trim().
   - Prefer a stable id / key column (id, email, sku) with exact equality. Fall back to a combination of normalized fields when no single key exists.
   - When comparing one or more free-text columns where the sample data shows likely typos or inconsistent formatting, use levenshteinDistance to match on similarity. Example:
       const norm = (x) => String(x || '').toLowerCase().trim().replace(/\\s+/g, ' ');
       const ln = norm(leftRow['Company']);
       const rn = norm(rightRow['Company']);
       if (ln && rn && levenshteinDistance(ln, rn) <= Math.max(2, Math.floor(Math.max(ln.length, rn.length) * 0.2))) return true;
       return false;
   - The body MUST end with a return statement. Body only — no function wrapper.

2. matchColumns — a structured summary of the column pairs matchCode compares. One entry per pair with { left, right, strategy }. If matchCode ANDs/ORs multiple pairs, include every pair. Keep strategy terse (e.g. "exact", "lowercase/trim", "levenshtein <= 2"). The UI uses this to show users which columns drive the join.

3. columns — the output columns for the merged sheet. Each entry is { name, code, notes }.
   - Default to the union of left and right headers (in a natural order that preserves left-side order first, then right-side headers not in left).
   - You may rename, combine, or drop columns when that produces a cleaner merged sheet.
   - code is a JavaScript function body with signature (left, right, priority).
       - left or right may be null / undefined when a row exists only in one source.
       - priority is 'left' or 'right'. When both sides contribute to the column, prefer the priority side and fall back to the other if that value is empty.
       - Tolerate undefined/null with guards like (left && left['Col']).
       - Example for a column present on both sides:
           const l = (left && left['Email']) || '';
           const r = (right && right['Email']) || '';
           return priority === 'left' ? (l || r) : (r || l);
       - The body MUST end with a return statement.
   - notes: one-line explanation of the column mapping.

${suggestName
  ? 'Also propose a short 3–6 word project name in `suggestedName` describing the merge (e.g. "Customers merge", "Orders with invoices merge", "Users and subscriptions merge"). No quotes or punctuation.'
  : 'Set `suggestedName` to an empty string.'}`;

  return msg;
}

app.post('/api/merge', async (req, res) => {
  try {
    const { leftHeaders, rightHeaders } = req.body;
    if (!Array.isArray(leftHeaders) || !Array.isArray(rightHeaders)) {
      return res.status(400).json({ error: 'leftHeaders and rightHeaders must be arrays' });
    }

    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: buildMergePrompt(req.body) }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: mergeSchema
        }
      }
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) {
      return res.status(502).json({ error: 'No text block in Claude response' });
    }
    const data = JSON.parse(textBlock.text);
    res.json(data);
  } catch (err) {
    console.error('merge error:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`sstransform listening on http://localhost:${port}`));

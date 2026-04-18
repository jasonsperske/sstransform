import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

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
    }
  },
  required: ['transformations'],
  additionalProperties: false
};

function buildPrompt({ sourceHeaders, targetHeaders, sourceSample, existingTransformations, refinementComment, targetColumn }) {
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

${existingTransformations && existingTransformations.length ? 'Return the full updated transformation set (one entry per target column).' : 'Return one entry for every target column listed above.'}`;

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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`sstransform listening on http://localhost:${port}`));

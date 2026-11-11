/**
 * tests/ai-usage.test.js -- the list of AI features is complete and true.
 *
 * If any file calls an AI provider without being listed here and in
 * utils/ai-usage.js, this fails. That is what lets CHC state, and defend,
 * exactly where the software uses AI.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AI_FEATURES, logAiUse } = require('../utils/ai-usage');

const ROOT = path.resolve(__dirname, '..');
const AI_PATTERN = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|@anthropic-ai\/sdk|require\(['"]openai['"]\)|api\.cohere|api\.mistral|bedrock-runtime/;

// The only files allowed to call a model, and the feature each belongs to.
const CALLERS = {
    'utils/insights.js': 'insights',
    'utils/price-image.js': 'price_screenshot'
};

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'tests', 'qa'].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(js|html)$/.test(e.name)) out.push(p);
    }
    return out;
}

test('only the listed files call an AI model', () => {
    const found = walk(ROOT).filter(f => AI_PATTERN.test(fs.readFileSync(f, 'utf8'))).map(f => path.relative(ROOT, f)).sort();
    assert.deepEqual(found, Object.keys(CALLERS).sort());
});

test('every caller is a listed feature, and every listed feature logs each call', () => {
    const keys = AI_FEATURES.map(f => f.key).sort();
    assert.deepEqual([...new Set(Object.values(CALLERS))].sort(), keys);
    const code = walk(path.join(ROOT, 'routes')).map(f => fs.readFileSync(f, 'utf8')).join('\n');
    for (const k of keys) assert.match(code, new RegExp(`logAiUse\\([^)]*\\{[\\s\\S]{0,40}feature: '${k}'`), `${k} is never logged`);
});

test('no AI feature can change data, and each says what it sends', () => {
    for (const f of AI_FEATURES) {
        assert.equal(f.can_change_data, false, f.key);
        assert.ok(f.sends && f.sends.length > 20, f.key);
        assert.equal(f.calls_per_use, 1, f.key);
    }
});

test('logging an unlisted feature is refused', async () => {
    await assert.rejects(logAiUse({ from: () => ({ insert: async () => ({}) }) }, { feature: 'chatbot' }), /Unlisted AI feature/);
});

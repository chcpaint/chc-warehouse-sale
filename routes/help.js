/**
 * routes/help.js -- public, read-only facts for the Help page (/help).
 *
 * GET /api/help/ai  The places the software uses AI, straight from the AI
 *                   register (utils/ai-usage.js), so the published statement
 *                   can never drift from the code. Internal setting names
 *                   (which environment variable holds which key) are left out.
 *
 * Nothing here reads the database or needs a sign-in.
 */
const express = require('express');
const { AI_FEATURES } = require('../utils/ai-usage');

const router = express.Router();

const PUBLIC_FIELDS = ['key', 'name', 'plain', 'where', 'who', 'provider', 'sends', 'does', 'can_change_data', 'human_in_the_loop', 'calls_per_use'];

function publicAiFeatures() {
    return AI_FEATURES.map(f => Object.fromEntries(PUBLIC_FIELDS.map(k => [k, f[k]])));
}

router.get('/ai', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
        count: AI_FEATURES.length,
        features: publicAiFeatures(),
        not_ai: ['The help assistant (the round button, bottom right) searches a written guide on your own device. It is not AI and sends nothing anywhere.']
    });
});

module.exports = router;
module.exports.publicAiFeatures = publicAiFeatures;

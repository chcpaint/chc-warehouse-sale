/**
 * routes/help.js -- public, read-only facts for the Help page (/help).
 *
 * GET /api/help/ai  The places the software uses AI, straight from the AI
 *                   register (utils/ai-usage.js), so the published statement
 *                   can never drift from the code. Internal setting names
 *                   (which environment variable holds which key) are left out.
 *
 * GET /api/help/status  Uptime and backup-drill evidence for the security section.
 *
 * Nothing here needs a sign-in or returns anything about a customer.
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

/**
 * GET /api/help/status -- evidence for the Help page's security section:
 * whether the uptime monitor is running and the last 30 days' uptime of the
 * health check, and when a backup last passed its restore drill. Only those
 * figures; nothing about any customer. Cached for a minute.
 */
let statusCache = { at: 0, body: null };
router.get('/status', async (req, res) => {
    try {
        if (!statusCache.body || Date.now() - statusCache.at > 60 * 1000) {
            // Required here, not at load, so the AI list works without a database.
            const { supabaseAdmin } = require('../utils/supabase');
            const { monitorStatus } = require('../utils/health');
            const [monitor, summary, runs] = await Promise.all([
                monitorStatus(supabaseAdmin),
                supabaseAdmin.rpc('uptime_summary', { p_hours: 24 * 30 }),
                supabaseAdmin.from('backup_runs').select('run_at, status').order('run_at', { ascending: false }).limit(20)
            ]);
            const health = !summary.error && (summary.data || []).find(r => r.target_id === 1);
            const list = runs.error ? [] : (runs.data || []);
            const passed = list.find(r => r.status === 'passed');
            statusCache = {
                at: Date.now(),
                body: {
                    uptime: { monitor, uptime_30d: health && health.uptime_pct != null ? Number(health.uptime_pct) : null, checks_30d: health ? Number(health.checks) : 0 },
                    backups: { last_run_at: list[0] ? list[0].run_at : null, last_status: list[0] ? list[0].status : null, last_passed_at: passed ? passed.run_at : null }
                }
            };
        }
        res.set('Cache-Control', 'public, max-age=60');
        res.json(statusCache.body);
    } catch (err) {
        console.error('Help status error:', err);
        res.json({ uptime: { monitor: 'off', uptime_30d: null, checks_30d: 0 }, backups: { last_run_at: null, last_status: null, last_passed_at: null } });
    }
});

module.exports = router;
module.exports.publicAiFeatures = publicAiFeatures;

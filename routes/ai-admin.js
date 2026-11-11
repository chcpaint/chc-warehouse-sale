/**
 * routes/ai-admin.js -- where AI is used, and every time it was.
 *
 *   GET /api/admin/ai/features      the complete list of AI features (any admin)
 *   GET /api/admin/ai/usage         every AI call, newest first (super admin);
 *                                   ?from=&to=&company_id=&feature=&format=csv
 *
 * Usage is fenced to the admin's own distributor. The CSV is what CHC hands
 * to anyone who asks "when, where and how was AI used?".
 */
const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { isValidUUID } = require('../utils/sanitize');
const { AI_FEATURES, FEATURE_KEYS } = require('../utils/ai-usage');

const router = express.Router();

router.get('/features', (req, res) => {
    res.json({ features: AI_FEATURES, statement: 'These are the only places the software calls an AI model. Each call is logged.' });
});

const csvCell = v => {
    const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

router.get('/usage', requireSuperAdmin, async (req, res) => {
    try {
        const { from, to, company_id, feature, format } = req.query;
        let q = supabaseAdmin.from('ai_usage_log')
            .select('created_at, feature, company_id, location_id, actor_type, actor_id, model, status, error_code, input_tokens, output_tokens, latency_ms, request_id' + (format === 'csv' ? '' : ', input_summary, output'))
            .order('created_at', { ascending: false }).limit(5000);
        if (req.distributor) q = q.eq('distributor_id', req.distributor.id);
        if (from && !Number.isNaN(Date.parse(from))) q = q.gte('created_at', new Date(from).toISOString());
        if (to && !Number.isNaN(Date.parse(to))) q = q.lte('created_at', new Date(to).toISOString());
        if (company_id && isValidUUID(company_id)) q = q.eq('company_id', company_id);
        if (feature && FEATURE_KEYS.has(feature)) q = q.eq('feature', feature);
        const { data, error } = await q;
        if (error) throw error;
        const rows = data || [];

        const ids = [...new Set(rows.map(r => r.company_id).filter(Boolean))];
        const names = new Map();
        if (ids.length) {
            const { data: cos } = await supabaseAdmin.from('companies').select('id, name').in('id', ids);
            for (const c of cos || []) names.set(c.id, c.name);
        }
        const out = rows.map(r => ({ ...r, company_name: names.get(r.company_id) || null }));

        if (format === 'csv') {
            const cols = ['created_at', 'feature', 'company_name', 'company_id', 'location_id', 'actor_type', 'actor_id', 'model', 'status', 'error_code', 'input_tokens', 'output_tokens', 'latency_ms', 'request_id'];
            const csv = [cols.join(',')].concat(out.map(r => cols.map(c => csvCell(r[c])).join(','))).join('\n');
            res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ai-usage.csv"' });
            return res.send(csv);
        }
        res.json({ usage: out, features: AI_FEATURES });
    } catch (err) {
        console.error('AI usage report error:', err);
        res.status(500).json({ error: 'Could not load the AI usage report.' });
    }
});

module.exports = router;

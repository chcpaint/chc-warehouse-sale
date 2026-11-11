/**
 * routes/insights-store.js -- Insights, on the shop's Reports screen.
 *
 *   GET  /api/store/:slug/insights   is it on, is it set up, how many left today,
 *                                    the last result, and the plain-language
 *                                    disclosure of what is sent where
 *   POST /api/store/:slug/insights   one call to Claude with this shop's snapshot
 *
 * Rules, all enforced here rather than by hiding a button:
 *   - the company must have the Insights module on;
 *   - the same access as Reports: with "Reports for signed-in accounts only" on,
 *     the shared access code gets nothing; a person tied to one shop only ever
 *     gets that shop, whatever the request says;
 *   - prices are left out of the snapshot when the shop has pricing hidden;
 *   - a daily limit per company (INSIGHTS_DAILY_LIMIT, default 5);
 *   - every call, successful or not, is written to ai_usage_log.
 */
const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAuth } = require('../middleware/auth');
const { isValidUUID } = require('../utils/sanitize');
const { moduleEnabled } = require('../utils/modules');
const { hidePricingEnabled } = require('../utils/pricing-visibility');
const { loadInsightsSnapshot } = require('../utils/insights-data');
const { generateInsights, InsightsError } = require('../utils/insights');
const { AI_FEATURES, logAiUse } = require('../utils/ai-usage');

const router = express.Router({ mergeParams: true });
router.use(requireCompanyAuth);

const DISCLOSURE = AI_FEATURES.find(f => f.key === 'insights');
const dailyLimit = () => Math.max(1, parseInt(process.env.INSIGHTS_DAILY_LIMIT, 10) || 5);

/** Load the company and apply every access rule. Sends the refusal itself and returns null. */
async function gate(req, res) {
    const { data: company, error } = await supabaseAdmin.from('companies')
        .select('id, name, settings, distributor_id').eq('id', req.company.id).maybeSingle();
    if (error || !company) { res.status(404).json({ error: 'Company not found.' }); return null; }
    if (!moduleEnabled(company.settings, 'insights')) {
        res.status(403).json({ error: 'Insights is not switched on for this account. Ask CHC.', code: 'insights_off' });
        return null;
    }
    if (moduleEnabled(company.settings, 'restricted_reports') && !req.companyUser) {
        res.status(403).json({ error: 'Insights is available to people with their own account. Please sign in with your account.', code: 'reports_need_account' });
        return null;
    }
    return company;
}

async function scopeFor(req, companyId, requested) {
    // A person tied to a shop gets that shop and nothing else.
    const forced = req.companyUser && req.companyUser.location_id;
    const id = forced || (isValidUUID(requested) ? requested : null);
    if (!id) return { id: null, name: null };
    const { data: loc } = await supabaseAdmin.from('company_locations')
        .select('id, name').eq('id', id).eq('company_id', companyId).maybeSingle();
    if (!loc) return forced ? { id: forced, name: null } : { id: null, name: null };
    return { id: loc.id, name: loc.name };
}

async function usedToday(companyId) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabaseAdmin.from('ai_usage_log')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).eq('feature', 'insights').eq('status', 'ok').gte('created_at', since);
    return count || 0;
}

router.get('/', async (req, res) => {
    try {
        const company = await gate(req, res);
        if (!company) return;
        const scope = await scopeFor(req, company.id, req.query.location_id);

        let q = supabaseAdmin.from('ai_usage_log')
            .select('created_at, model, input_summary, output, location_id')
            .eq('company_id', company.id).eq('feature', 'insights').eq('status', 'ok')
            .order('created_at', { ascending: false }).limit(1);
        q = scope.id ? q.eq('location_id', scope.id) : q.is('location_id', null);
        const { data: last } = await q;
        const used = await usedToday(company.id);

        res.json({
            enabled: true,
            configured: !!process.env.ANTHROPIC_INSIGHTS_API_KEY,
            remaining_today: Math.max(0, dailyLimit() - used),
            scope: scope.id ? { location_id: scope.id, name: scope.name } : { location_id: null, name: 'All shops' },
            last: last && last[0] ? {
                generated_at: last[0].created_at, model: last[0].model,
                insights: last[0].output, snapshot: last[0].input_summary
            } : null,
            disclosure: DISCLOSURE
        });
    } catch (err) {
        console.error('Insights status error:', err);
        res.status(500).json({ error: 'Could not load Insights.' });
    }
});

router.post('/', async (req, res) => {
    const started = Date.now();
    let company = null, scope = { id: null }, snapshot = null;
    const actor = req.companyUser
        ? { actor_type: 'company_user', actor_id: req.companyUser.id }
        : { actor_type: 'shared_code', actor_id: null };
    try {
        company = await gate(req, res);
        if (!company) return;
        if (!process.env.ANTHROPIC_INSIGHTS_API_KEY) {
            return res.status(503).json({ error: 'Insights is not set up on the server yet. Ask CHC.', code: 'not_configured' });
        }
        if (await usedToday(company.id) >= dailyLimit()) {
            return res.status(429).json({ error: `Insights can run ${dailyLimit()} times a day for this account. Try again tomorrow.`, code: 'daily_limit' });
        }
        scope = await scopeFor(req, company.id, req.body && req.body.location_id);
        const hidePrices = hidePricingEnabled(company.settings);
        snapshot = await loadInsightsSnapshot(supabaseAdmin, {
            companyId: company.id, locationId: scope.id, locationName: scope.name, hidePrices,
            modules: {
                inventory: moduleEnabled(company.settings, 'inventory'),
                kit_submissions: moduleEnabled(company.settings, 'kit_submissions')
            }
        });

        const result = await generateInsights(snapshot, {
            apiKey: process.env.ANTHROPIC_INSIGHTS_API_KEY,
            model: process.env.ANTHROPIC_INSIGHTS_MODEL,
            shopLabel: scope.name ? `${company.name}, ${scope.name}` : company.name
        });

        const generatedAt = new Date().toISOString();
        await logAiUse(supabaseAdmin, {
            feature: 'insights', company_id: company.id, distributor_id: company.distributor_id, location_id: scope.id,
            ...actor, model: result.model, status: 'ok',
            input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens,
            latency_ms: Date.now() - started, request_id: req.id, input_summary: snapshot, output: result.insights
        });
        res.json({ generated_at: generatedAt, model: result.model, insights: result.insights, snapshot, disclosure: DISCLOSURE });
    } catch (err) {
        const code = err instanceof InsightsError ? err.code : 'error';
        if (company) {
            await logAiUse(supabaseAdmin, {
                feature: 'insights', company_id: company.id, distributor_id: company.distributor_id, location_id: scope.id,
                ...actor, status: 'failed', error_code: code, latency_ms: Date.now() - started, request_id: req.id,
                input_summary: snapshot
            });
        }
        if (err instanceof InsightsError) {
            const status = { not_configured: 503, upstream: 502, unreadable: 502 }[err.code] || 500;
            return res.status(status).json({ error: err.message, code: err.code });
        }
        console.error('Insights error:', err);
        res.status(500).json({ error: 'Could not prepare Insights. Try again in a few minutes.' });
    }
});

module.exports = router;

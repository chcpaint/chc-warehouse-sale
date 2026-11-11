/**
 * utils/ai-usage.js
 *
 * The complete list of places the software uses AI, and the log every one of
 * them writes to. If a feature that calls an AI model is not in AI_FEATURES,
 * it does not exist: tests/ai-usage.test.js scans the code for AI calls and
 * fails if anything calls a model without being listed here.
 *
 * The list is what the console shows people ("where AI is used") and what
 * GET /api/admin/ai/features returns, so the disclosure can never drift from
 * the code.
 */
const AI_FEATURES = [
    {
        key: 'insights',
        name: 'Insights',
        plain: 'Insights, on the Reports screen, for shops where CHC has switched it on',
        where: 'Shop console, Reports screen, Insights button',
        who: 'People at a shop who can see Reports, only where CHC has switched Insights on for that customer',
        provider: 'Anthropic (Claude)',
        key_setting: 'ANTHROPIC_INSIGHTS_API_KEY',
        sends: 'A summary of the shop\'s own numbers: order counts and spend, top items and categories, stock levels and kit totals. No names, emails, phone numbers, addresses, PO, repair-order or claim numbers, VINs or notes. No dollar figures when the shop has pricing hidden.',
        does: 'Writes suggestions: what is going well, what may be worth acting on, what may be worth a closer look.',
        can_change_data: false,
        human_in_the_loop: 'Advice only. Nothing in the console changes because of it.',
        calls_per_use: 1
    },
    {
        key: 'price_screenshot',
        name: 'Price screenshot reading',
        plain: 'price-screenshot reading, in CHC\'s admin console, used by CHC staff to load supplier price updates',
        where: 'CHC admin console, catalogue import',
        who: 'CHC staff only. Never shops or the kiosk.',
        provider: 'Anthropic (Claude)',
        key_setting: 'ANTHROPIC_API_KEY',
        sends: 'A screenshot of a supplier\'s price update.',
        does: 'Reads the screenshot into rows: part number, name, brand, price.',
        can_change_data: false,
        human_in_the_loop: 'A person checks and corrects every row; only the normal import, pressed by that person, saves anything.',
        calls_per_use: 1
    }
];

const FEATURE_KEYS = new Set(AI_FEATURES.map(f => f.key));

/**
 * Write one row to ai_usage_log. Never throws: a logging failure must not
 * break the feature, but it is reported loudly so it is noticed.
 */
async function logAiUse(supabase, row) {
    if (!FEATURE_KEYS.has(row.feature)) throw new Error(`Unlisted AI feature: ${row.feature}`);
    try {
        const { error } = await supabase.from('ai_usage_log').insert({
            feature: row.feature,
            company_id: row.company_id || null,
            distributor_id: row.distributor_id || null,
            location_id: row.location_id || null,
            actor_type: row.actor_type || null,
            actor_id: row.actor_id || null,
            provider: 'anthropic',
            model: row.model || null,
            status: row.status || 'ok',
            error_code: row.error_code || null,
            input_tokens: row.input_tokens == null ? null : row.input_tokens,
            output_tokens: row.output_tokens == null ? null : row.output_tokens,
            latency_ms: row.latency_ms == null ? null : row.latency_ms,
            request_id: row.request_id || null,
            input_summary: row.input_summary || null,
            output: row.output || null
        });
        if (error) console.error('AI usage log write failed:', error.message || error);
    } catch (err) {
        console.error('AI usage log write failed:', err.message || err);
    }
}

module.exports = { AI_FEATURES, FEATURE_KEYS, logAiUse };

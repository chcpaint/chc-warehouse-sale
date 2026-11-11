/**
 * routes/uptime-admin.js -- the uptime monitor's results (migration 064).
 *
 *   GET /api/admin/uptime            uptime % (24 h, 7 days, 30 days), last check and
 *                                    incidents for every monitored page
 *   PUT /api/admin/uptime/settings   who gets alerts: { alert_emails: [], webhook_url }
 *
 * Super admins only. The monitor itself runs inside Supabase every minute;
 * this only reads what it recorded and edits the alert list.
 */
const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireSuperAdmin } = require('../middleware/auth');
const { validateEmail } = require('../utils/sanitize');
const { monitorStatus } = require('../utils/health');

const router = express.Router();
router.use(requireSuperAdmin);

const NOT_INSTALLED = /uptime_|relation .* does not exist|schema cache|function .* does not exist/i;

router.get('/', async (req, res) => {
    try {
        const [targets, s24, s7, s30, incidents, settings, backups] = await Promise.all([
            supabaseAdmin.from('uptime_targets').select('id, name, url, enabled').order('id'),
            supabaseAdmin.rpc('uptime_summary', { p_hours: 24 }),
            supabaseAdmin.rpc('uptime_summary', { p_hours: 24 * 7 }),
            supabaseAdmin.rpc('uptime_summary', { p_hours: 24 * 30 }),
            supabaseAdmin.from('uptime_incidents').select('id, target_id, started_at, resolved_at, first_error').order('started_at', { ascending: false }).limit(20),
            supabaseAdmin.from('uptime_settings').select('alert_emails, from_email, webhook_url, fail_threshold').eq('id', 1).maybeSingle(),
            supabaseAdmin.from('backup_runs').select('run_at, status, tables, rows_checked, files, bytes, run_url, note').order('run_at', { ascending: false }).limit(10)
        ]);
        const firstErr = [targets, s24, s7, s30, incidents, settings].find(r => r.error);
        if (firstErr) {
            if (NOT_INSTALLED.test(firstErr.error.message || '')) {
                return res.json({ installed: false, message: 'The uptime monitor is not set up yet. Run migration 064_uptime_monitor.sql in Supabase.' });
            }
            throw firstErr.error;
        }
        const by = rows => new Map((rows || []).map(r => [r.target_id, r]));
        const m24 = by(s24.data), m7 = by(s7.data), m30 = by(s30.data);
        const names = new Map((targets.data || []).map(t => [t.id, t.name]));
        const st = settings.data || {};
        res.json({
            installed: true,
            monitor: await monitorStatus(supabaseAdmin),
            targets: (targets.data || []).map(t => ({
                id: t.id, name: t.name, url: t.url, enabled: t.enabled,
                last_checked: (m24.get(t.id) || {}).last_checked || null,
                last_ok: (m24.get(t.id) || {}).last_ok,
                avg_ms_24h: (m24.get(t.id) || {}).avg_ms || null,
                uptime_24h: (m24.get(t.id) || {}).uptime_pct ?? null,
                uptime_7d: (m7.get(t.id) || {}).uptime_pct ?? null,
                uptime_30d: (m30.get(t.id) || {}).uptime_pct ?? null,
                open_incident: (incidents.data || []).some(i => i.target_id === t.id && !i.resolved_at)
            })),
            incidents: (incidents.data || []).map(i => ({ ...i, target: names.get(i.target_id) || '' })),
            backups: backups.error ? null : (backups.data || []),
            settings: { alert_emails: st.alert_emails || [], from_email: st.from_email || '', webhook_set: !!st.webhook_url, fail_threshold: st.fail_threshold || 2 }
        });
    } catch (err) {
        console.error('Uptime read error:', err);
        res.status(500).json({ error: 'Failed to load uptime.' });
    }
});

router.put('/settings', async (req, res) => {
    try {
        const b = req.body || {};
        const update = { updated_at: new Date().toISOString() };
        if (b.alert_emails !== undefined) {
            const list = (Array.isArray(b.alert_emails) ? b.alert_emails : String(b.alert_emails).split(/[,;\s]+/))
                .map(e => String(e).trim().toLowerCase()).filter(Boolean);
            const uniq = [...new Set(list)].slice(0, 10);
            if (!uniq.length) return res.status(400).json({ error: 'Add at least one email address for alerts.' });
            const bad = uniq.find(e => !validateEmail(e));
            if (bad) return res.status(400).json({ error: `"${bad}" is not a valid email address.` });
            update.alert_emails = uniq;
        }
        if (b.webhook_url !== undefined) {
            const w = String(b.webhook_url || '').trim();
            if (w && !/^https:\/\/[^\s<>"']{4,500}$/.test(w)) return res.status(400).json({ error: 'The webhook must be an https:// address.' });
            update.webhook_url = w || null;
        }
        const { error } = await supabaseAdmin.from('uptime_settings').update(update).eq('id', 1);
        if (error) {
            if (NOT_INSTALLED.test(error.message || '')) return res.status(409).json({ error: 'Run migration 064_uptime_monitor.sql in Supabase first.' });
            throw error;
        }
        try {
            await supabaseAdmin.from('audit_log').insert({
                admin_id: req.admin.id, action: 'uptime_settings_updated', entity_type: 'uptime_settings', entity_id: null,
                details: { alert_emails: update.alert_emails, webhook_changed: b.webhook_url !== undefined }, ip_address: req.ip
            });
        } catch (_) { /* audit failure is logged by the database client */ }
        res.json({ ok: true });
    } catch (err) {
        console.error('Uptime settings error:', err);
        res.status(500).json({ error: 'Failed to save alert settings.' });
    }
});

module.exports = router;

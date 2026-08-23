/**
 * routes/po-admin.js
 *
 * Purchase-order configuration, mounted from routes/admin.js at
 *   /api/admin/companies/:companyId/po
 *
 * Three things CHC can set per customer: whether POs are used at all, whether
 * the shop supplies its own or CHC issues them, and — when CHC issues them —
 * the prefix and width.
 *
 * The rules that matter are the ones that stop a sequence going wrong later:
 *
 *   * A prefix is unique across ALL companies, so a branch holding a number can
 *     tell whose order it is without looking anything up.
 *   * The counter can be set forward, never backward. Moving it back would
 *     reissue numbers that are already on real orders — the exact failure this
 *     feature exists to prevent, and one nobody would notice until two orders
 *     showed the same PO.
 *   * Changing a prefix does not reset the counter. A company moving from ASR
 *     to ASR26 keeps counting, so even across a rename no number repeats.
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyAccess } = require('../middleware/auth');
const {
    PO_MODES, poSettings, validatePrefix, validatePadWidth, exampleFor, formatPo, inspectPo
} = require('../utils/po');

const router = express.Router({ mergeParams: true });

router.use(requireCompanyAccess);

async function logAction(adminId, action, entityType, entityId, details, ip) {
    try {
        await supabaseAdmin.from('audit_log').insert({
            admin_id: adminId, action, entity_type: entityType,
            entity_id: entityId, details, ip_address: ip
        });
    } catch (err) {
        console.error('Audit log write failed:', err);
    }
}

/**
 * GET /po
 * The current setup, plus what the next issued number would look like.
 */
router.get('/', async (req, res) => {
    try {
        const companyId = req.params.companyId;

        const { data: company } = await supabaseAdmin
            .from('companies').select('id, name, settings').eq('id', companyId).maybeSingle();
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const { data: seq } = await supabaseAdmin
            .from('company_po_sequences')
            .select('prefix, next_number, pad_width, use_check_digit, updated_at')
            .eq('company_id', companyId)
            .maybeSingle();

        const settings = poSettings(company.settings);

        const { count: issued } = await supabaseAdmin
            .from('orders')
            .select('id', { count: 'exact', head: true })
            .eq('company_id', companyId)
            .eq('po_source', 'generated');

        res.json({
            company: { id: company.id, name: company.name },
            mode: settings.mode,
            modes: PO_MODES,
            sequence: seq ? {
                prefix: seq.prefix,
                next_number: Number(seq.next_number),
                pad_width: seq.pad_width,
                use_check_digit: seq.use_check_digit,
                next_example: formatPo(seq.prefix, seq.next_number, {
                    padWidth: seq.pad_width, checkDigit: seq.use_check_digit
                }),
                updated_at: seq.updated_at
            } : null,
            issued_count: issued || 0,
            // A company set to 'generated' with no sequence would refuse every
            // order, so this is the one state the console must shout about.
            needs_setup: settings.mode === 'generated' && !seq
        });
    } catch (err) {
        console.error('PO config read error:', err);
        res.status(500).json({ error: 'Failed to load purchase order settings.' });
    }
});

/**
 * PUT /po    Body: { mode, prefix?, pad_width?, use_check_digit?, start_at? }
 */
router.put('/', async (req, res) => {
    try {
        const companyId = req.params.companyId;

        const { data: company } = await supabaseAdmin
            .from('companies').select('id, name, settings').eq('id', companyId).maybeSingle();
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const mode = String(req.body?.mode || '').trim();
        if (!PO_MODES.includes(mode)) {
            return res.status(400).json({ error: `Mode must be one of: ${PO_MODES.join(', ')}.` });
        }

        // ---- the sequence, only when CHC is issuing ----
        if (mode === 'generated') {
            const prefixCheck = validatePrefix(req.body?.prefix);
            if (!prefixCheck.ok) return res.status(400).json({ error: prefixCheck.error });

            const padCheck = validatePadWidth(req.body?.pad_width);
            if (!padCheck.ok) return res.status(400).json({ error: padCheck.error });

            const useCheckDigit = req.body?.use_check_digit !== false;

            const { data: existing } = await supabaseAdmin
                .from('company_po_sequences')
                .select('prefix, next_number')
                .eq('company_id', companyId)
                .maybeSingle();

            // A prefix belongs to one company. Without this two customers could
            // both be issuing ASR-00042 and the number would identify nobody.
            const { data: clash } = await supabaseAdmin
                .from('company_po_sequences')
                .select('company_id')
                .ilike('prefix', prefixCheck.prefix)
                .neq('company_id', companyId)
                .maybeSingle();
            if (clash) {
                return res.status(409).json({
                    error: `The prefix ${prefixCheck.prefix} is already used by another customer. Prefixes identify whose order a number belongs to, so each one is used once.`
                });
            }

            let nextNumber = existing ? Number(existing.next_number) : 1;

            // Forward only. Winding the counter back would reissue numbers that
            // are already printed on real orders.
            if (req.body?.start_at !== undefined && req.body?.start_at !== null && req.body?.start_at !== '') {
                const startAt = Number(req.body.start_at);
                if (!Number.isInteger(startAt) || startAt < 1) {
                    return res.status(400).json({ error: 'The starting number must be a whole number of 1 or more.' });
                }
                if (existing && startAt < Number(existing.next_number)) {
                    return res.status(400).json({
                        error: `The counter is already at ${existing.next_number}. It can be moved forward but never back — going back would reissue numbers that are on orders already.`
                    });
                }
                nextNumber = startAt;
            }

            const { error: seqError } = await supabaseAdmin
                .from('company_po_sequences')
                .upsert({
                    company_id: companyId,
                    prefix: prefixCheck.prefix,
                    next_number: nextNumber,
                    pad_width: padCheck.padWidth,
                    use_check_digit: useCheckDigit,
                    updated_at: new Date().toISOString(),
                    updated_by: req.admin.id
                }, { onConflict: 'company_id' });

            if (seqError) {
                if (seqError.code === '23505') {
                    return res.status(409).json({ error: `The prefix ${prefixCheck.prefix} is already in use by another customer.` });
                }
                throw seqError;
            }
        }

        // The sequence row is KEPT when switching away from 'generated'. The
        // counter is the record of what has been issued; deleting it and later
        // switching back would start again at 1 and reissue every number.
        const settings = {
            ...(company.settings || {}),
            purchase_orders: { ...((company.settings || {}).purchase_orders || {}), mode }
        };

        const { error: companyError } = await supabaseAdmin
            .from('companies')
            .update({ settings, updated_at: new Date().toISOString() })
            .eq('id', companyId);
        if (companyError) throw companyError;

        await logAction(req.admin.id, 'po_settings_updated', 'company', companyId,
            { mode, prefix: req.body?.prefix || null }, req.ip);

        const { data: seq } = await supabaseAdmin
            .from('company_po_sequences')
            .select('prefix, next_number, pad_width, use_check_digit')
            .eq('company_id', companyId)
            .maybeSingle();

        res.json({
            message: mode === 'off'
                ? `${company.name} will not be asked for a purchase order.`
                : mode === 'manual'
                    ? `${company.name} will supply their own purchase order number.`
                    : `${company.name} will be issued purchase orders starting ${formatPo(seq.prefix, seq.next_number, { padWidth: seq.pad_width, checkDigit: seq.use_check_digit })}.`,
            mode,
            sequence: seq ? {
                prefix: seq.prefix,
                next_number: Number(seq.next_number),
                pad_width: seq.pad_width,
                use_check_digit: seq.use_check_digit,
                next_example: formatPo(seq.prefix, seq.next_number, {
                    padWidth: seq.pad_width, checkDigit: seq.use_check_digit
                })
            } : null
        });
    } catch (err) {
        console.error('PO config write error:', err);
        res.status(500).json({ error: 'Failed to save purchase order settings.' });
    }
});

/**
 * GET /po/preview?prefix=ASR&pad_width=5&use_check_digit=true
 * What a number would look like, without saving anything.
 */
router.get('/preview', async (req, res) => {
    const prefixCheck = validatePrefix(req.query.prefix);
    if (!prefixCheck.ok) return res.status(400).json({ error: prefixCheck.error });

    const padCheck = validatePadWidth(req.query.pad_width);
    if (!padCheck.ok) return res.status(400).json({ error: padCheck.error });

    res.json({
        example: exampleFor(prefixCheck.prefix, padCheck.padWidth, req.query.use_check_digit !== 'false')
    });
});

/**
 * GET /po/check?po=ASR-00042-7
 *
 * For a branch holding a number that will not match: is it mistyped, or is it
 * simply not one of ours? Those are different conversations with the shop, and
 * the check digit can tell them apart without a lookup.
 */
router.get('/check', async (req, res) => {
    try {
        const verdict = inspectPo(req.query.po);

        // Whether it EXISTS is a separate question from whether it is
        // well-formed, and only the table can answer it.
        let order = null;
        if (verdict.status === 'ok') {
            const { data } = await supabaseAdmin
                .from('orders')
                .select('id, order_number, po_number, status, total, created_at')
                .eq('company_id', req.params.companyId)
                .eq('po_normalized', verdict.normalized)
                .maybeSingle();
            order = data || null;
        }

        res.json({
            ...verdict,
            found: Boolean(order),
            order,
            advice: verdict.status === 'mistyped'
                ? 'The digits do not add up — read it back to the shop before searching further.'
                : verdict.status === 'not_ours'
                    ? 'Not a number CHC issued. It is likely the shop\'s own reference.'
                    : order ? 'Valid and on file.' : 'Well-formed, but no order carries it.'
        });
    } catch (err) {
        console.error('PO check error:', err);
        res.status(500).json({ error: 'Failed to check that purchase order.' });
    }
});

module.exports = router;

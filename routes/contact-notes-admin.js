/**
 * routes/contact-notes-admin.js
 *
 * The staff side of company_notes -- a message thread with one company that
 * isn't about any single order: a product they want quoted that isn't in
 * the catalogue, a shop telling CHC it's closing early, a general question.
 * See routes/storefront.js for the customer side of the same thread.
 *
 * Mounted from routes/admin.js at /api/admin/companies/:companyId/notes,
 * guarded by requireCompanyNotesAccess -- any CHC staff who can already
 * reach this company's orders, the same shape as order notes and pricing
 * edits (see middleware/auth.js).
 */

const express = require('express');
const { supabaseAdmin } = require('../utils/supabase');
const { requireCompanyNotesAccess } = require('../middleware/auth');
const { stripHtml } = require('../utils/sanitize');
const { resolveOrderRecipients } = require('../utils/recipients');
const { sendContactNote } = require('../utils/email');

const router = express.Router({ mergeParams: true });

router.use(requireCompanyNotesAccess);

/**
 * GET /companies/:companyId/notes
 *
 * The thread, newest first. Opening it also marks any unread customer
 * message as read -- there is no separate screen a desk would visit just to
 * acknowledge one, and "a staff member opened the list" is what "read"
 * actually means here.
 */
router.get('/', async (req, res) => {
    try {
        const companyId = req.params.companyId;

        const { data: company } = await supabaseAdmin
            .from('companies').select('id, name').eq('id', companyId).maybeSingle();
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const { data: notes, error } = await supabaseAdmin
            .from('company_notes')
            .select('id, author_type, author_name, author_email, text, read_at, created_at')
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .limit(200);
        if (error) throw error;

        const unreadIds = (notes || [])
            .filter(n => n.author_type === 'customer' && !n.read_at)
            .map(n => n.id);
        if (unreadIds.length) {
            const now = new Date().toISOString();
            await supabaseAdmin
                .from('company_notes')
                .update({ read_at: now, read_by: req.admin.id })
                .in('id', unreadIds);
            notes.forEach(n => { if (unreadIds.includes(n.id)) n.read_at = now; });
        }

        res.json({ company: { id: company.id, name: company.name }, notes: notes || [] });
    } catch (err) {
        console.error('Contact notes read error:', err);
        res.status(500).json({ error: 'Failed to load messages.' });
    }
});

/**
 * POST /companies/:companyId/notes   Body: { text }
 *
 * A staff reply. Emails the company's customer-facing contacts (not a
 * specific branch -- there is no one location to route this through, the
 * way there is for an order note).
 */
router.post('/', async (req, res) => {
    try {
        const companyId = req.params.companyId;
        const text = stripHtml(req.body?.text || '').trim();
        if (!text) return res.status(400).json({ error: 'Message text is required.' });
        if (text.length > 4000) return res.status(400).json({ error: 'That message is too long.' });

        const { data: company } = await supabaseAdmin
            .from('companies').select('id, name').eq('id', companyId).maybeSingle();
        if (!company) return res.status(404).json({ error: 'Company not found.' });

        const { data: note, error } = await supabaseAdmin
            .from('company_notes')
            .insert({
                company_id: companyId,
                author_type: 'staff',
                author_name: req.admin.name || req.admin.email,
                author_email: req.admin.email,
                admin_id: req.admin.id,
                text,
                read_at: new Date().toISOString(),
                read_by: req.admin.id
            })
            .select('id, author_type, author_name, author_email, text, read_at, created_at')
            .single();
        if (error) throw error;

        try {
            const { customerTo, replyTo } = await resolveOrderRecipients({ company_id: companyId });
            if (customerTo.length) {
                sendContactNote({
                    to: customerTo, replyTo,
                    companyName: company.name,
                    author: note.author_name,
                    text,
                    fromStaff: true
                }).catch(e => console.error('Contact note email failed (non-blocking):', e.message));
            }
        } catch (e) { console.error('Contact note recipients error (non-blocking):', e.message); }

        res.status(201).json({ note });
    } catch (err) {
        console.error('Contact note add error:', err);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});

module.exports = router;

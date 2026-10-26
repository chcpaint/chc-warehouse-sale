/**
 * tests/invite-email.test.js
 *
 * The invite / password-reset email itself: a first invitation and a reset must
 * read differently, both must carry the link, and an unconfigured or failing
 * sender must report that rather than pretend.
 *
 *   node --test tests/*.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SENDGRID_API_KEY = 'SG.test-key';

const sgMail = require('@sendgrid/mail');
const sent = [];
let failWith = null;
sgMail.setApiKey = () => {};
sgMail.send = async (msg) => { if (failWith) throw failWith; sent.push(msg); };

const { sendInvite } = require('../utils/email');
const URL_ = 'https://chcsale.com/set-password.html?token=abc123&kind=company&slug=acme';

test('a first invitation says you have been invited and offers to set a password', async () => {
    const r = await sendInvite({ to: 'a@example.com', name: 'Ann', inviteUrl: URL_, context: 'Acme Auto', expiresText: '7 days' });
    assert.equal(r.sent, true);
    const m = sent.at(-1);
    assert.match(m.subject, /Set up your Acme Auto account/);
    assert.match(m.html, /invited/);
    assert.match(m.html, /Set your password/);
    assert.ok(m.html.includes(URL_) && m.text.includes(URL_));
});

test('a reset does not read like a first invitation', async () => {
    await sendInvite({ to: 'a@example.com', name: 'Ann', inviteUrl: URL_, context: 'Acme Auto', expiresText: '7 days', reset: true });
    const m = sent.at(-1);
    assert.match(m.subject, /Reset your Acme Auto password/);
    assert.match(m.html, /password reset was requested/);
    assert.match(m.html, /Choose a new password/);
    assert.doesNotMatch(m.html, /you've been invited/i);
    assert.match(m.html, /ignore this email/);
    assert.ok(m.html.includes(URL_) && m.text.includes(URL_));
});

test('names and companies are escaped in the email body', async () => {
    await sendInvite({ to: 'a@example.com', name: '<script>x</script>', inviteUrl: URL_, context: 'A&B <Co>' });
    const m = sent.at(-1);
    assert.doesNotMatch(m.html, /<script>x<\/script>/);
    assert.match(m.html, /A&amp;B &lt;Co&gt;/);
});

test('a sender failure is reported, not hidden', async () => {
    failWith = Object.assign(new Error('boom'), { response: { body: { errors: [{ message: 'The from address does not match a verified Sender Identity.' }] } } });
    try {
        const r = await sendInvite({ to: 'a@example.com', name: 'Ann', inviteUrl: URL_, context: 'Acme' });
        assert.equal(r.sent, false);
        assert.match(r.error, /verified Sender Identity/);
    } finally { failWith = null; }
});

test('no recipient is reported', async () => {
    const r = await sendInvite({ to: '', inviteUrl: URL_ });
    assert.equal(r.sent, false);
});

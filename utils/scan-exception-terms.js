/**
 * utils/scan-exception-terms.js -- what each scan-issue reason means.
 *
 * No dependencies, so the Help page tests can load it. Used by
 * utils/scan-exceptions.js and shown on both Scan issues screens.
 */
// What each reason means, what the shop does, and what the distributor does.
// The Help page and help assistant say the same (public/help-content.js,
// "Scan issues: what the terms mean"); tests/scan-exceptions.test.js keeps them in step.
const REASONS = {
    missing_barcode: { label: 'Missing barcode',
        help: 'The item is in this shop\u2019s catalogue; this barcode just is not attached to it yet (often a new package or a box code).',
        shop: 'Enter how many there are. Your distributor attaches the barcode.',
        fix: 'Attach the barcode to the item, and post the quantity.' },
    not_in_catalog:  { label: 'Not in catalogue',
        help: 'The Item Library knows this barcode, but this shop\u2019s catalogue does not carry the item.',
        shop: 'Enter how many there are. Your distributor adds the item to your catalogue.',
        fix: 'Add the Item Library item to the shop\u2019s catalogue, and post the quantity.' },
    inactive_item:   { label: 'Item switched off',
        help: 'This barcode belongs to an item that has been switched off for this shop.',
        shop: 'Enter how many there are. Your distributor decides whether to switch it back on.',
        fix: 'Switch the item back on if the shop should have it, or dismiss.' },
    invalid_code:    { label: 'Misread barcode',
        help: 'The barcode\u2019s check digit is wrong, so it was almost certainly misread (creased, dirty or shiny label).',
        shop: 'Scan it again or type the part number, then dismiss the misread one.',
        fix: 'Usually dismiss; the shop rescans.' },
    unknown_code:    { label: 'Unknown code',
        help: 'Nothing matches this code: a product not carried yet, a shipping or internal label, or a QR code.',
        shop: 'Write the name on the package in \u201cWhat is it?\u201d, or dismiss it if it was not stock.',
        fix: 'Find the item by the shop\u2019s description and attach the barcode, or dismiss.' }
};

module.exports = { REASONS };

/**
 * utils/order-status.js
 *
 * The order-status lifecycle, and the one place that knows a distributor can
 * run a different subset of it.
 *
 * The database value is unchanged and shared by every distributor:
 *   pending -> processing -> out_on_delivery -> closed   (or -> cancelled)
 *
 * CHC asked, after a staff meeting, for their own console and customer
 * emails to show only three steps -- Received, Out for Delivery, Closed --
 * plus a flag on "Out for Delivery" for a partial shipment with a
 * backorder. That is deliberately NOT a new status: it is the existing
 * `out_on_delivery` value with `orders.is_partial_shipment` set, so a
 * partially-shipped order still sorts, filters, and reports as "out on
 * delivery" everywhere that already works, and nothing downstream (order
 * scoping, exports, the fake-supabase test double) needs to know a fourth
 * label exists.
 *
 * `processing` is simply not offered in CHC's dropdown -- an order can still
 * technically hold that value (e.g. set before CHC adopted the simplified
 * set, or by API), in which case it is shown with its ordinary label rather
 * than hidden. `cancelled` stays available everywhere: it is an exception
 * path, not one of "the steps", but real orders really do get cancelled.
 *
 * A future distributor is on the FULL set unless something turns simplified
 * mode on for them explicitly (distributors.settings.order_status_mode ===
 * 'simplified') -- see migrations/038_order_workflow_upgrades.sql, which
 * opts CHC in by name rather than by a code default.
 */

/** Every value orders.status may hold, regardless of distributor. */
const ALL_STATUSES = ['pending', 'processing', 'out_on_delivery', 'closed', 'cancelled'];

const FULL_LABELS = {
    pending: 'Pending',
    processing: 'Processing',
    out_on_delivery: 'Out on Delivery',
    closed: 'Closed',
    cancelled: 'Cancelled'
};

// CHC's wording for the same underlying values, per the staff meeting.
const SIMPLIFIED_LABELS = {
    pending: 'Received',
    processing: 'Processing',
    out_on_delivery: 'Out for Delivery',
    closed: 'Closed',
    cancelled: 'Cancelled'
};

const PARTIAL_SHIPMENT_LABEL = 'Partial Shipment with Backorder';

function isSimplified(distributorSettings) {
    return !!(distributorSettings && distributorSettings.order_status_mode === 'simplified');
}

/**
 * The statuses offered in this distributor's dropdown, in display order,
 * with the right label already applied. `processing` is left off the
 * simplified set -- CHC does not want that step -- but is still a valid
 * value (see ALL_STATUSES) so an order already holding it is not corrupted,
 * only not offered as something to switch TO.
 */
function statusOptionsFor(distributorSettings) {
    if (isSimplified(distributorSettings)) {
        return ['pending', 'out_on_delivery', 'closed', 'cancelled']
            .map(value => ({ value, label: SIMPLIFIED_LABELS[value] }));
    }
    return ALL_STATUSES.map(value => ({ value, label: FULL_LABELS[value] }));
}

/**
 * The label to show for one order, given its status, its partial-shipment
 * flag, and the distributor it belongs to. This is the single place that
 * decides "Out for Delivery" vs "Partial Shipment with Backorder" vs the
 * plain "Out on Delivery" a non-simplified distributor still sees.
 */
function labelFor(status, isPartialShipment, distributorSettings) {
    const simplified = isSimplified(distributorSettings);
    if (status === 'out_on_delivery' && isPartialShipment) return PARTIAL_SHIPMENT_LABEL;
    const labels = simplified ? SIMPLIFIED_LABELS : FULL_LABELS;
    return labels[status] || status;
}

module.exports = {
    ALL_STATUSES,
    FULL_LABELS,
    SIMPLIFIED_LABELS,
    PARTIAL_SHIPMENT_LABEL,
    isSimplified,
    statusOptionsFor,
    labelFor
};

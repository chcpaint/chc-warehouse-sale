/**
 * utils/pricing-visibility.js
 *
 * Some companies -- CHC's own shops among them -- ask the people they ship
 * to not see dollar amounts at all: what the driver or the receiving shop
 * gets is a packing slip (items and quantities only), never a price or a
 * total. CHC's own staff always keep full pricing in the console regardless
 * -- this only ever blanks what the CUSTOMER side sees, never what staff
 * see -- per the "staff still sees prices" decision.
 *
 * Driven by the existing per-company module registry (utils/modules.js) as
 * `hide_pricing`, so it is one more entry in the toggle screen every other
 * module already uses, not a bespoke setting.
 */

const { moduleEnabled } = require('./modules');

function hidePricingEnabled(companySettings) {
    return moduleEnabled(companySettings, 'hide_pricing');
}

/** One line item with every price field removed. Quantity and identity stay. */
function stripItemPricing(item) {
    return {
        ...item,
        unit_price: null,
        subtotal: null,
        was_promo: undefined,
        price_on_request: undefined
    };
}

function stripItemsPricing(items) {
    return (Array.isArray(items) ? items : []).map(stripItemPricing);
}

/**
 * A copy of an order with every dollar figure removed: line prices, subtotal,
 * tax, delivery fee, and total. Everything else (status, items' names/skus/
 * quantities, notes, dates) is untouched, so a packing slip still shows what
 * was ordered -- just not what it cost.
 */
function stripOrderPricing(order) {
    if (!order) return order;
    return {
        ...order,
        items: stripItemsPricing(order.items),
        subtotal: null,
        tax: null,
        tax_rate: null,
        delivery_fee: null,
        total: null,
        pricing_hidden: true
    };
}

module.exports = { hidePricingEnabled, stripItemPricing, stripItemsPricing, stripOrderPricing };

/**
 * utils/modules.js
 *
 * The optional parts of the platform, and the rules for switching them on and
 * off per customer.
 *
 * The console started as one product. Inventory was the first thing a customer
 * could have without the rest, and it was wired as a one-off:
 * `settings.inventory.enabled`, a bespoke admin button, a bespoke gate. Kits and
 * insurance would each have added another one-off, and by the fourth the shape
 * of "what does this customer actually have" would have been spread across four
 * files with four slightly different answers.
 *
 * So this is the registry. A module is declared once here and everything else —
 * the gate, the admin toggle, the shape of the settings blob, what depends on
 * what — reads from it.
 *
 * The settings shape is unchanged and deliberately so: `settings.<name>` is
 * still `{ enabled, ...options }`, exactly what `settings.inventory` already
 * holds in the live database. Nothing had to be migrated to adopt this.
 *
 * Ordering is not a module. It is the product every customer has, and there is
 * no state in which a customer has none of it — a company with ordering off is
 * a company that should be deactivated instead.
 */

/**
 * @typedef {Object} ModuleSpec
 * @property {string}   name         key under `companies.settings`
 * @property {string}   label        what CHC calls it in the admin console
 * @property {string}   blurb        one line, shown next to the toggle
 * @property {string[]} requires     modules that must be on before this one can be
 * @property {boolean}  released     false = built but not offered; the toggle is
 *                                   visible to CHC and refuses to turn on
 * @property {Object}   defaults     the options block created when it is enabled
 */

/** @type {Record<string, ModuleSpec>} */
const MODULES = {
    inventory: {
        name: 'inventory',
        label: 'refinishAI Inventory',
        blurb: 'Scanner-driven stock control, cycle counts, transfers and automatic reordering.',
        requires: [],
        released: true,
        defaults: {
            enabled: false,
            auto_draft: true,
            require_approval: true,
            allow_negative: false,
            scan_sound: true,
            alert_emails: [],
            // The hour, in the company's local time, that the low-stock digest
            // is sent. Null means the platform default.
            digest_hour: null,
            // Tell a manager when the shelf raises a reorder, rather than
            // waiting for someone to open the tab and find it.
            notify_on_draft: true
        }
    },

    kits: {
        name: 'kits',
        label: 'Repair kits',
        blurb: 'Expense a job\'s materials in one action, against a repair order number.',
        requires: ['inventory'],
        released: true,
        defaults: {
            enabled: false,
            // Whether a shop may adjust quantities on a kit as they apply it.
            allow_line_overrides: true
        }
    },

    insurance: {
        name: 'insurance',
        label: 'Insurance billing',
        blurb: 'Materials invoicing to third-party carriers, priced from what the job actually consumed.',
        requires: ['inventory', 'kits'],
        // Not built. The toggle exists so the shape is settled and a customer
        // asking for it is a configuration change rather than a rebuild — but
        // turning it on would enable nothing, so it refuses until there is
        // something behind it. See REFINISHAI_INSURANCE_PLAN.md.
        released: false,
        defaults: {
            enabled: false,
            carrier_profile: null,
            markup_pct: null,
            export_format: null
        }
    }
};

const MODULE_NAMES = Object.keys(MODULES);

/**
 * The options block for one module, with defaults filled in.
 *
 * Reading a module that was never configured returns its defaults with
 * `enabled: false`, so a caller never has to distinguish "off" from "absent" —
 * they are the same thing and always have been.
 *
 * @param {Object|null} companySettings the raw `companies.settings` jsonb
 * @param {string} name
 * @returns {Object}
 */
function moduleSettings(companySettings, name) {
    const spec = MODULES[name];
    if (!spec) return { enabled: false };

    const raw = (companySettings && typeof companySettings === 'object' && companySettings[name]) || {};
    const out = { ...spec.defaults, ...raw };

    // A module is only on if its own flag is set AND everything it needs is on.
    // Enforced on read rather than only on write, because a dependency can be
    // turned off after the fact and the dependent must not keep working.
    out.enabled = raw.enabled === true && spec.requires.every(
        dep => moduleSettings(companySettings, dep).enabled
    );

    return out;
}

/**
 * Is this module usable for this company right now?
 * @returns {boolean}
 */
function moduleEnabled(companySettings, name) {
    return moduleSettings(companySettings, name).enabled === true;
}

/**
 * Everything CHC can see about one company's modules — used by the admin UI.
 * `blocked_by` is what to tell the operator when a toggle will not turn on.
 */
function moduleStatus(companySettings) {
    return MODULE_NAMES.map(name => {
        const spec = MODULES[name];
        const raw = (companySettings && companySettings[name]) || {};
        const missing = spec.requires.filter(dep => !moduleEnabled(companySettings, dep));

        return {
            name,
            label: spec.label,
            blurb: spec.blurb,
            released: spec.released,
            requires: spec.requires,
            // What the flag says, before dependencies are considered.
            requested: raw.enabled === true,
            // What is actually true.
            enabled: moduleEnabled(companySettings, name),
            blocked_by: missing,
            available: spec.released && missing.length === 0
        };
    });
}

/**
 * Validate a request to switch a module on or off.
 *
 * Turning something OFF is always allowed — a customer must never be stuck with
 * a module because of a rule of ours. Turning something ON has to be earned.
 *
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function canSetModule(companySettings, name, enabled) {
    const spec = MODULES[name];
    if (!spec) return { ok: false, error: `Unknown module "${name}".` };

    if (!enabled) return { ok: true };

    if (!spec.released) {
        return { ok: false, error: `${spec.label} is not available yet. The switch is here so it can be turned on the day it ships.` };
    }

    const missing = spec.requires.filter(dep => !moduleEnabled(companySettings, dep));
    if (missing.length) {
        const labels = missing.map(m => MODULES[m]?.label || m).join(' and ');
        return { ok: false, error: `Turn ${labels} on first — ${spec.label} builds on it.` };
    }

    return { ok: true };
}

/**
 * Produce the new `settings` object with one module changed.
 *
 * Never destroys the module's other options: turning inventory off and on again
 * must not lose a customer's alert addresses or their digest hour. That is the
 * whole reason this returns a merged object rather than replacing the block.
 */
function withModule(companySettings, name, patch) {
    const spec = MODULES[name];
    if (!spec) return companySettings || {};

    const base = (companySettings && typeof companySettings === 'object') ? companySettings : {};
    const existing = (base[name] && typeof base[name] === 'object') ? base[name] : {};

    return {
        ...base,
        [name]: { ...spec.defaults, ...existing, ...patch }
    };
}

/**
 * Modules that stop working if `name` is switched off — what to warn about
 * before doing it.
 */
function dependentsOf(name) {
    return MODULE_NAMES.filter(other => MODULES[other].requires.includes(name));
}

module.exports = {
    MODULES,
    MODULE_NAMES,
    moduleSettings,
    moduleEnabled,
    moduleStatus,
    canSetModule,
    withModule,
    dependentsOf
};

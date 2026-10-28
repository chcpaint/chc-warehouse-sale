/**
 * utils/tax-regions.js
 *
 * Reference list of Canadian provinces/territories and US states + DC, with a
 * STARTING-POINT sales tax rate for each. These are only suggestions that
 * pre-fill the rate box on the Tax screen: the rate a distributor actually
 * saves is what gets charged, and it is the distributor's responsibility to
 * confirm it with their accountant. US state rates are the state-level base
 * rate only; most states also have county/city taxes that vary by address, so
 * a distributor can save a different rate per state and override any single
 * customer (Companies > Tax).
 *
 * Canada: total of GST/HST (+ PST/QST where it applies). US: state base rate.
 */

const CA = [
    ['AB', 'Alberta', 0.05, 'GST'],
    ['BC', 'British Columbia', 0.12, 'GST + PST'],
    ['MB', 'Manitoba', 0.12, 'GST + RST'],
    ['NB', 'New Brunswick', 0.15, 'HST'],
    ['NL', 'Newfoundland and Labrador', 0.15, 'HST'],
    ['NS', 'Nova Scotia', 0.14, 'HST'],
    ['NT', 'Northwest Territories', 0.05, 'GST'],
    ['NU', 'Nunavut', 0.05, 'GST'],
    ['ON', 'Ontario', 0.13, 'HST'],
    ['PE', 'Prince Edward Island', 0.15, 'HST'],
    ['QC', 'Quebec', 0.14975, 'GST + QST'],
    ['SK', 'Saskatchewan', 0.11, 'GST + PST'],
    ['YT', 'Yukon', 0.05, 'GST']
];

const US = [
    ['AL', 'Alabama', 0.04], ['AK', 'Alaska', 0], ['AZ', 'Arizona', 0.056],
    ['AR', 'Arkansas', 0.065], ['CA', 'California', 0.0725], ['CO', 'Colorado', 0.029],
    ['CT', 'Connecticut', 0.0635], ['DE', 'Delaware', 0], ['DC', 'District of Columbia', 0.06],
    ['FL', 'Florida', 0.06], ['GA', 'Georgia', 0.04], ['HI', 'Hawaii', 0.04],
    ['ID', 'Idaho', 0.06], ['IL', 'Illinois', 0.0625], ['IN', 'Indiana', 0.07],
    ['IA', 'Iowa', 0.06], ['KS', 'Kansas', 0.065], ['KY', 'Kentucky', 0.06],
    ['LA', 'Louisiana', 0.05], ['ME', 'Maine', 0.055], ['MD', 'Maryland', 0.06],
    ['MA', 'Massachusetts', 0.0625], ['MI', 'Michigan', 0.06], ['MN', 'Minnesota', 0.06875],
    ['MS', 'Mississippi', 0.07], ['MO', 'Missouri', 0.04225], ['MT', 'Montana', 0],
    ['NE', 'Nebraska', 0.055], ['NV', 'Nevada', 0.0685], ['NH', 'New Hampshire', 0],
    ['NJ', 'New Jersey', 0.06625], ['NM', 'New Mexico', 0.04875], ['NY', 'New York', 0.04],
    ['NC', 'North Carolina', 0.0475], ['ND', 'North Dakota', 0.05], ['OH', 'Ohio', 0.0575],
    ['OK', 'Oklahoma', 0.045], ['OR', 'Oregon', 0], ['PA', 'Pennsylvania', 0.06],
    ['RI', 'Rhode Island', 0.07], ['SC', 'South Carolina', 0.06], ['SD', 'South Dakota', 0.042],
    ['TN', 'Tennessee', 0.07], ['TX', 'Texas', 0.0625], ['UT', 'Utah', 0.0485],
    ['VT', 'Vermont', 0.06], ['VA', 'Virginia', 0.043], ['WA', 'Washington', 0.065],
    ['WV', 'West Virginia', 0.06], ['WI', 'Wisconsin', 0.05], ['WY', 'Wyoming', 0.04]
];

const COUNTRIES = {
    CA: {
        code: 'CA', name: 'Canada', currency: 'CAD', regionLabel: 'Province / territory',
        taxLabel: 'GST / HST / PST',
        regions: CA.map(([code, name, rate, kind]) => ({ code, name, reference_rate: rate, kind }))
    },
    US: {
        code: 'US', name: 'United States', currency: 'USD', regionLabel: 'State',
        taxLabel: 'Sales tax',
        regions: US.map(([code, name, rate]) => ({ code, name, reference_rate: rate, kind: 'State sales tax' }))
    }
};

function isCountry(code) { return Object.prototype.hasOwnProperty.call(COUNTRIES, code); }

function findRegion(country, region) {
    if (!isCountry(country)) return null;
    return COUNTRIES[country].regions.find(r => r.code === region) || null;
}

module.exports = { COUNTRIES, isCountry, findRegion };

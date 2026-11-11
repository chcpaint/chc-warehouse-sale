/**
 * utils/request-id.js
 *
 * Gives every request an id, returns it in the X-Request-Id header, and makes it
 * available to the error handler, so "something failed around 2:14" becomes one
 * line in the logs that can be found.
 *
 * A caller-supplied id (for example from a load balancer) is kept only if it is
 * short and plain; anything else is replaced, so a request can never inject
 * newlines or markup into the logs.
 */
const crypto = require('crypto');

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

function requestId(req, res, next) {
    const supplied = req.headers['x-request-id'];
    req.id = (typeof supplied === 'string' && SAFE_ID.test(supplied)) ? supplied : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
}

module.exports = { requestId, SAFE_ID };

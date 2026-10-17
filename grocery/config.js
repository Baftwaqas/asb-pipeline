// ASB PIPELINE — grocery/config.js: bill limits, read on every use so an
// operator change (Render env) applies without a code change.
"use strict";
const billMaxAttempts = () => Number(process.env.GROCERY_BILL_MAX_ATTEMPTS || 5);   // automatic attempts per authorization
const billMaxAgeH = () => Number(process.env.GROCERY_BILL_MAX_AGE_H ?? 6);
module.exports = { billMaxAttempts, billMaxAgeH };

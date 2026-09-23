// Single source of truth for what each plan is allowed to do.
// Change numbers here — nothing else needs to be touched.
//
// monthlyTokens: null means unlimited. Otherwise it's the total
// (input + output) tokens a user on that plan can use per 30-day period.
// requestsPerMinute: caps burst usage so one user/key can't hammer the
// free-tier model and slow it down for everyone else.

const PLAN_LIMITS = {
  free: {
    monthlyTokens: 50000,
    requestsPerMinute: 8,
  },
  '3mo': {
    monthlyTokens: 2000000,
    requestsPerMinute: 60,
  },
  annual: {
    monthlyTokens: 2000000,
    requestsPerMinute: 60,
  },
  perm: {
    monthlyTokens: null, // unlimited
    requestsPerMinute: 120,
  },
};

function getPlanLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

module.exports = { PLAN_LIMITS, getPlanLimits };

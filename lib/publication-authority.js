'use strict';

// R13: publication trust is a durable operator decision, never an inference
// from a mutable catalog field, wallet linkage, or a contributor's own action.
const PUBLICATION_TRUST_SOURCES = new Set(['operator_grant', 'admin_approval']);

function isPublicationTrusted(account) {
  const trust = account && account.publication_trust;
  return !!(
    trust &&
    PUBLICATION_TRUST_SOURCES.has(trust.source) &&
    typeof trust.granted_at === 'string' && trust.granted_at.length > 0 &&
    typeof trust.ref === 'string' && trust.ref.length > 0
  );
}

function grantPublicationTrust(account, { source, grantedAt, ref } = {}) {
  if (!account || typeof account !== 'object') {
    throw new TypeError('account is required');
  }
  if (!PUBLICATION_TRUST_SOURCES.has(source)) {
    throw new TypeError('publication trust source must be operator_grant or admin_approval');
  }
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new TypeError('publication trust ref is required');
  }
  const granted_at = grantedAt || new Date().toISOString();
  account.publication_trust = { source, granted_at, ref };
  return account.publication_trust;
}

module.exports = {
  PUBLICATION_TRUST_SOURCES,
  isPublicationTrusted,
  grantPublicationTrust,
};

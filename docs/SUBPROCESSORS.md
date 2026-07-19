# Auxilo — Subprocessors

*Last updated: 2026-07-18*

This page lists the third-party service providers that Auxilo engages as subprocessors for the processing of Builder and Consumer data. It is maintained as a living document and updated whenever a subprocessor is added, removed, or materially changed.

---

## Current Subprocessors

| Subprocessor | Purpose | Data Processed | DPA Status |
|---|---|---|---|
| **Anthropic, PBC** | LLM inference for automated sensitivity screening of submitted Learning content before publication | Submitted Learning text (title, body, tags); no session transcripts (extraction runs on the Builder's machine through the Builder's own model client; see Privacy Policy §7.6) | Covered under Anthropic Commercial Terms (no training on API content) |
| **Resend, Inc.** | Transactional email delivery (magic-link sign-in emails) | Builder email addresses, sign-in link emails | Resend DPA in effect |
| **Stripe, Inc.** | Payment processing for credit-pack purchases and Builder payouts | Payment card data, billing address, Stripe Connect account details | Stripe DPA in effect |
| **Coinbase, Inc. (via Base L2)** | On-chain x402 payment verification | Wallet addresses, transaction hashes (public blockchain data) | N/A (public data) |

---

## Forward-Looking Notes

- Additional LLM subprocessors may be added in the future as the extraction pipeline evolves. Any new subprocessor will be reflected on this page **before** it processes Builder data.
- Auxilo does not use any subprocessor for training purposes. All LLM API usage is inference-only under commercial terms that prohibit the subprocessor from using submitted data for model training.

---

## Change Log

| Date | Change | Reviewer |
|---|---|---|
| 2026-04-14 | Initial publication with P2.1a launch | GOV-2 |
| 2026-06-10 | Added Resend, Inc. — magic-link email delivery (LW-1) | GOV-2 |
| 2026-07-06 | Confirmed Resend, Inc. as the operative transactional email subprocessor (verified wired in `lib/email.js` + `lib/ops-alert.js`); aligned with Privacy Policy §3.8 | GOV-2 |
| 2026-07-18 | Corrected Anthropic, PBC entry to the as-built client-side extraction flow: session transcripts are processed on the Builder's machine by the Builder's own model client and are not transmitted to Auxilo or its subprocessors; Anthropic processes submitted Learning text for pre-publication sensitivity screening only | GOV-2 |

---

*For questions about subprocessor practices, contact hello@auxilo.io.*

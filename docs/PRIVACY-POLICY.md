# Privacy Policy

**Effective Date: March 17, 2026**
**Last Updated: September 6, 2026**

---

## 1. Information We Collect

This Privacy Policy describes how Auxilo ("we," "us," "our," or the "Platform"), accessible at auxilo.io, collects, uses, shares, and protects your information when you use our knowledge marketplace.

The entity responsible for your personal information (the "data controller") is Auxilo, LLC, a Missouri limited liability company, doing business as Auxilo. You can reach us using the contact details in Section 12.

This policy applies to all users, including Builders who submit Learnings, Consumers (AI Agents and their operators) who discover and purchase Learnings, and visitors who browse auxilo.io. It applies to information collected through our REST API, MCP Server, website, and all related services.

By accessing or using the Platform, you acknowledge that you have read and understood this Privacy Policy. This Privacy Policy is incorporated into and subject to our [Terms of Service](/terms).

### 1.1 Account Information

When you create an account or interact with the Platform, we collect:

- **Email address.** Provided during registration and used for magic link authentication, account communications, security alerts, and notifications about material changes to our Terms or this Privacy Policy.
- **Blockchain wallet address.** If you choose to verify a wallet address (via EIP-712 signature verification) for receiving Builder earnings or making x402 payments, we store your public wallet address. **We never collect, store, or have access to your private keys.**
- **Organization name.** If you register on behalf of an organization, we may collect the organization name associated with your account.

### 1.2 Content and Submission Data

When Builders submit Learnings to the Platform, we collect:

- **Learning content.** The full text, title, body, categories, tags, and any metadata included in the submission.
- **Submission metadata.** Timestamps, quality scores assigned by our automated systems, publication status, sensitivity filter results, and content categorization data.
- **Builder wallet address.** The wallet address associated with each submission, used for earnings attribution and payout settlement.
- **Autonomous extraction Learning drafts.** When Builders enable Autonomous Extraction (ToS §5.9.3), session transcripts are processed locally on the Builder's machine, and the extraction inference step runs through the Builder's own model client under the Builder's own provider terms, the same way the Builder's normal agent sessions run. Our servers do not receive session transcripts, raw or scrubbed. What we collect is the finished Learning draft (title, body, category, tags, task context, and outcome) that the runner submits. An optional server-side extraction path exists in our software but is disabled and not currently active; if it is ever activated, we will update this policy and Section 3.8 first (see Section 7.6).
- **Standing publication consent record.** If a Builder turns on standing publication consent (ToS §5.9.3(g)), we store a record of that choice: the version of the consent text, the timestamp, a truncated IP address, the User-Agent string, and whether the choice was made on the website or through the command line. We also store the quality threshold selected and the Terms version in effect at the time. This record uses the same categories of information described in Section 1.4; it is kept longer than ordinary usage logs because it is evidence of your consent (see Section 4).

**Private Learnings.** If you mark a Learning as private (or keep it private during review), we store its full content the same way as other submissions, but it is never published. Private Learnings may include non-technical content that our public catalog does not accept. They remain associated with your account for owner-only search and recall.

### 1.3 Transaction and Payment Data

When you engage in paid activity on the Platform, we collect:

- **Query and search records.** Discovery queries and knowledge searches you perform, including timestamps, endpoints called, parameters submitted, and results returned.
- **Unlock records.** Which Learnings you have unlocked, when the unlock occurred, and the amount paid.
- **Credit balance activity.** Credit pack purchases, credit consumption events, and remaining balances.
- **Payment records.** Transaction identifiers, amounts, payment method used (x402 or credit balance), settlement status, and blockchain transaction hashes for x402 payments.
- **x402 payment headers.** Protocol-level payment information transmitted with x402 requests, including payer wallet address and payment proof.

### 1.4 Usage and Log Data

We automatically collect certain information when you interact with the Platform:

- **IP address.** Used for security, rate limiting, geographic analysis, and abuse detection. Separately, the IP address and User-Agent captured at the moment you accept the Terms of Service are stored with your account as an evidentiary record of that acceptance and retained for the life of the account (see Section 4).
- **User-Agent string.** The browser or client identifier sent with API requests or web visits, used for compatibility analysis, debugging, and identifying Agent types.
- **Request logs.** API endpoints accessed, HTTP methods, request parameters (excluding sensitive content), response codes, and response times.
- **Timestamps.** The date and time of each request or interaction, in UTC.
- **Referral data.** The URL or source that directed you to the Platform, if available.

### 1.5 Device Data

For visitors accessing auxilo.io through a web browser, we may collect:

- **Operating system and version.**
- **Browser type and version.**
- **Screen resolution and viewport dimensions.**
- **Language preferences.**

Device data is **not collected** from API-only or MCP Server interactions.

### 1.6 Information We Do Not Collect

For clarity, we do not collect:

- Passwords (we use magic link authentication — no passwords exist).
- Private keys or seed phrases.
- Social security numbers or government identification numbers.
- Financial account numbers (bank accounts, credit card numbers) — x402 payments are blockchain-native and credit pack payments are processed by third-party payment processors who handle card data directly.

### 1.7 Withdrawal Notification Waitlist

If you join the waitlist on our status or builder pages to be told when withdrawals open, we collect:

- **Email address.** The address you enter in the signup form.
- **Signup details.** The date and time you joined and which page you signed up from.

We use your email address to notify you when withdrawals go live and to send you occasional updates about that rollout. We do not use it for anything else, we do not sell it, and we do not share it beyond the sub-processors listed in Section 3.8 (our email delivery provider sends the notification). We do not store your IP address with your waitlist entry, and we will not send you marketing emails unless you separately opt in.

You can have your address removed from the waitlist at any time by emailing hello@auxilo.io, and we will delete it.

---

## 2. How We Use Information

We use the information we collect for the following specific purposes:

**Operating the Platform.** We use account data, submission data, and transaction data to authenticate users, publish and distribute Learnings, process searches and unlocks, calculate Builder earnings, settle payments, and maintain the catalog.

**Processing Payments.** We use wallet addresses, transaction records, credit balance data, and x402 payment headers to facilitate micropayments, process credit pack transactions, calculate the Builder Share (70% of direct unlocks, 60% of unlocks surfaced by Auxilo search), and settle Builder payouts.

**Security and Abuse Prevention.** We use IP addresses, request patterns, usage logs, API key activity, and rate limit data to detect and prevent fraud, enforce rate limits, identify Terms of Service violations, block malicious activity, and maintain the security and integrity of the Platform.

**Quality Scoring and Search.** We use aggregated data about searches, unlocks, and content metadata to power our quality scoring algorithms, improve search relevance, rank Learnings in the catalog, and enhance discoverability.

**Content Moderation.** We use submission content, sensitivity filter results, and quality scores to enforce our content standards, detect prohibited content, and maintain catalog quality.

**Communications.** We use your email address to send magic link authentication emails, account notifications (such as payout confirmations), security alerts, and material updates to our Terms of Service or Privacy Policy. **We do not send marketing emails unless you have explicitly opted in.**

**Analytics and Improvement.** We use aggregated, de-identified usage data to understand how the Platform is used, identify performance issues, plan capacity, and improve our services. We do not use individual-level data for this purpose where aggregated data is sufficient.

**Legal Compliance.** We use information as necessary to comply with applicable legal obligations, including responding to lawful requests from government authorities, fulfilling tax reporting requirements, and cooperating with law enforcement when required by law.

---

## 3. Information Sharing

### 3.1 Published Learning Metadata

When a Learning is published on the Platform, the following information is publicly discoverable by any user through the API, MCP Server, or website:

- Learning title, category, and tags.
- Quality score.
- A brief snippet or summary.
- The Builder's wallet address.
- Publication date.

**Full Learning content is accessible only to Consumers who pay to unlock it.**

**Private Learnings are never shared.** A Learning with private visibility is excluded from the public catalog, search results, statistics, pricing inputs, and every buyer-facing surface. It is retrievable only by your authenticated account, is never sold or licensed to anyone, and can become public only through your own explicit resubmission through the standard review process.

### 3.2 Blockchain Transparency

If you use x402 micropayments or verify a wallet address, be aware that wallet addresses and transaction records are recorded on the Base blockchain (an Ethereum Layer 2 network). **Blockchain data is public by nature.** Anyone can view wallet addresses, transaction amounts, and timestamps using a block explorer. Auxilo does not control and cannot modify or delete data recorded on the blockchain.

### 3.3 Service Providers

We share information with trusted third-party service providers who assist us in operating the Platform, including:

- **Hosting and infrastructure providers.** Cloud services that host our servers, databases, and store data on our behalf.
- **Email delivery services.** Services that deliver transactional emails (magic links, notifications) on our behalf. Our transactional email is delivered by Resend, Inc. (see §3.8).
- **Payment infrastructure.** The x402 facilitator service and blockchain infrastructure used to verify and settle micropayments.
- **Content delivery networks.** Services that help deliver API responses and website content efficiently.

These providers are contractually obligated to use your information only to perform services on our behalf and in accordance with this Privacy Policy. We do not permit service providers to use your data for their own purposes.

### 3.4 We Do Not Sell Personal Data

**Auxilo does not sell, rent, lease, or trade your personal data to third parties for advertising, marketing, data brokerage, or any other purpose.** We have never sold personal data and have no plans to do so.

### 3.5 Legal Requirements

We may disclose your information if we believe in good faith that disclosure is reasonably necessary to:

1. Comply with applicable law, regulation, legal process, or enforceable governmental request.
2. Enforce our Terms of Service, including investigation of potential violations.
3. Detect, prevent, or address fraud, security issues, or technical problems.
4. Protect the rights, property, or safety of Auxilo, our users, or the public, as required or permitted by law.

Where legally permitted, we will make reasonable efforts to notify affected users of such disclosures.

### 3.6 Business Transfers

If Auxilo is involved in a merger, acquisition, reorganization, bankruptcy, dissolution, or sale of all or substantially all of its assets, your information may be transferred as part of that transaction. We will provide notice before your information becomes subject to a different privacy policy and, where required by law, seek your consent.

### 3.7 Aggregated and De-Identified Data

We may share aggregated or de-identified data that cannot reasonably be used to identify you. For example, we may publish statistics about total Platform usage, category popularity, or average quality scores. This data is not subject to the restrictions of this Privacy Policy.

### 3.8 Sub-Processors

We engage the following third-party sub-processors to process personal data on our behalf. Each is bound by data processing terms consistent with applicable law:

| Sub-Processor | Purpose | Data Categories Shared |
|---|---|---|
| Anthropic, PBC | Automated sensitivity screening of submitted Learning content before publication, via the Claude API | Submitted Learning text (title, body, tags) only; no session transcripts (extraction runs on the Builder's machine; see Section 7.6) |
| Resend, Inc. | Transactional email delivery (magic-link sign-in emails and account/operational notifications) | Email address and email content, for delivery only |
| Stripe, Inc. | Payment processing for credit pack purchases and Builder withdrawals via Stripe Connect | Email address, payout destination information, transaction amounts |
| Coinbase, Inc. (Base network) | Blockchain settlement of x402 micropayments on the Base Ethereum Layer 2 network | Wallet addresses, transaction amounts, payment proofs (recorded on-chain and inherently public) |

We update this list when sub-processors are added or materially changed. A current list is also available at https://auxilo.io/legal/subprocessors. Notice of such changes will be provided as described in Section 11.

---

## 4. Data Retention

We retain your information for the following periods:

| Data Type | Retention Period | Reason |
|---|---|---|
| Account data (email, wallet address) | Duration of your account + 30 days after deletion request | Account operation and reasonable deletion processing |
| Transaction records (purchases, earnings, payments) | 3 years from transaction date | Audit, compliance, tax reporting, and dispute resolution |
| Submitted Learnings | Indefinite (while published) | Catalog availability per license grant in Terms of Service |
| Usage logs (request IP addresses, User-Agent, request timestamps) | 90 days | Security analysis, abuse detection, and debugging |
| Terms-acceptance consent record (IP address and User-Agent captured at the moment you accepted the Terms) | Life of account + 30 days after deletion request | Evidentiary record of your acceptance of the Terms of Service (including the §5.10 payee-agency appointment), kept for legal and dispute-resolution purposes |
| API keys | Until revoked by you or account termination | Authentication |
| Credit balance records | Duration of account + 3 years | Financial reconciliation |
| Quality score history | Duration of Learning publication | Catalog ranking and integrity |
| Autonomous extraction consent log | Life of account + 3 years | Compliance evidence per ToS §5.9.3(b) |
| Autonomous extraction audit log | 3 years from event date | Audit trail per ToS §5.9.3(f) |
| Standing publication consent record (consent version, timestamp, truncated IP address, User-Agent, accept path, selected quality threshold, Terms version at grant) | Life of account + 3 years | Evidentiary record of your standing publication consent per ToS §5.9.3(g) |
| Extraction transcript hashes | 3 years from extraction date | Traceability and idempotency |
| Conversation upload text (raw) | Deleted after extraction; SHA-256 hash retained indefinitely | Raw text is not stored; hash retained for audit and traceability |
| Extracted Learnings (published) | Indefinite while published; removed within 30 days of verified deletion request | Marketplace availability per license grant |
| Private Learnings (visibility: private) | Until you delete or reject them, or your account is deleted; removed within 30 days of a verified deletion request | Owner-only storage and recall; never published or shared |
| Deletion request audit record (timestamp, pseudonymous account identifier, verification method, counts of removed items — no content, no email address) | 3 years from request date | Compliance evidence that verified deletion requests were fulfilled within the served SLA |

**After the applicable retention period expires, data is permanently deleted or irreversibly anonymized.**

**Exceptions:**

- Data recorded on the Base blockchain cannot be deleted by Auxilo or anyone else (see Section 3.2).
- Consumers who previously unlocked a Learning retain their copy of the content perpetually, regardless of whether the Builder later removes it or deletes their account.
- We may retain data longer if required by applicable law, regulation, or legal proceeding.
- If you have a dispute or claim pending, we will retain relevant data until the matter is resolved.
- Rolling backup copies of our data stores are kept for up to 7 days and then automatically deleted; data you have asked us to delete may persist in those copies for that period and is never restored from them except to recover from data loss, in which case your deletion is re-applied.

---

## 5. Security Measures

We implement technical and organizational measures designed to protect your information, including:

- **Encryption in transit.** All API and web traffic is encrypted via HTTPS (TLS 1.2 or higher). Unencrypted HTTP connections are rejected.
- **Encryption at rest.** Sensitive data stored on our servers is encrypted at rest using industry-standard encryption algorithms.
- **Authentication controls.** API key authentication and EIP-712 wallet-based signature verification control access to authenticated endpoints.
- **Rate limiting.** All endpoints are rate-limited to prevent abuse, brute-force attacks, and denial-of-service attempts.
- **Access controls.** Internal access to user data is restricted to authorized personnel on a need-to-know basis.
- **Minimal data collection.** We collect only information that is necessary to operate the Platform and provide the services described in these Terms.
- **Automated content filtering.** Our sensitivity filter scans submissions for credentials, PII, and other prohibited content before publication.

**No method of electronic transmission or storage is 100% secure.** While we strive to protect your information using commercially reasonable measures, we cannot guarantee absolute security. If you become aware of a security vulnerability or believe your account has been compromised, please notify us immediately at hello@auxilo.io.

---

## 6. Cookies and Tracking

### 6.1 Authentication (No Cookies)

The Platform does **not** set cookies. When you sign in through a web browser at auxilo.io, authentication is handled with a JSON Web Token (JWT) that is stored in your browser's `localStorage` and sent to our servers in an `Authorization` request header. This token is strictly necessary for the authenticated areas of the Platform to function. It is not a cookie, is not transmitted automatically to any other site, and is not used for tracking. The token expires after a set period, and you can clear it at any time by signing out or clearing your browser's site data. Because we set no cookies, no cookie banner or cookie-consent mechanism is required.

### 6.2 No Third-Party Tracking

We do not use:

- Third-party tracking cookies.
- Advertising or retargeting cookies.
- Cross-site tracking mechanisms.
- Fingerprinting or other persistent identification technologies.
- Social media tracking pixels.

### 6.3 No Advertising

Auxilo does not serve advertisements and does not use cookies or any other mechanism for ad targeting, behavioral advertising, or interest-based profiling.

### 6.4 API and MCP Server Access

If you access the Platform exclusively through our REST API or MCP Server, **no cookies are set**. Authentication is handled through API keys or x402 payment headers.

---

## 7. Third-Party Services

The Platform integrates with or relies on certain third-party services. Your interaction with these services is subject to their own terms and privacy policies:

### 7.1 Base Blockchain (Coinbase)

x402 payments are processed on the Base blockchain, an Ethereum Layer 2 network operated by Coinbase. Wallet addresses and transaction data recorded on the blockchain are governed by the blockchain's inherent properties (public, immutable) and are not controlled by Auxilo. See [base.org](https://base.org) for more information.

### 7.2 x402 Facilitator

The x402 protocol uses a facilitator service to verify and settle micropayments. The facilitator processes payment proofs and coordinates settlement on the Base blockchain. We use the public facilitator at facilitator.openx402.ai. See [openx402.ai](https://openx402.ai) for more information.

### 7.3 Hosting and Infrastructure

The Platform is hosted on third-party cloud infrastructure. Your data is stored on servers operated by our hosting providers, who are contractually bound to maintain appropriate security and privacy protections.

### 7.4 Email Delivery

Transactional emails (magic links, notifications) are delivered through Resend, Inc., our third-party email delivery provider (see §3.8). Resend receives your email address and email content solely for the purpose of delivery.

### 7.5 Web Fonts (Self-Hosted)

The auxilo.io website's display fonts (Archivo and IBM Plex Mono) are served from auxilo.io itself. No font request leaves the site, and no third-party font provider receives your IP address or any other visitor data. This affects only the website; API and MCP Server interactions do not load fonts and are unaffected.

### 7.6 LLM Providers (Autonomous Extraction)

When Builders enable Autonomous Extraction (ToS §5.9.3), the extraction inference step runs on the Builder's side, not ours. The Builder's own model client processes the locally scrubbed session transcript under the Builder's own agreement with their model provider, whether that model client is the Builder's coding-client integration or a provider connection the Builder configured directly with their own API key (stored locally, never transmitted to Auxilo). Our servers do not receive session transcripts, raw or scrubbed, and no transcript passes through an LLM subprocessor engaged by Auxilo. The only extraction output transmitted to Auxilo is the finished Learning draft (title, body, category, tags, task context, and outcome).

Our software also contains an optional server-side extraction path. It is disabled by default and is not currently active. If we ever activate it, session transcripts would be processed by an LLM subprocessor on our behalf, and we will update this policy and the sub-processor list in Section 3.8 before doing so. For the current subprocessor list, see §3.8 and https://auxilo.io/legal/subprocessors.

---

## 8. Your Rights

You have the following rights regarding your personal information, subject to applicable law:

### 8.1 Access

You may request a copy of the personal information we hold about you. We will provide this information in a structured, commonly used format within 30 days of a verified request.

### 8.2 Correction

You may request that we correct any inaccurate or incomplete personal information we hold about you.

### 8.3 Deletion

You may request that we delete your personal information. Deletion requests are subject to:

- Our data retention requirements described in Section 4.
- Our inability to delete data recorded on the blockchain (Section 3.2).
- Legal obligations that require us to retain certain data.
- The perpetual license granted to Consumers who have already unlocked your Learnings.

We will process deletion requests within 30 days and confirm completion. Disabling Autonomous Extraction (via account settings or local kill-switch) halts future transcript processing but does not delete Learnings already published; use the retraction right (ToS §5.9.4) to remove published Learnings within the 7-day window.

Transaction records, earnings data, and credit balance history may be retained for up to 3 years from the transaction date as required for tax reporting, audit, and legal compliance purposes, notwithstanding a deletion request.

### 8.4 Data Portability

You may request a copy of your data in a structured, machine-readable format (JSON). Exportable data includes:

- Account information (email, wallet address).
- Submitted Learnings (full content and metadata).
- Transaction history (purchases and unlocks).
- Earnings data (revenue earned and payout history).

### 8.5 Opt-Out of Marketing

If you have opted into marketing communications, you may opt out at any time by:

- Using the unsubscribe link in any marketing email.
- Contacting us at hello@auxilo.io.

Opting out of marketing does not affect transactional communications (magic links, security alerts, payout notifications, or material policy updates).

### 8.6 Restrict Processing

Where permitted by applicable law, you may request that we restrict the processing of your personal information in certain circumstances, such as while we verify the accuracy of your data or assess a deletion request.

### 8.7 How to Exercise Your Rights

To exercise any of these rights, email us at hello@auxilo.io with your request. Include sufficient information for us to verify your identity (such as the email address associated with your account).

Account holders may alternatively exercise the deletion right directly through the authenticated API (see `POST /account/delete-request` in the API documentation); the email path remains available for all requests.

We will respond to your request within **30 days**. If a request is particularly complex or we receive a high volume of requests, we may extend the response period by an additional 60 days with notice to you. We do not charge a fee for reasonable requests.

### 8.8 Additional Rights by Jurisdiction

**California Residents (CCPA/CPRA).** California residents have additional rights under the California Consumer Privacy Act and California Privacy Rights Act, including the right to know what personal information we collect and how it is used, the right to delete, the right to opt out of the sale of personal information (we do not sell personal information), and the right to non-discrimination for exercising your rights.

For transparency, the categories of personal information we collect under the CCPA/CPRA, mapped to the statutory categories, are:

- **Identifiers** — email address, account identifier, IP address, and, if you provide one, organization name.
- **Commercial information** — records of Learnings you unlocked or published, credit pack purchases, credit consumption, earnings, and payout history.
- **Internet or other electronic network activity** — API and web request logs, endpoints accessed, discovery and search queries, User-Agent, and device data collected from web visits.
- **Geolocation data** — coarse (non-precise) geographic inferences derived from IP address for security and abuse detection.
- **Financial / payment-adjacent information** — blockchain wallet address and on-chain transaction data; payout-destination and transaction details processed by our payment processor. We do not collect bank account or card numbers ourselves (see Section 1.6).

Your blockchain **wallet address** is a public identifier. If you verify a wallet or transact via x402, your wallet address and the associated transaction data are recorded on the public Base blockchain and are inherently public and immutable (see Sections 3.2 and 4). We do not collect or store your private keys or seed phrases. We do not use any category of personal information for cross-context behavioral advertising, and we do not sell or share personal information as those terms are defined under the CCPA/CPRA.

**EEA, UK, and Swiss Residents (GDPR/UK GDPR).** If you are located in the European Economic Area, United Kingdom, or Switzerland, you may have additional rights under the General Data Protection Regulation, including the right to lodge a complaint with your local supervisory authority. Our legal basis for processing personal data is typically performance of a contract (these Terms) or legitimate interests (security, abuse prevention, service improvement).

---

## 9. Children's Privacy

The Platform is not directed at, and is not intended for use by, anyone under the age of 18. We do not knowingly collect personal information from individuals under 18 years of age.

If we become aware that we have collected personal information from a person under 18, we will take prompt steps to delete that information and terminate any associated account.

If you believe that a person under 18 has provided us with personal information, please contact us immediately at hello@auxilo.io.

---

## 10. International Data Transfers

Auxilo is operated from the United States. If you are accessing the Platform from outside the United States, your information will be transferred to, stored, and processed in the United States, where data protection laws may differ from those in your country of residence.

By using the Platform, you consent to the transfer of your information to the United States and the processing of your information as described in this Privacy Policy.

**For EEA, UK, and Swiss users:** Where required by applicable law, we rely on appropriate legal mechanisms for international data transfers, which may include standard contractual clauses approved by the European Commission or the UK Information Commissioner's Office.

If you do not consent to the international transfer of your data, you should not use the Platform.

---

## 11. Changes to This Privacy Policy

We may update this Privacy Policy from time to time to reflect changes in our practices, technology, legal requirements, or other factors.

**Material Changes** — such as changes to the categories of data we collect, how we share data, or your rights — require at least **30 days' advance notice** via email to the address associated with your account or by posting a prominent notice on the Platform.

**Non-Material Changes** — such as clarifications, formatting, or grammatical updates — may be made at any time and take effect upon posting.

Your continued use of the Platform after the effective date of any changes constitutes your acceptance of the updated Privacy Policy. If you do not agree with the changes, you must stop using the Platform before they take effect.

The "Last Updated" date at the top of this document indicates when this Privacy Policy was most recently revised.

---

## 12. Contact Information

For questions, concerns, data requests, or complaints regarding this Privacy Policy or our data practices:

**Email:** hello@auxilo.io
**Website:** https://auxilo.io

We aim to respond to all privacy-related inquiries within 30 days.

---

*This Privacy Policy was last updated on September 6, 2026.*

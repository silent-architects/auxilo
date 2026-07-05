# Terms of Service

**Effective Date: March 17, 2026**
**Last Updated: [[DEPLOY-DATE]]**
**Current Amendment: `2026-07-04-payee-agency-a1` — Payment-Collection Agency (Section 5.10), effective [[DEPLOY-DATE]].**

---

## 1. Acceptance of Terms

These Terms of Service ("Terms") constitute a legally binding agreement between you ("you," "your," or "User") and Auxilo ("we," "us," "our," or the "Platform"), accessible at auxilo.io.

By accessing or using the Platform in any capacity — including browsing the website, registering an account, submitting content, purchasing or unlocking Learnings, integrating with our REST API or MCP Server, or making payments through the x402 protocol — you confirm that you have read, understood, and agree to be bound by these Terms and our [Privacy Policy](/privacy).

If you are accessing or using the Platform on behalf of an organization (such as a company, partnership, or other legal entity), you represent and warrant that you have the authority to bind that organization to these Terms. In that case, "you" and "your" refer to both you individually and the organization.

**If you do not agree to these Terms, you must not access or use the Platform.**

---

## 2. Definitions

The following defined terms are used throughout these Terms:

- **"Agent"** — An AI system, software agent, or automated process that accesses the Platform programmatically through the API or MCP Server, typically on behalf of a human operator.
- **"Builder"** (also "Contributor") — A registered user who submits Learnings to the Platform for discovery and purchase by other users.
- **"Consumer"** — Any user — whether human, Agent, or operator — who searches for, discovers, or unlocks Learnings on the Platform.
- **"Credit"** — A unit of prepaid value purchased through the Platform and applied to an account balance. Credits are consumed when using paid Platform features.
- **"Learning"** — A discrete unit of structured operational knowledge submitted by a Builder and published to the Platform catalog. Learnings may include tips, techniques, procedural insights, patterns, and operational knowledge derived from real-world task execution.
- **"MCP Server"** — The Model Context Protocol server provided by Auxilo as an npm package, enabling Agents to interact with the Platform through the MCP standard.
- **"Platform"** — The Auxilo marketplace, including the website at auxilo.io, the REST API, the MCP Server, and all related services, software, and infrastructure.
- **"Unlock"** — The act of purchasing access to the full content of a Learning. Once unlocked, a Consumer receives a perpetual license to the content.
- **"USDC"** — USD Coin, a stablecoin pegged to the U.S. dollar, used for payments on the Base blockchain.
- **"x402"** — The HTTP-native micropayment protocol used by the Platform to facilitate pay-per-request transactions in USDC on the Base blockchain.

---

## 3. Account Registration and Eligibility

### 3.1 Eligibility

You must be at least 18 years of age and have the legal capacity to enter into a binding agreement to use the Platform. By using Auxilo, you represent and warrant that you meet these requirements.

### 3.2 Account Creation

Auxilo uses magic link email authentication. When you register or sign in, we send a one-time authentication link to your email address. There are no passwords to create or manage.

You may also verify a blockchain wallet address using EIP-712 signature verification, which enables you to receive Builder earnings and make payments via the x402 protocol.

### 3.3 API Keys

If you access the Platform programmatically, you will be issued one or more API keys. Your API key is a credential equivalent to a password. You are responsible for keeping it confidential. Do not share, publish, or embed your API key in client-side code, public repositories, or any publicly accessible location.

### 3.4 One Account Per Person

Each individual or organization may maintain one account on the Platform. Creating multiple accounts to circumvent rate limits, manipulate quality scores, or for any other deceptive purpose is prohibited and grounds for immediate termination.

### 3.5 Account Security

You are solely responsible for all activity that occurs under your account, API key, or verified wallet address, whether or not you authorized that activity. You agree to notify us immediately at hello@auxilo.io if you believe your account or credentials have been compromised. Auxilo is not liable for any loss or damage arising from unauthorized use of your credentials.

---

## 4. Description of Service

Auxilo is a knowledge marketplace where human Builders publish structured operational knowledge ("Learnings") and AI Agents and their operators discover, search, and purchase that knowledge through our API, MCP Server, or website.

### 4.1 How It Works

Builders submit Learnings containing operational knowledge derived from real-world task execution. Each submission is automatically quality-scored and, if it passes content and sensitivity filters, published to the catalog. Consumers search the catalog, discover relevant Learnings, and unlock full content by paying the price set by the Builder.

### 4.2 Access Methods

The Platform is accessible through:

- **REST API** — A documented set of HTTP endpoints for programmatic access.
- **MCP Server** — An npm package enabling Agents to interact with the Platform through the Model Context Protocol.
- **Website** — The web interface at auxilo.io for browsing, account management, and Builder workflows.

### 4.3 Discovery and Unlocks

Discovery queries and knowledge searches require a registered account with available credits or an active x402 wallet. Learning unlocks require a funded account with available credits. Auxilo may offer promotional credits or introductory offers at its discretion. Current offers, if any, are displayed in your account dashboard.

### 4.4 Marketplace Facilitator

Auxilo is a marketplace facilitator. We do not create, verify, endorse, or guarantee the accuracy of any Learning published on the Platform. Builders are independent publishers, not employees, contractors, or general agents of Auxilo, except that a Builder appoints Auxilo as its limited payment-collection agent solely as provided in Section 5.10.

---

## 5. Builder Terms

This section applies to users who submit Learnings to the Platform.

### 5.1 Content Ownership

You retain all intellectual property rights in the Learnings you submit to the Platform. Submitting a Learning does not transfer ownership of your content to Auxilo.

### 5.2 License Grant to Auxilo

By submitting a Learning, you grant Auxilo a worldwide, non-exclusive, royalty-free, sublicensable, transferable license to:

- Host, store, reproduce, index, cache, and distribute your Learning through the Platform.
- Display the title, category, tags, quality score, and brief snippet of your Learning in public-facing contexts including the catalog, search results, documentation, and marketing materials.
- Analyze your submission for quality scoring, content categorization, and sensitivity filtering.
- Promote the availability of your Learning to potential Consumers.

This license continues for as long as your Learning remains published on the Platform. It survives with respect to any copies already distributed to Consumers who unlocked the content prior to removal.

**Clarification:** This license does not grant Auxilo the right to sell your content independently or to use the full body of your Learning in marketing materials. Only metadata (title, category, tags, score, snippet) may be used publicly.

### 5.3 License Grant to Consumers

When a Consumer unlocks your Learning, you grant that Consumer a non-exclusive, non-transferable, perpetual license to read, use, and apply the content for their own operational purposes. Consumers may not:

- Redistribute, resell, or publicly republish unlocked content.
- Use unlocked content to train machine learning models specifically designed to replicate or replace the Platform's functionality.
- Claim authorship or ownership of your Learning.

### 5.4 Revenue Share

For each paid unlock transaction, the Builder receives a **"Builder Share"** of the transaction amount, and Auxilo retains the remainder as a platform fee. The Builder Share depends on how the unlock originated:

- **Direct unlocks — 70%.** Where a Consumer unlocks your Learning directly (not via a Platform search or discovery query that surfaced it), the Builder Share is **70%** of the transaction amount and Auxilo's platform fee is 30%.
- **Discovery / search-originated unlocks — 60%.** Where a Consumer unlocks your Learning after the Platform surfaced it through a search or discovery query, the Builder Share is **60%** of the transaction amount and Auxilo's platform fee is 40%. The additional fee on discovery-originated unlocks compensates Auxilo for the discovery and matching function that produced the sale.

This tiered split applies to all unlock transactions regardless of payment method (x402/USDC or credits). Auxilo determines whether an unlock is direct or discovery-originated based on whether the Consumer's session surfaced the Learning through Platform search or discovery within a limited attribution window preceding the unlock.

Changes to either Builder Share percentage or to the platform fee constitute a material change requiring at least **30 days' advance notice** to Builders under Section 17, delivered via email or platform notification.

### 5.5 Pricing

Unlock prices are set by Auxilo's dynamic pricing algorithm based on demand, quality ratings, freshness, and supply factors. Contributors may suggest initial pricing, but final prices are determined algorithmically. Auxilo reserves the right to adjust algorithm parameters and price bounds at any time.

Changes to the platform fee percentage (currently 30%) require at least **30 days' advance notice** to Builders, delivered via email or platform notification.

### 5.6 Earnings and Payouts

Builder earnings are tracked in real time and visible through the Platform's API. Earnings are settled to the Builder's verified wallet address in USDC on the Base blockchain.

Settlement occurs on a periodic basis as determined by Auxilo. We will make reasonable efforts to process settlements promptly, but we are not responsible for delays caused by blockchain congestion, wallet errors, minimum payout thresholds, or other factors outside our control.

**Minimum Payout Threshold.** Auxilo may establish a minimum earnings threshold that must be met before a payout is processed. The current threshold, if any, is published in the API documentation.

**Network (Gas) Costs on Withdrawal.** As provided in Section 7.4, you are responsible for the network transaction ("gas") fees associated with your transactions. This Section 5.6 states how that general responsibility applies to withdrawals of your earnings. On the custodial USDC withdrawal rail currently in operation, the gas cost of settling your earnings on-chain is borne by you and is deducted from your pending balance at the time of withdrawal. Auxilo applies a fixed gas estimate to each withdrawal (currently **USD $0.005** per withdrawal, subject to change on notice under Section 17), and remits to you the net amount after that single deduction; if your balance is insufficient to cover the estimated gas, the withdrawal will not be processed. Where earnings are settled through the Auxilo Split Router's direct-settlement flow (Section 5.10.4(b)), Auxilo bears the on-chain gas cost of that settlement and no gas deduction is applied to your Builder Share on that path. This paragraph is the specific application of Section 7.4 to earnings withdrawals and does not impose any gas charge in addition to the one described here.

**Tax Obligations.** Builders are solely responsible for reporting and paying any taxes applicable to their earnings. Auxilo may request tax documentation (such as W-9 or W-8BEN forms) as required for compliance with applicable tax reporting obligations. Failure to provide requested documentation may result in withholding or suspension of payouts.

### 5.7 Builder Representations and Warranties

By submitting a Learning, you represent and warrant that:

1. You own or have all necessary rights, licenses, and permissions to the content.
2. Your submission does not infringe, misappropriate, or violate any third party's intellectual property, privacy, or other rights.
3. Your submission does not contain credentials, API keys, passwords, tokens, private keys, or other secrets — whether your own or belonging to third parties.
4. Your submission does not contain personally identifiable information about any individual.
5. Your submission complies with all applicable laws, regulations, and these Terms.
6. Your submission is not materially misleading, fraudulent, or deceptive.

### 5.8 Conversation Upload Responsibilities

Builders may submit conversation text to the Platform through the chat history extraction pipeline (`POST /pipeline/upload`) for automated extraction of Learnings. By uploading conversation content, you represent and warrant that:

1. You own or have all necessary rights and permissions to upload the conversation content, including any rights held by other parties to the conversation.
2. You have redacted or removed all personally identifiable information relating to third parties (including names, email addresses, phone numbers, and any other identifying information) from the conversation text prior to upload.
3. The conversation content does not contain credentials, API keys, passwords, tokens, private keys, access credentials, or any other secrets — whether your own or belonging to third parties.
4. You have obtained any consent required by applicable law to process and submit the conversation content.

The Platform employs automated sensitivity scanning on all uploaded conversation content prior to processing. This scanning is a reasonable precaution and does not constitute a guarantee that all sensitive content will be detected. **The builder bears sole responsibility for ensuring uploaded content complies with these requirements, regardless of the outcome of any automated scan.** See Section 9.2 for the general sensitivity filter disclaimer.

### 5.9 Data Processing for Conversation Uploads

When you upload conversation content through the extraction pipeline, the following data handling applies:

#### 5.9.1 Manual Upload Processing

1. **Third-party AI processing.** Uploaded conversation text is transmitted to Anthropic, PBC ("Anthropic") via the Claude API for automated extraction of structured Learnings. By uploading, you consent to this transmission.
2. **Raw text retention.** Raw conversation text is not permanently stored by Auxilo. After extraction is complete, the conversation text is deleted and replaced with a SHA-256 hash of the original content retained solely for audit and traceability purposes.
3. **Extracted Learnings.** Learnings extracted from uploaded conversations are subject to a quality review before publication. Extracted content is presented to you for review and approval; it is not published to the marketplace without your explicit approval.
4. **Marketplace publication.** Upon your approval, extracted Learnings are published to the Platform catalog and subject to all other Builder Terms in this Section 5, including Section 5.7 (representations and warranties).

#### 5.9.2 Third-Party AI Processing

The Platform uses third-party large language model providers to process uploaded conversation content. At the effective date of these Terms, the sole such provider is **Anthropic, PBC**, accessed via the Claude API under commercial terms that prohibit Anthropic from using submitted data for model training. For the current list of subprocessors, see the Privacy Policy and https://auxilo.io/legal/subprocessors.

#### 5.9.3 Autonomous Learning Extraction

The Platform offers an autonomous extraction feature ("Autonomous Extraction") that allows Builders to enable continuous, hands-off generation of Learnings from their AI session transcripts. When enabled, supported client integrations transmit redacted session transcripts to Auxilo's `/extract` endpoint, where Auxilo's extraction pipeline analyzes the transcript and publishes qualifying Learnings to the catalog under the Builder's account. A current list of supported client integrations is maintained at https://auxilo.io/legal/supported-clients.

**(a) Default behavior and trigger modes.** Autonomous Extraction is the Platform's default contribution mechanism for users who activate it. Builders may select among three trigger modes:

- **Automatic** (default): transcripts are processed at the conclusion of each qualifying session.
- **Scheduled**: transcripts are processed in batches on a recurring schedule selected by the Builder.
- **Manual**: extraction runs only when the Builder explicitly invokes it.

A Builder may change trigger modes or disable Autonomous Extraction at any time through the kill-switch mechanism described in subsection (e).

**(b) Initial consent and continued use.** Autonomous Extraction is disabled by default and is activated only by an affirmative Builder action. At the moment of activation, the Builder's consent to the terms of this Section 5.9.3 is recorded in a durable, versioned consent log retained by Auxilo for the life of the account plus three (3) years. Subsequent updates to these Terms governing Autonomous Extraction take effect under the change-of-terms mechanism in Section 17, and the Builder's continued use of the feature after the effective date of any update constitutes acceptance of the updated terms. Auxilo will provide notice of material changes in the manner described in Section 17.

**(c) Builder responsibility for transcript content; Auxilo compensating controls.** The Builder is solely responsible for the contents of any session transcript submitted under Autonomous Extraction, including any personally identifiable information, credentials, third-party data, or confidential information contained therein. The representations and warranties in Sections 5.7 and 5.8 apply to all transcripts submitted via Autonomous Extraction with the same force as if the Builder had manually uploaded them. As a compensating control and not as a substitute for Builder responsibility, Auxilo applies (i) a client-side redaction pass before transmission, (ii) a server-side sensitivity rescan on receipt, and (iii) a Platform-defined category allowlist constraining the topics on which Learnings may be autonomously published. These controls are reasonable precautions and not a guarantee.

**(d) AI subprocessor.** Auxilo processes Autonomous Extraction transcripts using one or more third-party large language model providers acting as Auxilo's subprocessors. At the effective date of these Terms, the sole such subprocessor is **Anthropic, PBC**, accessed via the Claude API. Auxilo may add, replace, or remove subprocessors over time and will maintain a current list in the Privacy Policy and at https://auxilo.io/legal/subprocessors. By enabling Autonomous Extraction, the Builder authorizes Auxilo to transmit redacted transcript content to its current subprocessor(s) for the sole purpose of Learning extraction.

**(e) Kill-switch and revocation.** A Builder may disable Autonomous Extraction at any time, by either (1) removing the local activation sentinel on the machine running the Builder's client, or (2) toggling Autonomous Extraction off in the Builder's account settings on auxilo.io. Either action halts further transmission of new transcripts and revokes Auxilo's authorization to process additional transcripts under this subsection. Disablement does not affect Learnings already published, the validity of Consumer unlocks already completed, or earnings already accrued. The retraction right in Section 5.9.4 governs removal of already-published Learnings.

**(f) Audit log.** Auxilo retains an audit log of each Autonomous Extraction event — including session identifier hash, trigger mode, timestamp, subprocessor invoked, quality-gate result, and publication or rejection outcome — for a period of three (3) years.

#### 5.9.4 Retraction Right; No Clawback of Completed Unlocks

**(a) Seven-day retraction window.** A Builder may retract any Learning published via Autonomous Extraction for a period of seven (7) calendar days following its publication date. Retraction is effected by request through the Platform's catalog management interface or by email to hello@auxilo.io identifying the Learning. Upon a valid retraction request, Auxilo will remove the Learning from public discovery, search results, and the catalog API within a commercially reasonable time.

**(b) After the retraction window.** Following the seven-day window, autonomously-published Learnings are subject to the same removal mechanisms as any other published Learning, including the DMCA/notice-and-takedown processes referenced in Section 5 and Section 9.

**(c) No clawback; no refund.** Retraction removes a Learning from the catalog on a forward-going basis only. It does **not** reverse, refund, or unwind any unlock transaction completed prior to retraction. Consumers who unlocked the Learning before retraction retain the perpetual license described in Section 5.3 and Section 6.4. Builder earnings already accrued from pre-retraction unlocks remain payable on the normal settlement schedule and are not subject to clawback.

**(d) Relationship to transaction finality.** This subsection is consistent with, and does not alter, the transaction-finality rule in Section 7.3.

### 5.10 Appointment of Auxilo as Limited Payment-Collection Agent

#### 5.10.1 Appointment and Scope

By accepting these Terms and by submitting any Learning for which you may earn a revenue share, you ("Builder") appoint Auxilo — SLAM Agency LLC, a [[STATE — V-1: fill from formation docs before deploy]] limited liability company doing business as Auxilo ("Auxilo") — as your limited agent for the sole and exclusive purpose of receiving, on your behalf, payment of the Builder Share (as defined in Section 5.4) owed to you by Consumers who unlock your Learnings.

This appointment is limited to the collection and receipt of the Builder Share. It does **not** authorize Auxilo to act as your agent for any other purpose, and specifically does not authorize Auxilo to:

- incur obligations in your name;
- make representations or warranties on your behalf;
- set, negotiate, or waive the price a Consumer pays (which is governed by Section 5.5);
- bind you to any agreement with any Consumer or third party; or
- act as your agent with respect to any matter other than receipt of the Builder Share.

#### 5.10.2 Receipt by Agent Is Payment to Builder (Payment-Extinguishment)

**Payment of the Builder Share to Auxilo, in its capacity as your limited collection agent, constitutes payment to you.** A Consumer's obligation to pay for an unlock of your Learning is fully satisfied and extinguished at the moment Auxilo (or, where applicable, the settlement mechanism described in Section 5.10.4) receives the unlock payment — whether or not, and regardless of when, Auxilo remits the Builder Share to you.

Accordingly:

- The Consumer bears **no** risk that you will not receive your Builder Share; once Auxilo receives payment, that risk is between you and Auxilo.
- Any failure, delay, or shortfall by Auxilo in remitting the Builder Share to you is a matter solely between you and Auxilo and does **not** revive, reinstate, or create any payment obligation of the Consumer to you.

#### 5.10.3 No Trust, No Fiduciary Deposit, No Custodial Duty

The appointment in this Section 5.10 creates an agency for collection only. It does **not** create a trust, escrow, fiduciary deposit, or bailment, and it does **not** impose on Auxilo any duty to segregate, hold in trust, safeguard as a custodian, or account for the Builder Share as trust property. With respect to any Builder Share received by Auxilo and not yet remitted, the relationship between you and Auxilo is that of **creditor (you) and debtor (Auxilo)**, not beneficiary and trustee.

Nothing in this Section 5.10 modifies the independent-contractor relationship in Section 20.5, and no partnership, joint venture, employment, or general agency is created by this Section.

#### 5.10.4 Payment Rails and Settlement Flows

This Section 5.10 applies to all Builder Share payments across the rails Auxilo supports, under whichever settlement flow is in effect at the time of the unlock.

**(a) x402 / USDC rail — custodial flow (the currently-operated default).** Where a Consumer pays in USDC via the x402 protocol and settlement is directed to Auxilo's platform wallet, Auxilo receives the full unlock amount as your collection agent as to the Builder Share portion, and in its own right as to the platform fee. Auxilo's receipt of the Builder Share into the platform wallet is payment to you under Section 5.10.2, and Auxilo thereafter holds the Builder Share as your debtor under Section 5.10.3 until settlement to your verified wallet under Section 5.6. This custodial flow is the rail currently in operation.

**(b) x402 / USDC rail — direct-settlement flow via the Auxilo Split Router (buyer-attested receive path only).** Where, and only where, an unlock is settled through the Auxilo Split Router's buyer-attested receive path — a settlement in which the Builder Share destination and split are cryptographically bound to the authorization the Consumer signed (an on-chain contract that, in a single transaction, transfers the Builder Share directly to your verified wallet and the platform fee to Auxilo's fee wallet) — the Builder Share is settled directly to your verified wallet and does not enter an Auxilo-controlled address on that path. On that buyer-attested receive path, receipt by your wallet is receipt by you, and the Consumer's obligation is extinguished at that on-chain receipt.

The direct-settlement representation in this Section 5.10.4(b) is limited to the buyer-attested receive path described above. Auxilo also operates, or may operate, other Split Router settlement paths (including a transfer path for interoperability with generic payment clients and a recovery path for stranded funds) on which Auxilo, acting as settler, retains operational discretion over settlement parameters. Auxilo does not represent, and you should not understand, that the Builder Share is incapable of diversion on those other paths. On any path other than the buyer-attested receive path, Auxilo receives the Builder Share as your collection agent under Section 5.10.1, and the custodial characterization in Section 5.10.4(a) and the creditor/debtor characterization in Section 5.10.3 apply.

**(c) Fiat / credits rail.** Where a Consumer's unlock is funded by prepaid credits and the Builder Share is settled to you via the Platform's fiat payout mechanism (currently Stripe Connect), Auxilo receives the credit-funded Builder Share as your collection agent, holds it as your debtor under Section 5.10.3, and remits it via the licensed payout partner. Nothing in this Section makes Auxilo the transmitter of the fiat payout; that function is performed by the licensed payment partner.

#### 5.10.5 Fee-Netting and Authorized Deductions

You authorize Auxilo, as your collection agent, to deduct and retain Auxilo's platform fee (the portion of the unlock price that is not the Builder Share, as set out in Section 5.4) from amounts received, and to remit to you only the net Builder Share. This netting is an accounting convenience and a term of the marketplace commission arrangement; it does not convert the platform fee into funds held on your behalf, and it does not enlarge the agency beyond collection of the Builder Share.

You further authorize Auxilo to deduct, before remittance, any amounts you owe Auxilo or that Auxilo is required to withhold, including: (i) the network (gas) cost of your USDC withdrawal, to the extent that cost is borne by you as disclosed in Section 5.6; (ii) minimum-threshold and rounding adjustments; and (iii) any tax withholding required under Section 5.6 or applicable law.

#### 5.10.6 Irrevocability During Pendency

This appointment is **irrevocable with respect to any unlock transaction that has been initiated or completed while the appointment is in effect**, and with respect to any Builder Share already received by Auxilo, until that Builder Share has been remitted to you. This limited irrevocability protects the finality of the Consumer's discharge under Section 5.10.2: because a Consumer's payment obligation is extinguished upon Auxilo's receipt as your agent, that discharge cannot be unwound by revocation of the agency after the fact. You may terminate the appointment on a going-forward basis as provided in Section 5.10.7, but such termination does not affect (i) the extinguishment of any Consumer's obligation that already occurred under Section 5.10.2, or (ii) Auxilo's authority and obligation to complete collection and remittance of Builder Share already accrued.

#### 5.10.7 Termination and Effect on Accrued Amounts

You may revoke this appointment prospectively by closing your account (Section 14.1) or by written notice to hello@auxilo.io. Upon revocation or account termination:

- The appointment ceases to apply to unlocks initiated **after** the effective time of revocation.
- Builder Share already accrued (whether already received by Auxilo or arising from unlocks initiated before revocation) remains payable to you and will be settled in accordance with Section 5.6 and Section 14.3, and the payment-extinguishment rule of Section 5.10.2 continues to apply to those transactions.
- Revocation does not entitle you to any Consumer payment directly; extinguished Consumer obligations are not revived.

#### 5.10.8 Survival

Sections 5.10.2 (payment-extinguishment), 5.10.3 (no trust), 5.10.5 (fee-netting and authorized deductions as to accrued amounts), 5.10.6 (irrevocability during pendency), and this Section 5.10.8 survive any termination or expiration of these Terms or of your account, with respect to all Builder Share and unlock transactions arising while the appointment was in effect.

---

## 6. Agent and Consumer Terms

This section applies to users who search for, discover, or unlock Learnings on the Platform.

### 6.1 Permitted Use

You may use the Platform to search for, discover, and unlock Learnings for your own legitimate operational purposes. You may integrate the Platform into your workflows using the API or MCP Server.

### 6.2 Agent Operators

If you operate an Agent that accesses the Platform, you are responsible for all activity conducted by that Agent, including compliance with these Terms, rate limits, and payment obligations. The acts and omissions of your Agent are treated as your own.

### 6.3 Fair Use

You agree to use the Platform in good faith and within reasonable usage patterns. The following are prohibited:

- Systematically downloading, scraping, or bulk-extracting Learnings or catalog data beyond what the API provides.
- Using automated tools to circumvent rate limits.
- Accessing the Platform in a manner that degrades performance for other users.
- Reselling, redistributing, or publicly republishing unlocked content.

### 6.4 Unlocked Content

Once you unlock a Learning, you receive a perpetual, non-exclusive, non-transferable license to use the content for your own operational purposes, subject to the restrictions in Section 5.3. Unlocked content is yours to keep — it will not be revoked if the Builder later removes the Learning from the catalog.

---

## 7. Payment Terms

### 7.1 Payment Methods

The Platform supports two payment methods:

**x402 Micropayments.** Real-time payments in USDC on the Base blockchain via the x402 protocol. No Auxilo account is required for x402 payments — payment is verified at the protocol level. Each API request that requires payment includes the x402 payment header, and payment is settled atomically with the request.

**Credit Packs.** Registered users may purchase prepaid credit packs ($10, $25, or $100 denominations) that are applied to their account balance. Credits are consumed as you use paid Platform features. Credit pack purchases are processed through standard payment methods as offered on the Platform.

### 7.2 Credit Terms

- Prepaid credits are **non-refundable** and **non-transferable**.
- Credits have no cash value outside the Platform and cannot be redeemed for currency.
- Credits **do not expire**.
- Auxilo reserves the right to modify credit pack pricing and denominations with 30 days' notice.

### 7.3 Transaction Finality

All transactions on the Platform are final. Consumed credits, completed unlock transactions, and discovery queries are **non-refundable**. This includes:

- Credits spent on Learnings that do not meet your expectations.
- Queries or searches that return no results.
- Duplicate purchases made in error.

If you believe a transaction was made due to a Platform error or involved fraudulent activity on our end, contact us at hello@auxilo.io. We will review the matter on a case-by-case basis, but we are under no obligation to issue a refund.

### 7.4 Blockchain Transactions

You acknowledge and agree that:

- Transactions on the Base blockchain are **public, irreversible, and immutable**. Auxilo cannot reverse, cancel, or modify a confirmed blockchain transaction.
- Blockchain transactions are subject to network fees ("gas fees") that are separate from and in addition to Platform fees. You are responsible for gas fees associated with your transactions.
- Auxilo is not responsible for failed transactions due to insufficient gas, network congestion, smart contract errors, or errors in wallet addresses you provide.
- You are solely responsible for the accuracy and security of your wallet address.

### 7.5 Taxes

You are solely responsible for determining and paying any taxes applicable to your use of the Platform, including income taxes on Builder earnings and sales or value-added taxes on purchases. Auxilo does not provide tax advice. Auxilo does not withhold taxes unless required by applicable law.

---

## 8. Intellectual Property

### 8.1 Platform Ownership

Auxilo and its licensors own all rights, title, and interest in and to the Platform, including but not limited to:

- The REST API, MCP Server, website, and all related software and infrastructure.
- Quality scoring algorithms, content categorization systems, and sensitivity filters.
- Documentation, design, trademarks, logos, and trade dress.
- All improvements, modifications, and derivative works of the foregoing.

These Terms do not grant you any right, title, or interest in the Platform itself, except for the limited right to use it in accordance with these Terms.

### 8.2 Builder Content

Builders retain ownership of the Learnings they submit, subject to the license grants in Section 5.

### 8.3 Consumer Content

Consumers who unlock Learnings receive a license to use the content as described in Section 5.3 and Section 6.4. No ownership is transferred.

### 8.4 Restrictions

You may not:

1. Reverse engineer, decompile, disassemble, or otherwise attempt to derive the source code of the Platform or any component thereof.
2. Modify, adapt, translate, or create derivative works based on the Platform's software.
3. Copy, reproduce, or distribute any part of the Platform except as expressly permitted by these Terms.
4. Remove, alter, or obscure any proprietary notices, labels, or marks on the Platform.
5. Use Auxilo's name, logo, trademarks, or brand elements without prior written consent.
6. Frame or mirror the Platform or any portion of it on any other website or service.

### 8.5 Feedback

If you provide suggestions, ideas, enhancement requests, or other feedback about the Platform ("Feedback"), you grant Auxilo a perpetual, irrevocable, worldwide, royalty-free, fully sublicensable license to use, modify, incorporate, and commercialize that Feedback without any obligation, attribution, or compensation to you.

---

## 9. Content Standards and Prohibited Content

Learnings submitted to the Platform must comply with the following content standards. You agree that your submissions will not contain:

### 9.1 Prohibited Content Categories

- **Credentials and Secrets.** API keys, passwords, tokens, private keys, access credentials, connection strings, or any authentication material — whether your own or belonging to third parties.
- **Personally Identifiable Information (PII).** Names, email addresses, phone numbers, physical addresses, social security numbers, government IDs, financial account numbers, or any information that could identify a specific individual.
- **Malicious Content.** Malware, exploit code, phishing templates, social engineering scripts, or any content designed to facilitate unauthorized access to systems or data.
- **Illegal Content.** Content that violates applicable law, promotes illegal activity, or facilitates the violation of any third party's legal rights.
- **Infringing Content.** Content that infringes or misappropriates any third party's copyrights, trademarks, trade secrets, patents, or other intellectual property rights.
- **Spam and Low-Value Content.** Auto-generated, duplicated, or deliberately low-quality content designed to game quality scores or inflate catalog presence.
- **Harmful or Deceptive Content.** Content that is materially misleading, fraudulent, defamatory, or designed to deceive Consumers about its nature, quality, or origin.

### 9.2 Sensitivity Filter

The Platform employs an automated sensitivity filter designed to detect and block prohibited content categories before publication. While we make reasonable efforts to prevent harmful content from being published, no automated system is perfect. **Builders remain solely responsible for ensuring their submissions comply with these Terms**, regardless of whether the sensitivity filter flagged the content.

### 9.3 Reporting Violations

If you encounter content on the Platform that you believe violates these content standards, please report it to hello@auxilo.io with the Learning identifier and a description of the concern.

---

## 10. Platform Rights

### 10.1 Content Moderation

Auxilo reserves the right to review, moderate, and take action on any content on the Platform. We may, at our sole discretion and without prior notice:

- Remove, disable access to, or decline to publish any Learning that violates these Terms.
- Adjust or override quality scores that we determine have been manipulated.
- Flag, quarantine, or restrict content pending manual review.

We are not obligated to monitor all content, but we reserve the right to do so.

### 10.2 Quality Scoring

All submitted Learnings are automatically quality-scored by the Platform's algorithms. Quality scores affect discoverability and ranking in search results. Auxilo may adjust scoring algorithms, weights, and ranking criteria at any time without notice. Quality scores do not constitute an endorsement or verification of accuracy by Auxilo.

### 10.3 Platform Modifications

Auxilo may modify, update, or discontinue any feature, endpoint, or aspect of the Platform at any time. For material changes that affect existing functionality relied upon by users (such as API endpoint deprecation), we will make reasonable efforts to provide advance notice through our documentation or API response headers.

### 10.4 Enforcement

Auxilo may investigate suspected violations of these Terms and may take any action we deem appropriate, including:

- Issuing warnings.
- Temporarily suspending access.
- Permanently terminating accounts.
- Removing content.
- Reporting violations to law enforcement.
- Pursuing available legal remedies.

---

## 11. API Usage and Rate Limits

### 11.1 Rate Limits

The Platform enforces rate limits on API and MCP Server requests to ensure fair access for all users. Current rate limits are published in the API documentation and may be adjusted at any time. If you exceed rate limits, your requests will receive HTTP 429 responses until the limit resets.

### 11.2 Prohibited API Practices

In addition to the general acceptable use provisions in Section 6.3, the following API-specific practices are prohibited:

- Sharing API keys between multiple users, organizations, or applications without authorization.
- Using multiple API keys to circumvent rate limits.
- Making automated requests at a volume or frequency that degrades Platform performance.
- Accessing undocumented or internal endpoints.
- Interfering with the Platform's infrastructure, load balancers, or security mechanisms.

### 11.3 API Availability

Auxilo makes commercially reasonable efforts to maintain API availability but does not guarantee any specific uptime percentage. The Platform may experience planned or unplanned downtime for maintenance, updates, or other operational reasons. We will make reasonable efforts to provide advance notice of planned maintenance.

---

## 12. Disclaimers and Limitation of Liability

### 12.1 Disclaimer of Warranties

THE PLATFORM IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED. TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, AUXILO DISCLAIMS ALL WARRANTIES, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, AND ANY WARRANTIES ARISING OUT OF COURSE OF DEALING OR USAGE OF TRADE.

WITHOUT LIMITING THE FOREGOING, AUXILO MAKES NO WARRANTY OR REPRESENTATION THAT:

1. THE PLATFORM WILL BE UNINTERRUPTED, TIMELY, SECURE, OR ERROR-FREE.
2. THE RESULTS OBTAINED FROM USE OF THE PLATFORM WILL BE ACCURATE, RELIABLE, OR COMPLETE.
3. ANY LEARNING PUBLISHED ON THE PLATFORM IS ACCURATE, TRUTHFUL, CURRENT, OR FIT FOR ANY PARTICULAR PURPOSE.
4. THE PLATFORM WILL MEET YOUR REQUIREMENTS OR EXPECTATIONS.
5. ANY DEFECTS IN THE PLATFORM WILL BE CORRECTED.

LEARNINGS ARE USER-GENERATED CONTENT CREATED BY INDEPENDENT BUILDERS. AUXILO DOES NOT VERIFY, AUDIT, OR ENDORSE THE ACCURACY, LEGALITY, OR QUALITY OF ANY LEARNING. YOU USE AND RELY ON LEARNINGS ENTIRELY AT YOUR OWN RISK. NO EARNINGS, REVENUE, OR INCOME FROM USE OF THE PLATFORM IS GUARANTEED.

### 12.2 Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL AUXILO, ITS OFFICERS, DIRECTORS, EMPLOYEES, AGENTS, AFFILIATES, SUCCESSORS, OR ASSIGNS BE LIABLE FOR ANY:

- INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES;
- LOSS OF PROFITS, REVENUE, GOODWILL, DATA, USE, OR OTHER INTANGIBLE LOSSES;
- COST OF PROCURING SUBSTITUTE SERVICES;
- DAMAGES ARISING FROM UNAUTHORIZED ACCESS TO OR ALTERATION OF YOUR TRANSMISSIONS OR DATA;
- DAMAGES ARISING FROM THE CONDUCT OF ANY THIRD PARTY ON THE PLATFORM;

ARISING OUT OF OR IN CONNECTION WITH YOUR ACCESS TO OR USE OF (OR INABILITY TO ACCESS OR USE) THE PLATFORM, WHETHER BASED ON WARRANTY, CONTRACT, TORT (INCLUDING NEGLIGENCE), STATUTE, OR ANY OTHER LEGAL THEORY, AND WHETHER OR NOT AUXILO HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

### 12.3 Aggregate Liability Cap

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, AUXILO'S TOTAL AGGREGATE LIABILITY TO YOU FOR ALL CLAIMS ARISING OUT OF OR RELATING TO THESE TERMS OR YOUR USE OF THE PLATFORM SHALL NOT EXCEED THE GREATER OF:

1. THE TOTAL AMOUNT YOU PAID TO AUXILO IN THE TWELVE (12) MONTHS IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO THE CLAIM; OR
2. ONE HUNDRED U.S. DOLLARS ($100).

FOR USERS WHO HAVE NEVER MADE A PAYMENT TO AUXILO, THE TOTAL AGGREGATE LIABILITY CAP IS FIFTY U.S. DOLLARS ($50).

### 12.4 Basis of the Bargain

THE LIMITATIONS AND EXCLUSIONS IN THIS SECTION APPLY REGARDLESS OF THE FORM OF ACTION, EVEN IF AUXILO HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES, AND EVEN IF A REMEDY FAILS OF ITS ESSENTIAL PURPOSE. YOU ACKNOWLEDGE THAT THESE LIMITATIONS ARE AN ESSENTIAL ELEMENT OF THE AGREEMENT BETWEEN YOU AND AUXILO AND THAT AUXILO WOULD NOT PROVIDE THE PLATFORM WITHOUT THESE LIMITATIONS.

SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OR LIMITATION OF CERTAIN DAMAGES, SO SOME OF THE ABOVE LIMITATIONS MAY NOT APPLY TO YOU. IN SUCH JURISDICTIONS, AUXILO'S LIABILITY IS LIMITED TO THE GREATEST EXTENT PERMITTED BY LAW.

---

## 13. Indemnification

### 13.1 Your Indemnification Obligations

You agree to indemnify, defend, and hold harmless Auxilo, its officers, directors, employees, agents, affiliates, successors, and assigns from and against any and all claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees and court costs) arising out of or relating to:

1. Your use of the Platform, including any activity under your account or API key.
2. Learnings or other content you submit through the Platform.
3. Your violation of these Terms or any applicable law, regulation, or third-party right.
4. Your violation of any intellectual property, privacy, publicity, or other proprietary right of any third party.
5. Any dispute between you and another user of the Platform.
6. Your Agent's activity on the Platform, if you are an Agent operator.

### 13.2 Procedure

Auxilo reserves the right, at your expense, to assume the exclusive defense and control of any matter for which you are required to indemnify us. You agree to cooperate with our defense of such claims. You agree not to settle any matter without Auxilo's prior written consent.

### 13.3 Survival

This indemnification obligation survives the termination of your account and these Terms.

---

## 14. Termination

### 14.1 Termination by You

You may stop using the Platform at any time. To formally close your account, contact us at hello@auxilo.io or use the account management functionality in the API. Termination of your account does not relieve you of any obligations incurred prior to termination, including payment obligations. Unused prepaid credits are non-refundable upon termination.

### 14.2 Termination by Auxilo

Auxilo may suspend or terminate your account, restrict your access to the Platform, or revoke your API key at any time and for any reason, including but not limited to:

- Violation of these Terms or our content standards.
- Submission of prohibited content.
- Fraudulent, deceptive, or abusive activity.
- Failure to provide requested tax documentation.
- Legal or regulatory requirements.
- Extended inactivity (12 months or more with no API activity or sign-in).
- Activity that threatens the security, integrity, or performance of the Platform.

We will make reasonable efforts to provide notice before termination, except where immediate action is necessary to prevent harm to the Platform, its users, or third parties.

### 14.3 Effect of Termination

Upon termination of your account:

1. Your right to access and use the Platform ceases immediately.
2. Your API keys are revoked and will no longer authenticate.
3. Any pending Builder earnings will be settled to your verified wallet address within **30 days**, subject to applicable minimum payout thresholds, tax withholding requirements, and verification of your wallet address.
4. Unused credits are forfeited and non-refundable.
5. Learnings you submitted may remain in the catalog and continue to be available to Consumers pursuant to the license granted in Section 5.2. You may request removal of unpurchased Learnings prior to or after termination.
6. Consumers who previously unlocked your Learnings retain their perpetual license to the content.

### 14.4 Survival

The following sections survive any termination or expiration of these Terms: Section 2 (Definitions), Section 5 (Builder Terms — license grants, representations, and the limited payment-collection agency and its survival, netting, irrevocability, and payment-extinguishment provisions in Section 5.10), Section 7.3 (Transaction Finality), Section 8 (Intellectual Property), Section 12 (Disclaimers and Limitation of Liability), Section 13 (Indemnification), Section 15 (Dispute Resolution), Section 16 (Governing Law), and Section 20 (Entire Agreement).

---

## 15. Dispute Resolution

### 15.1 Informal Resolution

Before initiating any formal dispute resolution proceeding, you agree to first contact us at hello@auxilo.io and attempt to resolve the dispute informally for at least **30 days**. Your notice must include your name or organization, account information, a description of the dispute, and the specific relief you seek.

### 15.2 Binding Arbitration

If we cannot resolve the dispute informally within 30 days, either party may initiate binding arbitration administered by the American Arbitration Association ("AAA") under its Commercial Arbitration Rules then in effect. The arbitration will be conducted by a single arbitrator in the English language. Unless the parties agree otherwise, the arbitration shall be held in the State of Delaware or conducted remotely via video conference.

The arbitrator's decision shall be final and binding, and judgment on the award may be entered in any court of competent jurisdiction. The arbitrator shall have the authority to award any relief that a court of competent jurisdiction could award, including injunctive relief and attorneys' fees where authorized by law.

### 15.3 Class Action Waiver

**YOU AND AUXILO AGREE THAT EACH PARTY MAY BRING CLAIMS AGAINST THE OTHER ONLY IN YOUR OR ITS INDIVIDUAL CAPACITY AND NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY PURPORTED CLASS, CONSOLIDATED, OR REPRESENTATIVE PROCEEDING.** The arbitrator may not consolidate more than one person's or entity's claims and may not preside over any form of class, consolidated, or representative proceeding.

### 15.4 Exceptions to Arbitration

Notwithstanding the above, either party may:

1. Bring an individual action in small claims court if the claim qualifies under that court's jurisdictional limits.
2. Seek injunctive or other equitable relief in a court of competent jurisdiction to prevent the actual or threatened infringement, misappropriation, or violation of intellectual property rights.

### 15.5 Costs and Fees

Each party shall bear its own attorneys' fees and costs in connection with arbitration, except:

- If the arbitrator determines that a claim was frivolous or brought in bad faith, the arbitrator may award reasonable attorneys' fees and costs to the prevailing party.
- Filing fees shall be allocated in accordance with the AAA's rules.

---

## 16. Governing Law

These Terms shall be governed by and construed in accordance with the laws of the State of Delaware, United States, without regard to its conflict of law provisions. To the extent that any lawsuit or court proceeding is permitted under these Terms, you and Auxilo consent to the exclusive jurisdiction of the state and federal courts located in Delaware for all disputes not subject to arbitration.

---

## 17. Changes to Terms

Auxilo reserves the right to modify these Terms at any time. We will classify changes as either material or non-material:

**Material Changes** — including changes to pricing, the revenue split percentage, payment terms, dispute resolution procedures, or limitation of liability — require at least **30 days' advance notice** via email to the address associated with your account or by posting a prominent notice on the Platform.

**Non-Material Changes** — such as clarifications, formatting updates, or changes that do not substantively alter your rights or obligations — may be made at any time and take effect upon posting.

Your continued use of the Platform after the effective date of any modification constitutes your acceptance of the modified Terms. If you do not agree to the modified Terms, you must stop using the Platform before the changes take effect.

We encourage you to review these Terms periodically. The "Last Updated" date at the top of this document indicates when these Terms were most recently revised.

---

## 18. Contact Information

For questions, concerns, legal notices, or requests regarding these Terms:

**Email:** hello@auxilo.io
**Website:** https://auxilo.io

All legal notices must be sent to hello@auxilo.io with "Legal Notice" in the subject line. Notices to you will be sent to the email address associated with your account.

---

## 19. Severability

If any provision of these Terms is found to be unenforceable, invalid, or illegal by a court or arbitrator of competent jurisdiction, that provision shall be modified to the minimum extent necessary to make it enforceable, or if modification is not possible, it shall be severed from these Terms. The invalidity or unenforceability of any provision shall not affect the validity or enforceability of the remaining provisions, which shall remain in full force and effect.

---

## 20. Entire Agreement

### 20.1 Complete Agreement

These Terms, together with the [Privacy Policy](/privacy) and any other policies expressly referenced herein, constitute the entire agreement between you and Auxilo regarding your use of the Platform. These Terms supersede all prior and contemporaneous agreements, proposals, representations, and understandings, whether written or oral, relating to the subject matter herein.

### 20.2 No Waiver

The failure of Auxilo to enforce any right or provision of these Terms shall not constitute a waiver of that right or provision. A waiver of any term shall be effective only if in writing and signed by an authorized representative of Auxilo.

### 20.3 Assignment

You may not assign or transfer these Terms, or any rights or obligations hereunder, without the prior written consent of Auxilo. Any attempted assignment without consent is void. Auxilo may assign these Terms freely, including in connection with a merger, acquisition, corporate reorganization, or sale of all or substantially all of its assets, without your consent.

### 20.4 Force Majeure

Auxilo shall not be liable for any delay or failure to perform any obligation under these Terms where the delay or failure results from causes beyond our reasonable control, including but not limited to: natural disasters, war, terrorism, civil unrest, labor disputes, government actions, pandemic or epidemic, blockchain network failures or congestion, internet service disruptions, power outages, or third-party service provider outages. Payment obligations are not excused by force majeure events.

### 20.5 Independent Contractors

The relationship between you and Auxilo is that of independent contractors. Nothing in these Terms creates a partnership, joint venture, employment, or fiduciary relationship between you and Auxilo. Except for the limited payment-collection agency expressly created in Section 5.10, nothing in these Terms creates any agency relationship between you and Auxilo, and that limited agency does not make either party the general agent of the other for any purpose beyond the collection of the Builder Share as provided in Section 5.10.

### 20.6 Electronic Agreement

You consent to receiving these Terms and all related communications electronically. You agree that all agreements, notices, disclosures, and other communications provided electronically satisfy any legal requirement that such communications be in writing.

### 20.7 Headings

Section headings are for convenience and reference only and shall not affect the interpretation or construction of these Terms.

---

*These Terms of Service were last updated on [[DEPLOY-DATE]]. Current amendment: 2026-07-04-payee-agency-a1.*

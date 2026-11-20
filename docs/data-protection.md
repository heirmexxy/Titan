# Data protection: Titan (and what StorageX adds)

Working notes for Kitovu's compliance under the Nigeria Data Protection Act 2023 (NDPA) and the NDPC's General Application and Implementation Directive 2025 (GAID). This is not legal advice. Confirm the current rules, thresholds and fees on [ndpc.gov.ng](https://ndpc.gov.ng) or with a data protection compliance organisation before filing.

## 1. Does Kitovu have to register with the NDPC?

Organisations of "major importance" must register. As published guidance describes it, that covers organisations that process the personal data of more than 200 people within six months, or that work in listed sectors such as ICT services and finance. Registration is tiered by the number of people whose data is processed:

| Tier | People (within six months) | Registration fee as published |
|---|---|---|
| Ordinary-High Level (OHL) | more than 200, fewer than 1,000 | ₦10,000 |
| Extra-High Level (EHL) | 1,000 to 5,000 | ₦100,000 |
| Ultra-High Level (UHL) | more than 5,000 | ₦250,000 |

**For Kitovu:** the Accion pilot (1,000–5,000 farmers on StorageX), the Abia ADDS farmer records and Kitovu's ICT services together very likely put Kitovu in a registrable tier, probably EHL now and UHL as StorageX grows. Register **Kitovu Technology Company Limited** as one organisation covering all its products (Titan, StorageX, WareGuard, Agristore, eProcure and others), rather than registering each product.

**Steps**
1. Count the people whose data Kitovu holds across all products in the last six months, to pick the tier.
2. Appoint a Data Protection Officer: a named person, or an outside compliance organisation, reachable at a dedicated address (for example `dpo@kitovu.com.ng`).
3. Register on the NDPC portal: company details, DPO details, the tier, and the processors you use (section 3). Pay the fee.
4. Diary the yearly obligations: renewal, and the Compliance Audit Return filed through a licensed Data Protection Compliance Organisation.

## 2. Titan's record of processing

| Activity | People | Data | Kitovu's role | Kept for |
|---|---|---|---|---|
| User accounts (admin, ops, client, verifier) | Staff of Kitovu, clients, verifiers | Name, email, phone, password hash, sign-in IP and time | Controller | While active + 12 months |
| WareGuard monitoring | Warehouse staff (indirectly: motion, door events) | Sensor readings, site location | Controller | Plan retention |
| Client devices | Client staff and customers (indirect) | Readings, device location | Processor | Client's retention setting |
| PAYG | Appliance customers | Name, phone, email, customer ref, payments, credit dates | Processor (client is controller) | While account active + 6 years for payment records |
| Lots and quality tests | Farmers, field staff | Farmer or cluster name, origin GPS, results, recorder | Processor, or controller for Kitovu's own lots | As agreed with the client; Kitovu's own: 6 years |
| Carbon evidence | Field staff, verifiers | Names in measurements, verifier accounts | Processor for project owners | As the registry requires |
| Billing | Client contacts | Billing email, invoices, card brand and last 4 (card held by Paystack) | Controller | 6 years |
| Monitoring and security | Everyone signing in | IP addresses, audit log | Controller | 12 months |

**Processors Titan uses:** Hostinger (hosting), Resend (email), Termii (SMS), Paystack (payments), Anthropic (optional message and report writing). Keep each one's data processing terms on file. For Resend and Anthropic, which process data outside Nigeria, record the transfer basis (contractual safeguards).

## 3. What is in place now

- **Privacy notice** at `titan.kitovu.com.ng/privacy`, linked from the landing and sign-up pages.
- **Security:** encryption in transit, hashed secrets, organisation-scoped access, an audit log, signed device data, an internal security review (`docs/security-review.md`), daily backups with an off-server copy.
- **Data minimisation:**
  - The public pay page shows only the customer's first name.
  - Exports are limited to the requester's organisation.
  - Data shared with others goes only through grants limited by site, metric and dates, and every access is logged.
- **Deletion:** readings expire by retention setting; test devices and their data can be removed (`device:delete`).

## 4. Still to do (with owners)

1. **NDPC registration and DPO** (Kitovu management): see section 1.
2. **Data processing agreement for clients** (legal): a short DPA attached to Titan's terms, since Kitovu processes client data, for example PAYG customers.
3. **DPIA for StorageX** (product): StorageX holds farmers' identity, bank details and loans for Accion. That is high-risk processing that needs a Data Protection Impact Assessment before the pilot. Titan itself holds little personal data.
4. **Farmer consent and notice in local languages** (StorageX field team): tell farmers at intake, in Yoruba, Hausa, Igbo or Pidgin, what is recorded and who sees it (Accion).
5. **Requests from individuals:** handle requests to see or delete data within 30 days. Log each request.
6. **Breach procedure:** if a breach risks people's rights, notify the NDPC within 72 hours. The Titan watchdog and audit log help detect one; name who decides and who notifies.

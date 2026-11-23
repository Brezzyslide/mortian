# Contracts and signing

An asset is handed over only after the contract is signed by the borrower, every guarantor and a company manager, in that order. Activation is refused before that (`requireSignedContract`, which production cannot turn off).

## Flow

1. **Template.** A manager writes a template version; a *different* manager approves it, recording the legal review. Approved wording can never change. A new version retires the old one.
2. **Guarantors.** The underwriter adds guarantors (Nigerian mobile, not the borrower's number). The tier decides how many are required.
3. **Issue.** The underwriter issues the contract. It is rendered from the latest approved template and the account's frozen terms. The exact values used are stored, and the SHA-256 of the text is fixed. The borrower gets an SMS link.
4. **Borrower signs** on the signing page: reads the full text, gets an OTP on their phone, acknowledges each key term separately, confirms intention, types a name and/or draws a signature.
5. **Guarantors sign**, each with their own link, sent only after the previous signer finishes. They see their maximum liability.
6. **Manager countersigns** from the console (never the borrower themselves).
7. **Execution.** Three files are written once to the contracts archive (S3 Object Lock): the agreement text (the signed original, whose hash every signer saw), a PDF copy with a signature page, and an execution certificate (every signer's evidence, every event, and the PDF's hash). After execution the database refuses any change to these pointers and hashes. The account becomes `contracted`.

## Safeguards

| Risk | Control |
| --- | --- |
| Borrower signs for the guarantor | Guarantor link and OTP go only to the guarantor's phone. A guarantor signing from the borrower's device is **refused** and the contract is flagged. Same network is flagged for review |
| Signer sees different wording than was issued | Signing sends back the hash the page displayed; a mismatch is refused |
| Link forwarded or reused | Links are single-use, expire after 72 hours, stored only as hashes, and travel in the URL fragment (`#…`, never sent to a server). Staff can resend, which kills the old link |
| OTP guessing | 5 attempts, 5-minute expiry, 3 sends per 15 minutes, plus the WAF limit on `/v1/sign/*` |
| Signing out of order | Each signer's link is created only when it is their turn |
| Wording changed after issue | The database refuses edits to a contract's text, values or hash, and to a closed contract's status |
| Evidence tampered | Contract events are append-only; the archive is write-once with S3 checking the SHA-256 on upload |

The SHA-256 values prove the document has not changed since signing. They are **not** a qualified digital signature or a trusted timestamp. The certificate says so.

## Evidence per signer

IP, user agent, hashed device id, document hash shown, each acknowledged term with its exact text, intention-to-sign, typed name, hash of the drawn signature (the image is kept in the database, up to 300 KB), OTP verification time and signing time.

## Routes

| Method | Path | Who |
| --- | --- | --- |
| GET/POST | `/admin/contracts/templates/:product` | underwriter, manager (view); manager (create) |
| POST | `/admin/contracts/templates/:id/approve` `{ legalReviewNote }` | a manager other than the author |
| POST | `/admin/contracts/seed-placeholder-template` | super_admin |
| GET/POST | `/admin/contracts/accounts/:ref/guarantors` | underwriter (add) |
| DELETE | `/admin/contracts/guarantors/:id` | underwriter, before issue |
| POST | `/admin/contracts/accounts/:ref/issue` | underwriter |
| GET | `/admin/contracts/accounts/:ref` | staff: contracts, signer progress, flags |
| POST | `/admin/contracts/:id/countersign` | manager |
| POST | `/admin/contracts/:id/revoke` `{ reason }`, `/resend-link` | manager; underwriter or manager |
| GET | `/admin/contracts/:id/archive/agreement`, `/pdf`, `/certificate` | staff |
| POST | `/sign/view`, `/sign/otp`, `/sign/verify`, `/sign/complete`, `/sign/decline` | public, token in body |

## Placeholder template

`PLACEHOLDER_MOTORCYCLE_TEMPLATE` exists only to run the flow end to end. **It has not been reviewed by a lawyer.** Every contract issued from it is marked `isPlaceholder`, and the text says so at the top. Replace it with counsel-approved wording (create a new version and have a second manager approve it) before any real agreement.

## Signing page

`apps/sign`, served at `/sign/`. Built for low-cost Android phones (about 75 KB gzipped).

- The link token is read from the `#fragment` (never sent to servers in a URL, never in logs). It is kept for the tab only and removed from the address bar.
- A random device id is kept on the phone and sent with the signature. The server stores its hash. A guarantor using the borrower's phone is refused with a plain explanation.
- The signer must scroll to the end before continuing. They confirm the SMS code, tick every key term, confirm intention and type their name. Drawing a signature is optional.
- Declining asks for a reason and cancels the agreement.
- Placeholder agreements show a warning banner on every step.

## The PDF

Rendered on A4 with Noto Sans embedded in full (SIL Open Font License, `packages/contracts/fonts/OFL.txt`), so Yoruba, Igbo and Hausa letters (ọ ẹ ṣ ị ụ, with tone marks) and the ₦ sign print exactly. Contents: the full text, a page footer (reference, contract id, page *i* of *n*, the document hash), and a signature page with each signer's role, name, masked phone, signing time, typed name and drawn signature. About 650 KB per agreement. Rendering is repeatable: the same input produces the same bytes.

- The font is embedded whole, not subset: pdf-lib's subsetting dropped letters when tested.
- Characters the font lacks (emoji) become `?`. The text file holds the exact characters and is the signed original.
- A damaged signature image never blocks execution. The PDF notes it, and the image's hash is in the certificate.

## Not yet built

- Sending the borrower a copy of the executed PDF (SMS link or WhatsApp) once a messaging provider is chosen. Until then the signing page tells signers to ask the team for a copy.

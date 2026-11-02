# Configuration

## myDATA Purchases

Public QR retrieval for supported providers requires no credentials; its visible UI option is remembered in browser storage and can be disabled for offline use. Local extraction requires no AI keys; optional per-extraction AI assistance reuses `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` only after explicit consent. Originals use `DATA_DIR/mydata/`; the generated `DATA_DIR/.mydata.key` must be recovered separately from backups. Company settings are entered in the tool. Optional `MYDATA_TESSERACT_PATH` and `MYDATA_TESSDATA_DIR` configure local OCR lookup. Restart the backend after installing OCR/language data. Optional AADE RequestDocs reads use separate private connection slots; see below. No AADE write methods are available. See [myDATA Purchases](tools/mydata-invoices.md).

Optional authenticator-based 2FA is configured from **Security** in the app, without provider keys or fees. Authentication state uses `data/.auth.key`, which must be backed up separately and shared by all backend workers. See [setup and recovery](operations/two-factor-authentication.md).

Optimus reads private configuration from a root `.env` file. The file is ignored by Git.

## Core Settings

```env
DATABASE_URL=postgresql://optimus:optimus@localhost:5432/optimus
OPTIMUS_ACCESS_KEY=your-login-password
OPTIMUS_PUBLIC_API_KEY=your-public-api-key
OPTIMUS_API_KEY=legacy-or-shared-api-key
FRONTEND_ORIGIN=http://localhost:5173
SESSION_TTL_SECONDS=43200
```

`OPTIMUS_ACCESS_KEY` defaults to `optimus` in local development.

Public API authentication uses the first configured value from:

1. `OPTIMUS_PUBLIC_API_KEY`
2. `OPTIMUS_API_KEY`
3. `OPTIMUS_ACCESS_KEY`

## AI Provider Keys

```env
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_MODEL=your-default-anthropic-model
OPENAI_API_KEY=your-openai-api-key
```

Provider keys are optional until a tool needs them.

## Knowledge Expert

```env
KNOWLEDGE_EXPERT_CHAT_MODEL=your-chat-model
KNOWLEDGE_EXPERT_EMBED_MODEL=text-embedding-3-small
```

Knowledge Expert stores entries even without an OpenAI key. Without embeddings, retrieval falls back to keyword matching.

## Usage Reports

```env
ANTHROPIC_ADMIN_KEY=your-anthropic-admin-api-key
OPENAI_ADMIN_KEY=your-openai-admin-api-key
```

The token usage tool uses admin/reporting keys, not normal model-call keys.

Keep optional integration keys documented here when new integrations are added.

## Sticky Notes encryption key

Sticky Notes generates a random key at `data/.sticky-notes.key` on the first save, with file mode `0600`. There is no provider dependency or password prompt. The key is excluded from Git and the application backup; back it up separately in secure storage. Existing notes and backups cannot be recovered without their original key. See [Sticky Notes](tools/sticky-notes.md) for recovery and limitations.

## Read-only AADE connections

There are three fixed connection slots, each with independent `PROD` and `TEST` credentials. Configure only the pairs you use in private `.env`:

```env
MYDATA_SLOT_1_PROD_USER_ID=
MYDATA_SLOT_1_PROD_SUBSCRIPTION_KEY=
MYDATA_SLOT_1_PROD_VAT_NUMBER=
```

Use the same suffixes for `MYDATA_SLOT_2_PROD_…` and `MYDATA_SLOT_3_PROD_…`. Sandbox credentials use `MYDATA_SLOT_1_TEST_…` (and slots 2/3). `.env.example` lists every supported name. `VAT_NUMBER` is the ΑΦΜ of the owner of those API credentials. It receives Greek structural/checksum validation. Restart Optimus after changes; configuration is loaded once per backend process.

In each company profile choose its connection and access type, then **Save company**. Direct access requires the configured credential-owner ΑΦΜ to match the company ΑΦΜ. Authorised representative access sends that company's ΑΦΜ as `entityVatNumber`; the actual authority must exist in AADE. Accountant details are not required. A representative slot may be reused for multiple represented companies. The backend imports only records whose returned recipient ΑΦΜ matches the selected company.

No secret values or usernames are sent to the browser, persisted in jobs, exported, logged, included in backups or passed to AI. The UI reports configured/missing and a safe read outcome only. No credential mutation API exists. Test/production slots never fall back to each other. Missing credentials disable AADE reads for that connection while local uploads/editing still work. Changing the taxpayer identity of a profile with remote evidence is blocked to preserve company scoping.

The only authenticated remote route is GET `RequestDocs` on the fixed production/test AADE hosts; even other GET methods such as cancellation are unreachable through this connector. There are no write-enablement flags or submission routes in this release.

### AADE access denied while testing

**Test connection** means a read-only connection check; it does not select the sandbox. The connection saved in the company profile chooses the environment. Normal myDATA production credentials belong in a `PROD` slot with **Production** selected. The sandbox requires its own registration and test credentials; copying production values into a `TEST` slot does not register them there. See [AADE test environment](https://www.aade.gr/en/mydata-electronic-books/mydata/test-environment).

A 401 is reported as an environment-specific credential rejection. Check the myDATA REST API username/subscription key rather than TAXISnet login credentials, and restart after `.env` edits. A 403 is reported separately as a read-permission problem; representative access additionally needs AADE authorisation for that company. Diagnostic response bodies and secrets are never displayed. Selecting Production does not enable writes.

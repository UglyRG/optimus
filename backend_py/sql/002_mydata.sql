-- Preparation workspace v1. No submission/approval records are created by this release.
CREATE TABLE IF NOT EXISTS mydata_companies (
  id text PRIMARY KEY,
  facts jsonb NOT NULL,
  revision text NOT NULL
);
CREATE TABLE IF NOT EXISTS mydata_documents (
  id text PRIMARY KEY,
  company_id text NOT NULL REFERENCES mydata_companies(id),
  sha256 text NOT NULL,
  facts jsonb NOT NULL,
  UNIQUE(company_id, sha256),
  UNIQUE(id, company_id)
);
CREATE TABLE IF NOT EXISTS mydata_invoices (
  id text PRIMARY KEY,
  company_id text NOT NULL REFERENCES mydata_companies(id),
  document_id text UNIQUE,
  review_month text NOT NULL,
  facts jsonb NOT NULL,
  revision text NOT NULL,
  FOREIGN KEY(document_id, company_id) REFERENCES mydata_documents(id, company_id)
);
CREATE INDEX IF NOT EXISTS mydata_invoices_period_idx ON mydata_invoices(company_id, review_month, id);
CREATE TABLE IF NOT EXISTS mydata_audit_events (
  id text PRIMARY KEY,
  company_id text NOT NULL REFERENCES mydata_companies(id),
  entity_id text NOT NULL,
  facts jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS mydata_extractions (
  id text PRIMARY KEY,
  company_id text NOT NULL REFERENCES mydata_companies(id),
  invoice_id text NOT NULL REFERENCES mydata_invoices(id),
  facts jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','completed','failed','cancelled')),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mydata_extractions_active_idx
ON mydata_extractions(invoice_id) WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS mydata_extractions_queue_idx ON mydata_extractions(state, created_at);

CREATE INDEX IF NOT EXISTS mydata_extractions_invoice_idx ON mydata_extractions(invoice_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS mydata_invoices_company_scope_idx ON mydata_invoices(id, company_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mydata_extractions_company_invoice_fk'
                 AND conrelid='mydata_extractions'::regclass) THEN
    ALTER TABLE mydata_extractions ADD CONSTRAINT mydata_extractions_company_invoice_fk
      FOREIGN KEY (invoice_id, company_id) REFERENCES mydata_invoices(id, company_id);
  END IF;
END $$;

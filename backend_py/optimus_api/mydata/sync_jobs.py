"""Durable month/page read jobs. Commit evidence and continuation state atomically."""
import hashlib
import json
import logging
import threading
from uuid import uuid4

from fastapi import HTTPException

from ..utils import now_iso
from . import domain
from .aade import configured_connection, connection_options, month_range, request_docs, ReadError
from .aade_xml import parse_page
from .intake import Intake

logger = logging.getLogger(__name__)


class SyncJobs:
    def __init__(self, repo, settings):
        self.repo, self.settings = repo, settings
        self.intake = Intake(repo)
        self.stopping = threading.Event()
        self.thread = None

    @staticmethod
    def present(row):
        if not row:
            return None
        return {'id': row['id'], 'state': row['state'], **{k: v for k, v in row['facts'].items() if k not in {'responses', 'seenTokens', 'token', 'companyRevision'}}}

    def status(self, company_id):
        domain.identifier(company_id)
        with self.repo.store.pool.connection() as conn:
            company = self.repo.require_company(conn, company_id)
            row = conn.execute('SELECT * FROM mydata_sync_jobs WHERE company_id=%s ORDER BY created_at DESC,id DESC LIMIT 1', (company_id,)).fetchone()
            pending = conn.execute("SELECT count(*) AS n FROM mydata_remote_records WHERE company_id=%s AND invoice_id IS NULL AND facts->>'reviewMonth'<>''", (company_id,)).fetchone()['n']
            last = conn.execute("SELECT facts->>'completedAt' AS at FROM mydata_sync_jobs WHERE company_id=%s AND state='completed' AND facts->>'mode'='sync' AND facts->>'alias'=%s ORDER BY created_at DESC LIMIT 1", (company_id, company['facts'].get('readConnection', ''))).fetchone()
        error = None
        try:
            configured_connection(self.settings, company['facts'])
        except HTTPException as exc:
            error = exc.detail
        return {'connections': connection_options(self.settings), 'ready': error is None, 'configurationMessage': error,
                'pendingMatching': pending, 'job': self.present(row), 'lastCompletedAt': last['at'] if last else None, 'writesEnabled': False}

    def queue(self, company_id, payload, actor, mode='sync'):
        domain.identifier(company_id)
        months = month_range(payload.get('start'), payload.get('end'))
        with self.repo.store.pool.connection() as conn, conn.transaction():
            self.repo.lock(conn)
            company = self.repo.require_company(conn, company_id)
            if company['revision'] != payload.get('companyRevision'):
                raise HTTPException(409, 'Company settings changed. Reload before syncing.')
            config = configured_connection(self.settings, company['facts'])
            active = conn.execute("SELECT * FROM mydata_sync_jobs WHERE company_id=%s AND state IN ('queued','running')", (company_id,)).fetchone()
            if active:
                return self.present(active)
            job_id = str(uuid4())
            facts = {'mode': mode, 'months': months, 'monthIndex': 0, 'pages': 0, 'responseBytes': 0, 'imported': 0, 'changed': 0, 'skipped': 0,
                     'token': None, 'seenTokens': [], 'responses': [], 'companyRevision': company['revision'],
                     'alias': config['alias'], 'environment': config['environment'], 'requestedBy': actor,
                     'requestedAt': now_iso(), 'progress': 'Waiting to read AADE'}
            conn.execute("INSERT INTO mydata_sync_jobs(id,company_id,facts,state) VALUES (%s,%s,%s::jsonb,'queued')", (job_id, company_id, json.dumps(facts)))
            self.repo.audit(conn, company_id, company_id, 'aade_read_queued', actor, {'jobId': job_id, 'mode': mode, 'months': months, 'environment': config['environment']})
        return {'id': job_id, 'state': 'queued', **{k: v for k, v in facts.items() if k not in {'responses','seenTokens','token','companyRevision'}}}

    def cancel(self, company_id, job_id, actor):
        domain.identifier(company_id); domain.identifier(job_id)
        with self.repo.store.pool.connection() as conn, conn.transaction():
            self.repo.lock(conn)
            row = conn.execute('SELECT id FROM mydata_sync_jobs WHERE id=%s AND company_id=%s', (job_id, company_id)).fetchone()
            if not row:
                raise HTTPException(404, 'Sync not found')
            conn.execute("UPDATE mydata_sync_jobs SET state='cancelled',lease_until=NULL,facts=facts||%s::jsonb WHERE id=%s AND state IN ('queued','running')", (json.dumps({'progress': 'Cancelled. Previously committed pages remain available.'}), job_id))
            self.repo.audit(conn, company_id, company_id, 'aade_read_cancelled', actor, {'jobId': job_id})
        return self.status(company_id)

    def claim(self):
        with self.repo.store.pool.connection() as conn, conn.transaction():
            self.repo.lock(conn)
            conn.execute("UPDATE mydata_sync_jobs SET state='failed',lease_until=NULL,facts=facts||%s::jsonb WHERE state='running' AND lease_until<now()", (json.dumps({'progress': 'Interrupted read. Start a new sync; saved pages will be deduplicated.'}),))
            row = conn.execute("SELECT * FROM mydata_sync_jobs WHERE state='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED").fetchone()
            if row:
                conn.execute("UPDATE mydata_sync_jobs SET state='running',lease_until=now()+interval '120 seconds' WHERE id=%s", (row['id'],))
        return row

    def process(self, job):
        try:
            facts = job['facts']
            with self.repo.store.pool.connection() as conn:
                company = self.repo.require_company(conn, job['company_id'])
            if company['revision'] != facts['companyRevision']:
                raise ReadError('Company settings changed. Start a new sync.')
            config = configured_connection(self.settings, company['facts'])
            month = facts['months'][facts['monthIndex']]
            content = request_docs(config, month, facts['token'])
            if self.stopping.is_set():
                return
            page = parse_page(content, config['targetVat'])
            if any(record['reviewMonth'] != month for record in page['records']):
                raise ReadError('AADE returned purchases outside the requested month. No cursor was advanced.')
            token_hash = hashlib.sha256(json.dumps(page['token'], sort_keys=True).encode()).hexdigest() if page['token'] else None
            if token_hash and token_hash in facts['seenTokens']:
                raise ReadError('AADE repeated a continuation token. Start a new sync later.')
            if facts.get('responseBytes', 0) + len(content) > 64 * 1024 * 1024:
                raise ReadError('This sync reached the 64 MiB evidence limit. Use a smaller month range; saved pages remain available.')
            if facts['pages'] >= 1000:
                raise ReadError('This sync reached 1,000 pages. Use a smaller month range; saved pages remain available.')
            with self.repo.store.pool.connection() as conn, conn.transaction():
                self.repo.lock(conn)
                current = conn.execute("SELECT id FROM mydata_sync_jobs WHERE id=%s AND state='running'", (job['id'],)).fetchone()
                company = self.repo.require_company(conn, job['company_id'])
                if not current:
                    return  # Cancelled or restored while a GET was in flight.
                if company['revision'] != facts['companyRevision']:
                    raise ReadError('Company settings changed. Start a new sync.')
                imported, changed = (0, 0) if facts['mode'] == 'test' else self.intake.ingest(conn, job['company_id'], config['environment'], page, month, facts['requestedBy'])
                facts['responseBytes'] = facts.get('responseBytes', 0) + len(content)
                facts['pages'] += 1
                facts['imported'] += imported
                facts['changed'] += changed
                facts['skipped'] += page['skipped']
                facts['responses'].append({'page': facts['pages'], 'month': month, 'hash': page['responseHash'],
                    'encryptedXml': self.intake.encrypt_response(content, job['id'], facts['pages']), 'receivedAt': now_iso()})
                facts['token'] = page['token']
                if token_hash:
                    facts['seenTokens'].append(token_hash)
                else:
                    facts['monthIndex'] += 1
                    facts['seenTokens'] = []
                completed = facts['mode'] == 'test' or facts['monthIndex'] == len(facts['months'])
                if completed:
                    facts['completedAt'] = now_iso()
                    facts['progress'] = 'Connection read succeeded. No purchases imported.' if facts['mode'] == 'test' else 'Sync complete. Review imported purchases and any matching conflicts.'
                else:
                    facts['progress'] = f"Read {facts['pages']} pages · {facts['monthIndex']} of {len(facts['months'])} months complete"
                conn.execute('UPDATE mydata_sync_jobs SET facts=%s::jsonb,state=%s,lease_until=NULL WHERE id=%s', (json.dumps(facts), 'completed' if completed else 'queued', job['id']))
                self.repo.audit(conn, job['company_id'], job['company_id'], 'aade_read_page', facts['requestedBy'],
                                {'jobId': job['id'], 'page': facts['pages'], 'month': month, 'responseHash': page['responseHash'], 'imported': imported, 'changed': changed})
        except Exception as exc:
            message = str(exc) if isinstance(exc, ReadError) else exc.detail if isinstance(exc, HTTPException) else 'The AADE intake failed. Saved pages remain available; start a new sync to retry.'
            with self.repo.store.pool.connection() as conn, conn.transaction():
                self.repo.lock(conn)
                conn.execute("UPDATE mydata_sync_jobs SET state='failed',lease_until=NULL,facts=facts||%s::jsonb WHERE id=%s AND state='running'", (json.dumps({'progress': message}), job['id']))

    def start(self):
        self.stopping.clear()
        def worker():
            while not self.stopping.is_set():
                try:
                    job = self.claim()
                    if job:
                        self.process(job)
                    else:
                        self.stopping.wait(1)
                except Exception:
                    logger.warning('myDATA intake worker could not access local storage')
                    self.stopping.wait(3)
        self.thread = threading.Thread(target=worker, daemon=True, name='mydata-read-worker')
        self.thread.start()

    def stop(self):
        self.stopping.set()
        if self.thread:
            self.thread.join(timeout=2)

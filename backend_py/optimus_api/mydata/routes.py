"""Session-only APIs. Read-only AADE intake; there is no AADE submit endpoint."""
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response

from .repository import MAX_FILE
from .extraction_jobs import ExtractionJobs
from .preview import preview
from .sync_jobs import SyncJobs
from . import classifications


def build_router(repo, require_session, settings, extraction_jobs=None, sync_jobs=None):
    jobs = extraction_jobs or ExtractionJobs(repo, settings)
    reads = sync_jobs or SyncJobs(repo, settings)
    def no_cache(response: Response):
        response.headers["Cache-Control"] = "no-store"

    router = APIRouter(prefix="/api/tools/mydata-invoices", dependencies=[Depends(require_session), Depends(no_cache)])

    def mutation(request: Request, session=Depends(require_session)):
        origin = request.headers.get("origin")
        same_origin = str(request.base_url).rstrip("/")
        if request.headers.get("sec-fetch-site") == "cross-site" or (origin and origin not in {settings.frontend_origin, same_origin}):
            raise HTTPException(403, "This request must originate from Optimus")
        return session

    @router.get("/classification-options")
    def classification_options():
        return classifications.options(repo)

    @router.get("/companies/{company_id}/invoices/{invoice_id}/classification-options")
    def invoice_classification_options(company_id: str, invoice_id: str):
        return classifications.options(repo, company_id, invoice_id)

    @router.get("/companies")
    def companies():
        return {"companies": repo.companies(), "stage": "read-only-intake", "aadeReads": True, "aadeWrites": False}

    @router.post("/companies")
    def save_company(payload: dict, session=Depends(mutation)):
        return {"company": repo.save_company(payload, session["name"])}

    @router.get("/companies/{company_id}/invoices")
    def invoices(company_id: str, start: str, end: str, offset: int = Query(0, ge=0), status: str = "all"):
        return repo.invoices(company_id, start, end, offset, status)

    @router.post("/companies/{company_id}/invoices")
    def save_invoice(company_id: str, payload: dict, session=Depends(mutation)):
        return {"invoice": repo.save_invoice(company_id, payload, session["name"])}

    @router.delete("/companies/{company_id}/invoices/{invoice_id}")
    def delete_upload(company_id: str, invoice_id: str, payload: dict, session=Depends(mutation)):
        return repo.delete_upload(company_id, invoice_id, payload.get("revision"), session["name"])

    @router.post("/companies/{company_id}/documents")
    async def upload(company_id: str, reviewMonth: str = Form(...), file: UploadFile = File(...), lookupQr: bool = Form(False), session=Depends(mutation)):
        try:
            data = await file.read(MAX_FILE + 1)
            # PDF/image parsing and database access run outside the event loop.
            from starlette.concurrency import run_in_threadpool
            result = await run_in_threadpool(repo.upload, company_id, reviewMonth, file.filename or "document", data, session["name"])
            if not result["duplicate"]:
                try:
                    result["extraction"] = await run_in_threadpool(jobs.queue, company_id, result["invoice"]["id"],
                                                                 {"revision": result["invoice"]["revision"], "lookupQr": lookupQr}, session["name"])
                except HTTPException:
                    result["extractionWarning"] = "Original saved. Open Review to start extraction manually."
            return result
        finally:
            await file.close()

    @router.post("/companies/{company_id}/invoices/{invoice_id}/document")
    async def attach_original(company_id: str, invoice_id: str, revision: str = Form(...), file: UploadFile = File(...), lookupQr: bool = Form(False), session=Depends(mutation)):
        from starlette.concurrency import run_in_threadpool
        try:
            data = await file.read(MAX_FILE + 1)
            result = await run_in_threadpool(repo.upload, company_id, "2000-01", file.filename or "document", data,
                                            session["name"], {"id": invoice_id, "revision": revision})
            try:
                result["extraction"] = await run_in_threadpool(jobs.queue, company_id, invoice_id,
                    {"revision": result["invoice"]["revision"], "lookupQr": lookupQr}, session["name"])
            except HTTPException:
                result["extractionWarning"] = "Original saved. Start extraction manually in Review."
            return result
        finally:
            await file.close()

    @router.get("/companies/{company_id}/documents/{document_id}/content")
    def content(company_id: str, document_id: str):
        data, facts = repo.document(company_id, document_id)
        return Response(data, media_type=facts["mime"], headers={"Cache-Control": "no-store",
                        "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline"})

    @router.get("/companies/{company_id}/documents/{document_id}/metadata")
    def metadata(company_id: str, document_id: str):
        _, facts = repo.document(company_id, document_id)
        return {key: facts[key] for key in ("filename", "mime", "pages", "bytes")}

    @router.get("/companies/{company_id}/documents/{document_id}/preview")
    def document_preview(company_id: str, document_id: str, page: int = Query(1, ge=1, le=30)):
        data, facts = repo.document(company_id, document_id)
        if page > facts["pages"]:
            raise HTTPException(404, "Page not found")
        rendered, mime = preview(data, facts["mime"], page)
        return Response(rendered, media_type=mime, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    @router.get("/companies/{company_id}/invoices/{invoice_id}/history")
    def history(company_id: str, invoice_id: str):
        return {"events": repo.history(company_id, invoice_id)}

    @router.get("/extraction-capabilities")
    def extraction_capabilities():
        return jobs.capabilities()

    @router.get("/companies/{company_id}/invoices/{invoice_id}/extractions")
    def latest_extraction(company_id: str, invoice_id: str):
        return {"extraction": jobs.get(company_id, invoice_id)}

    @router.post("/companies/{company_id}/invoices/{invoice_id}/extractions")
    def queue_extraction(company_id: str, invoice_id: str, payload: dict, session=Depends(mutation)):
        return {"extraction": jobs.queue(company_id, invoice_id, payload, session["name"])}

    @router.post("/companies/{company_id}/invoices/{invoice_id}/extractions/{job_id}/cancel")
    def cancel_extraction(company_id: str, invoice_id: str, job_id: str, session=Depends(mutation)):
        return {"extraction": jobs.cancel(company_id, invoice_id, job_id, session["name"])}

    @router.post("/companies/{company_id}/invoices/{invoice_id}/extractions/{job_id}/apply")
    def apply_extraction(company_id: str, invoice_id: str, job_id: str, payload: dict, session=Depends(mutation)):
        return {"invoice": jobs.apply(company_id, invoice_id, job_id, payload, session["name"])}

    @router.get("/companies/{company_id}/connection")
    def connection_status(company_id: str):
        return reads.status(company_id)

    @router.post("/companies/{company_id}/connection/test")
    def test_connection(company_id: str, payload: dict, session=Depends(mutation)):
        return {"job": reads.queue(company_id, payload, session["name"], mode="test")}

    @router.get("/companies/{company_id}/sync")
    def sync_status(company_id: str):
        return reads.status(company_id)

    @router.post("/companies/{company_id}/sync")
    def queue_sync(company_id: str, payload: dict, session=Depends(mutation)):
        return {"job": reads.queue(company_id, payload, session["name"])}

    @router.post("/companies/{company_id}/sync/{job_id}/cancel")
    def cancel_sync(company_id: str, job_id: str, session=Depends(mutation)):
        return reads.cancel(company_id, job_id, session["name"])

    @router.get("/companies/{company_id}/remote-records")
    def remote_records(company_id: str, start: str, end: str, offset: int = Query(0, ge=0)):
        return reads.intake.list(company_id, start, end, offset)

    @router.get("/companies/{company_id}/invoices/{invoice_id}/remote-records")
    def invoice_remote_records(company_id: str, invoice_id: str):
        return reads.intake.for_invoice(company_id, invoice_id)

    @router.post("/companies/{company_id}/remote-records/{remote_id}/match")
    def match_remote(company_id: str, remote_id: str, payload: dict, session=Depends(mutation)):
        return reads.intake.match(company_id, remote_id, payload, session["name"])

    @router.post("/companies/{company_id}/invoices/{invoice_id}/remote-records/{remote_id}/apply")
    def apply_remote_fields(company_id: str, invoice_id: str, remote_id: str, payload: dict, session=Depends(mutation)):
        return {"invoice": reads.intake.apply(company_id, invoice_id, remote_id, payload, session["name"])}

    @router.post("/backup")
    def backup(session=Depends(mutation)):
        return {"backup": repo.backup()}

    @router.post("/restore")
    def restore(payload: dict, session=Depends(mutation)):
        snapshot = repo.validate_backup(payload)
        repo.restore(snapshot, session["name"])
        return {"ok": True, "reviewRequired": True, "productionWrites": False}

    return router

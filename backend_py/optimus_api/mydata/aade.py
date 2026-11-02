"""AADE RequestDocs only. No caller-supplied host, method, credentials or headers."""
import calendar
from datetime import date
import re
import time
from urllib.parse import urlencode

from fastapi import HTTPException

from . import domain
from .qr_transport import PinnedHTTPS, public_addresses

MAX_RESPONSE = 8 * 1024 * 1024
HOSTS = {"prod": ("mydatapi.aade.gr", "/myDATA/RequestDocs"), "test": ("mydataapidev.aade.gr", "/RequestDocs")}


class ReadError(Exception):
    """A safe diagnostic, with no upstream body, URL or credential values."""


def connection_options(settings):
    return [{"id": alias, "label": f"Connection {alias.split('_')[1]} · {'Production' if alias.endswith('prod') else 'Sandbox (test credentials)'}",
             "environment": alias.rsplit('_', 1)[1],
             "configured": all(getattr(settings, f"mydata_{alias}_{key}", None) for key in ("user_id", "subscription_key", "vat_number"))}
            for alias in sorted(domain.READ_CONNECTIONS)]


def configured_connection(settings, company):
    alias = company.get("readConnection", "")
    if alias not in domain.READ_CONNECTIONS:
        raise HTTPException(400, "Choose an AADE connection in company Settings first")
    values = {key: getattr(settings, f"mydata_{alias}_{key}", None) for key in ("user_id", "subscription_key", "vat_number")}
    if not all(values.values()):
        raise HTTPException(400, "This AADE connection is missing private .env configuration. See company Settings.")
    vat = domain.vat_number(values["vat_number"])
    target = domain.vat_number(company.get("vatNumber"))
    if not target:
        raise HTTPException(400, "Save the company's ΑΦΜ before reading AADE")
    principal = company.get("readPrincipal", "company")
    if principal == "company" and vat != target:
        raise HTTPException(400, "The connection's configured ΑΦΜ must match this company for direct company access")
    for key in ("user_id", "subscription_key"):
        if not isinstance(values[key], str) or not re.fullmatch(r"[\x21-\x7e]{1,500}", values[key]):
            raise HTTPException(400, "The private AADE credential configuration has an invalid format")
    return {"alias": alias, "environment": alias.rsplit('_', 1)[1], "targetVat": target,
            "principal": principal, **values}


def month_range(start, end):
    start, end = domain.month(start), domain.month(end)
    if start > end:
        domain.fail("The start month must precede the end month")
    months = []
    year, mon = map(int, start.split('-'))
    while f"{year:04}-{mon:02}" <= end:
        months.append(f"{year:04}-{mon:02}")
        if len(months) > 120:
            domain.fail("Sync at most 120 months at a time")
        year, mon = (year + 1, 1) if mon == 12 else (year, mon + 1)
    return months


def request_params(config, month, token=None):
    year, mon = map(int, domain.month(month).split('-'))
    params = {"mark": "0", "dateFrom": date(year, mon, 1).strftime('%d/%m/%Y'),
              "dateTo": date(year, mon, calendar.monthrange(year, mon)[1]).strftime('%d/%m/%Y')}
    if config["principal"] == "representative":
        params["entityVatNumber"] = config["targetVat"]
    if token:
        if set(token) != {"nextPartitionKey", "nextRowKey"} or any(not isinstance(v, str) or not v or len(v) > 2048 for v in token.values()):
            raise ReadError("AADE returned an invalid continuation token.")
        params.update(token)
    return params


def request_docs(config, month, token=None):
    host, path = HOSTS[config["environment"]]
    path += '?' + urlencode(request_params(config, month, token))
    # Fixed GET route only. AADE also has mutating GET routes, which are never reachable here.
    for attempt in range(3):
        connection = None
        try:
            connection = PinnedHTTPS(host, public_addresses(host)[0], timeout=8)
            connection.request("GET", path, headers={"aade-user-id": config["user_id"],
                "ocp-apim-subscription-key": config["subscription_key"], "Accept": "application/xml",
                "Accept-Encoding": "identity", "Connection": "close"})
            response = connection.getresponse()
            if response.status == 401:
                if config["environment"] == "test":
                    raise ReadError("AADE denied access to the sandbox. It requires separately registered test credentials. If these are normal myDATA credentials, select a Production connection in company Settings and save. Test connection is still read-only.")
                raise ReadError("AADE denied access with the production API credentials. Check the myDATA REST API username and subscription key (not the TAXISnet login), then restart Optimus after changing .env.")
            if response.status == 403:
                raise ReadError("AADE denied permission for this read. Check the API account permissions and, for representative access, its authorisation for this company.")
            if response.status in {429, 502, 503, 504} and attempt < 2:
                time.sleep(0.25 * (attempt + 1))
                continue
            if response.status != 200:
                raise ReadError("AADE did not complete the read. Try again later or check the connection configuration.")
            if response.getheader('Content-Encoding', 'identity').lower() not in {'identity', ''}:
                raise ReadError("AADE returned unsupported compressed data.")
            length = response.getheader('Content-Length')
            if length and (not length.isdigit() or int(length) > MAX_RESPONSE):
                raise ReadError("The AADE response exceeds the intake size limit.")
            started, content = time.monotonic(), bytearray()
            while len(content) <= MAX_RESPONSE:
                if time.monotonic() - started > 20:
                    raise ReadError("AADE reading timed out. Start a new sync to retry safely.")
                chunk = response.read(min(65536, MAX_RESPONSE + 1 - len(content)))
                if not chunk:
                    break
                content.extend(chunk)
            if len(content) > MAX_RESPONSE:
                raise ReadError("The AADE response exceeds the intake size limit.")
            return bytes(content)
        except ReadError:
            raise
        except Exception:
            if attempt == 2:
                raise ReadError("AADE could not be reached securely. Your saved purchases are still available.") from None
            time.sleep(0.25 * (attempt + 1))
        finally:
            if connection:
                connection.close()

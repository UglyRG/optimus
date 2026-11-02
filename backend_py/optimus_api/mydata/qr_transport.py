"""Credential-free HTTPS reads to recognised provider download routes only."""
import http.client
import ipaddress
import socket
import ssl
import time
from urllib.parse import urljoin, urlsplit

from .qr import recognise

MAX_RESPONSE = 2 * 1024 * 1024


class LookupError(Exception):
    """Safe public error text; never include private QR tokens or upstream bodies."""


def public_addresses(host):
    try:
        addresses = list(dict.fromkeys(item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)))
    except OSError as exc:
        raise LookupError("The invoice provider could not be reached.") from exc
    if not addresses or any(not ipaddress.ip_address(address).is_global or ipaddress.ip_address(address).is_multicast for address in addresses):
        raise LookupError("The provider destination was blocked by the network safety check.")
    return addresses


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address, timeout):
        super().__init__(host, port=443, timeout=timeout, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        # Pin the already-checked IP while still verifying TLS against the original hostname.
        sock = socket.create_connection((self.address, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except Exception:
            sock.close()
            raise


def fetch_xml(url):
    started = time.monotonic()
    first = recognise(url)
    if first["kind"] != "provider_invoice" or first["downloadUrl"] != url:
        raise LookupError("This QR download format is not supported.")
    for _ in range(3):
        recognised = recognise(url)
        if recognised["kind"] != "provider_invoice" or recognised["downloadUrl"] != url or recognised["issuerVat"] != first["issuerVat"] or urlsplit(url).path != urlsplit(first["downloadUrl"]).path:
            raise LookupError("The provider redirect was blocked.")
        remaining = 20 - (time.monotonic() - started)
        if remaining <= 0:
            raise LookupError("The provider lookup timed out.")
        host = urlsplit(url).hostname
        address = public_addresses(host)[0]
        connection = PinnedHTTPS(host, address, timeout=min(8, remaining))
        try:
            connection.request("GET", urlsplit(url).path, headers={"Accept": "application/xml,text/xml", "Accept-Encoding": "identity",
                                                                  "User-Agent": "Optimus-invoice-reader/1.0", "Connection": "close"})
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                location = response.getheader("Location")
                if not location:
                    raise LookupError("The provider returned an invalid redirect.")
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise LookupError("Structured invoice data is unavailable from this provider link.")
            if response.getheader("Content-Encoding", "identity").lower() not in {"identity", ""}:
                raise LookupError("The provider returned an unsupported compressed response.")
            length = response.getheader("Content-Length")
            if length and (not length.isdigit() or int(length) > MAX_RESPONSE):
                raise LookupError("The provider response exceeds the allowed size.")
            content = bytearray()
            while len(content) <= MAX_RESPONSE:
                if time.monotonic() - started >= 20:
                    raise LookupError("The provider lookup timed out.")
                chunk = response.read(min(65536, MAX_RESPONSE + 1 - len(content)))
                if not chunk:
                    break
                content.extend(chunk)
            if len(content) > MAX_RESPONSE:
                raise LookupError("The provider response exceeds the allowed size.")
            return bytes(content)
        except LookupError:
            raise
        except (OSError, http.client.HTTPException, ValueError) as exc:
            raise LookupError("The invoice provider could not be reached securely.") from exc
        finally:
            connection.close()
    raise LookupError("The provider redirected too many times.")

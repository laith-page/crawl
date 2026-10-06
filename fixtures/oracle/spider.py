"""The oracle: Scrapy crawling a site the way the contract says, printing the records a crawler under
test must print, one JSON line a page, so a golden expected file comes from nothing under test.

    scrapy runspider fixtures/oracle/spider.py -a start=http://127.0.0.1:8080/ -s LOG_LEVEL=ERROR

Same host only, redirects not followed (a 3xx lists its Location), only a 2xx text/html body read for
links, the first href of each <a> in document order, fragments dropped, each URL once. Scrapy's URL
form (w3lib) and the crawler's (the WHATWG URL Standard, DESIGN §4) agree on what this site holds: UTF-8 percent-encoded,
spaces as %20, escapes kept as written.
"""

import json
import sys
from typing import ClassVar
from urllib.parse import urljoin, urlsplit

import scrapy
from w3lib.url import safe_url_string


def form(url: str) -> str:
    """The printed form: safe (w3lib), the fragment dropped, an empty path the root."""
    safe = safe_url_string(url)
    parts = urlsplit(safe)
    path = parts.path or "/"
    query = f"?{parts.query}" if parts.query or safe.rstrip("#").endswith("?") else ""
    return f"{parts.scheme}://{parts.netloc}{path}{query}"


class Oracle(scrapy.Spider):
    name = "oracle"
    custom_settings: ClassVar[dict[str, object]] = {
        "REDIRECT_ENABLED": False,
        "HTTPERROR_ALLOW_ALL": True,
        "ROBOTSTXT_OBEY": False,
        "DEPTH_PRIORITY": 1,
        "SCHEDULER_DISK_QUEUE": "scrapy.squeues.PickleFifoDiskQueue",
        "SCHEDULER_MEMORY_QUEUE": "scrapy.squeues.FifoMemoryQueue",
        "CONCURRENT_REQUESTS": 8,
        "DOWNLOAD_TIMEOUT": 30,
        "RETRY_ENABLED": False,
        "COOKIES_ENABLED": False,
        "TELNETCONSOLE_ENABLED": False,
        "USER_AGENT": "oracle/1.0",
    }

    def __init__(self, start: str, **kwargs):
        super().__init__(**kwargs)
        self.start_urls = [form(start)]
        self.host = urlsplit(self.start_urls[0]).hostname
        self.seen = {self.start_urls[0]}

    def parse(self, response):
        status = response.status
        links = []
        if 300 <= status < 400:
            location = response.headers.get("Location")
            if location:
                links = [form(urljoin(response.url, location.decode("latin-1")))]
        elif (
            200 <= status < 300
            and status != 204
            and response.headers.get("Content-Type", b"").split(b";")[0].strip().lower() == b"text/html"
        ):
            seen_here = set()
            for href in response.xpath("//a[@href]/@href").getall():
                url = form(urljoin(response.url, href.strip()))
                if urlsplit(url).scheme not in ("http", "https") or url in seen_here:
                    continue
                seen_here.add(url)
                links.append(url)
                if len(links) == 1000:
                    break
        sys.stdout.write(json.dumps({"url": response.url, "status": status, "error": None}, ensure_ascii=False) + "\n")
        for link in links:
            if urlsplit(link).hostname == self.host and link not in self.seen:
                self.seen.add(link)
                yield scrapy.Request(link, callback=self.parse, dont_filter=True)

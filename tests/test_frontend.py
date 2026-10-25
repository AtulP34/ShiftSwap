"""Check the HTML and assets Flask actually serves to a browser."""

from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import pytest


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and "src" in attrs:
            self.urls.append((attrs["src"], "javascript"))
        if tag == "link" and attrs.get("rel") == "stylesheet":
            self.urls.append((attrs["href"], "css"))


@pytest.mark.parametrize("path", ["/", "/schedule/", "/workplace/schedule/"])
def test_frontend_assets_load_from_direct_links(app, path):
    client = app.test_client()
    page = client.get(path)
    assert page.status_code == 200
    assets = Assets()
    assets.feed(page.get_data(as_text=True))
    local_assets = [(url, kind) for url, kind in assets.urls if not urlsplit(url).netloc]
    assert {kind for _, kind in local_assets} == {"javascript", "css"}
    for url, kind in local_assets:
        asset = client.get(urljoin(path, url))
        assert asset.status_code == 200
        assert kind in asset.mimetype, (path, url, asset.mimetype)


def test_unknown_api_route_stays_json_404(app):
    response = app.test_client().get("/api/not-a-route")
    assert response.status_code == 404
    assert response.json == {"error": "Not found"}

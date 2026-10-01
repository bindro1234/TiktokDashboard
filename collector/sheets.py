"""Small Google Sheets v4 REST wrapper using a service account from GOOGLE_SERVICE_ACCOUNT_B64."""

from __future__ import annotations

import base64
import json
import os
import time

from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account

BASE = "https://sheets.googleapis.com/v4/spreadsheets"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


class SheetsError(RuntimeError):
    pass


def session_from_env() -> AuthorizedSession:
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_B64")
    if not raw:
        raise SheetsError("GOOGLE_SERVICE_ACCOUNT_B64 is not set")
    # Decoded in memory only; the key is never written to disk.
    info = json.loads(base64.b64decode(raw))
    creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    return AuthorizedSession(creds)


def _a1(tab: str, cells: str = "") -> str:
    quoted = "'" + tab.replace("'", "''") + "'"
    return f"{quoted}!{cells}" if cells else quoted


def _col(n: int) -> str:
    """1 -> A, 27 -> AA."""
    out = ""
    while n:
        n, rem = divmod(n - 1, 26)
        out = chr(65 + rem) + out
    return out


class Spreadsheet:
    def __init__(self, session: AuthorizedSession, spreadsheet_id: str):
        self.session = session
        self.id = spreadsheet_id
        self._headers: dict[str, list[str]] = {}

    def _call(self, method: str, path: str = "", **kw) -> dict:
        url = f"{BASE}/{self.id}{path}"
        for attempt in range(5):
            resp = self.session.request(method, url, timeout=120, **kw)
            if resp.status_code in (429, 500, 502, 503, 504):
                time.sleep(2 ** (attempt + 1))
                continue
            if resp.status_code >= 400:
                raise SheetsError(f"{method} {path or '/'}: HTTP {resp.status_code} {resp.text[:300]}")
            return resp.json() if resp.content else {}
        raise SheetsError(f"{method} {path or '/'}: still failing after retries")

    def tabs(self) -> dict[str, int]:
        meta = self._call("GET", params={"fields": "sheets.properties(sheetId,title)"})
        return {s["properties"]["title"]: s["properties"]["sheetId"] for s in meta.get("sheets", [])}

    def ensure_tabs(self, schema: dict[str, list[str]], sheet_ids: dict[str, int] | None = None) -> dict[str, int]:
        """Create missing tabs, write header rows into empty tabs, freeze the header row.
        sheet_ids: tabs that must get a fixed tab id (gid) when they are created."""
        sheet_ids = sheet_ids or {}
        existing = self.tabs()
        requests_ = []
        missing = [t for t in schema if t not in existing]
        # A brand-new spreadsheet has one empty "Sheet1": reuse it for the first missing tab.
        if missing and missing[0] not in sheet_ids and "Sheet1" in existing and not self._values("Sheet1"):
            requests_.append({"updateSheetProperties": {
                "properties": {"sheetId": existing["Sheet1"], "title": missing[0]},
                "fields": "title"}})
            existing[missing.pop(0)] = existing.pop("Sheet1")
        for tab in missing:
            props = {"title": tab, **({"sheetId": sheet_ids[tab]} if tab in sheet_ids else {})}
            requests_.append({"addSheet": {"properties": props}})
        if requests_:
            self._call("POST", ":batchUpdate", json={"requests": requests_})
            existing = self.tabs()
        freeze = []
        for tab, header in schema.items():
            current = self.header(tab, refresh=True)
            if not current:
                self._call("PUT", f"/values/{_a1(tab, 'A1')}", params={"valueInputOption": "RAW"},
                           json={"values": [header]})
                self._headers[tab] = list(header)
            else:
                self.ensure_columns(tab, header)
            freeze.append({"updateSheetProperties": {
                "properties": {"sheetId": existing[tab], "gridProperties": {"frozenRowCount": 1}},
                "fields": "gridProperties.frozenRowCount"}})
        self._call("POST", ":batchUpdate", json={"requests": freeze})
        return existing

    def ensure_columns(self, tab: str, columns: list[str]) -> None:
        """Add columns that are new in the schema to the end of an existing header row."""
        header = self.header(tab)
        absent = [c for c in columns if c not in header]
        if not header or not absent:
            return
        start = _col(len(header) + 1)
        self._call("PUT", f"/values/{_a1(tab, f'{start}1')}", params={"valueInputOption": "RAW"},
                   json={"values": [absent]})
        self._headers[tab] = header + absent

    def batch_update(self, requests_: list[dict]) -> None:
        self._call("POST", ":batchUpdate", json={"requests": requests_})

    def _values(self, tab: str) -> list[list]:
        data = self._call("GET", f"/values/{_a1(tab)}", params={"valueRenderOption": "UNFORMATTED_VALUE"})
        return data.get("values", [])

    def header(self, tab: str, refresh: bool = False) -> list[str]:
        if refresh or tab not in self._headers:
            rows = self._call("GET", f"/values/{_a1(tab, '1:1')}").get("values", [])
            self._headers[tab] = [str(h).strip() for h in rows[0]] if rows else []
        return self._headers[tab]

    def read(self, tab: str) -> list[dict]:
        rows = self._values(tab)
        if not rows:
            return []
        header = [str(h).strip() for h in rows[0]]
        self._headers[tab] = header
        out = []
        for row in rows[1:]:
            if not any(str(c).strip() for c in row):
                continue
            out.append({h: (row[i] if i < len(row) else "") for i, h in enumerate(header) if h})
        return out

    @staticmethod
    def _cell(value):
        return "" if value is None else value

    def append(self, tab: str, rows: list[dict]) -> None:
        if not rows:
            return
        header = self.header(tab)
        values = [[self._cell(r.get(h)) for h in header] for r in rows]
        self._call("POST", f"/values/{_a1(tab, 'A1')}:append",
                   params={"valueInputOption": "RAW", "insertDataOption": "INSERT_ROWS"},
                   json={"values": values})

    def rewrite(self, tab: str, rows: list[dict]) -> None:
        """Overwrite all data rows in place (no clear first, so readers never see an empty tab)."""
        header = self.header(tab)
        values = [header] + [[self._cell(r.get(h)) for h in header] for r in rows]
        self._call("PUT", f"/values/{_a1(tab, 'A1')}", params={"valueInputOption": "RAW"},
                   json={"values": values})
        self._call("POST", f"/values/{_a1(tab, f'A{len(values) + 1}:ZZ')}:clear", json={})

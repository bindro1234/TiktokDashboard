"""Minimal client for the Bright Data Datasets v3 async API (trigger -> progress -> snapshot)."""

from __future__ import annotations

import logging
import os
import time

import requests

API = "https://api.brightdata.com/datasets/v3"
USAGE_URL = "https://api.brightdata.com/customer/bw"  # billable rows per dataset, per day and per month
log = logging.getLogger(__name__)

FINAL_STATUSES = {"ready", "failed", "canceled", "cancelled"}


class BrightDataError(RuntimeError):
    pass


class BrightData:
    def __init__(self, poll_seconds: int = 15, timeout_minutes: int = 30, session: requests.Session | None = None):
        self.session = session or requests.Session()
        # In GitHub Actions the key comes from a secret. In the cloud dev session a
        # proxy injects it, so the header is only sent when the variable is set.
        key = os.environ.get("BRIGHTDATA_API_KEY")
        if key:
            self.session.headers["Authorization"] = f"Bearer {key}"
        self.poll_seconds = poll_seconds
        self.timeout_seconds = timeout_minutes * 60

    def _get(self, path: str, **params) -> requests.Response:
        """GET with retries; safe to repeat because it never starts a job."""
        last = None
        for attempt in range(5):
            try:
                resp = self.session.get(API + path, params=params, timeout=120)
                if resp.status_code < 500 and resp.status_code != 429:
                    return resp
                last = BrightDataError(f"GET {path}: HTTP {resp.status_code} {resp.text[:200]}")
            except requests.RequestException as exc:
                last = exc
            time.sleep(2 ** (attempt + 1))
        raise BrightDataError(f"GET {path} failed after retries: {last}")

    def trigger(self, dataset_id: str, inputs: list[dict], **params) -> str:
        """Start a collection job. Deliberately not retried: a retry could start (and bill) a second job."""
        query = {"dataset_id": dataset_id, "include_errors": "true", **params}
        resp = self.session.post(f"{API}/trigger", params=query, json=inputs, timeout=120)
        if resp.status_code != 200:
            raise BrightDataError(f"trigger: HTTP {resp.status_code} {resp.text[:300]}")
        snapshot_id = resp.json().get("snapshot_id")
        if not snapshot_id:
            raise BrightDataError(f"trigger: no snapshot_id in response {resp.text[:300]}")
        log.info("Triggered %s with %d input(s): snapshot %s", dataset_id, len(inputs), snapshot_id)
        return snapshot_id

    def billed_rows_this_month(self) -> int | None:
        """Rows Bright Data itself has billed this calendar month (UTC), over all datasets, or None when
        that can't be read. This is the number the invoice is based on; run_log only knows the jobs this
        collector logged. Uses the account usage endpoint, which is not part of the datasets API, so any
        problem (no permission for this key, a changed format) must never stop a run."""
        try:
            resp = self.session.get(USAGE_URL, timeout=60)
            if resp.status_code != 200:
                return None
            total = 0
            for customer in resp.json().values():
                for sums in (customer.get("sums") or {}).values():
                    total += int(((sums or {}).get("back_m0") or {}).get("rows_initial_billable") or 0)
            return total
        except (requests.RequestException, ValueError, AttributeError, TypeError):
            return None

    def progress(self, snapshot_id: str) -> dict:
        resp = self._get(f"/progress/{snapshot_id}")
        if resp.status_code != 200:
            raise BrightDataError(f"progress: HTTP {resp.status_code} {resp.text[:300]}")
        return resp.json()

    def cancel(self, snapshot_id: str) -> None:
        try:
            self.session.post(f"{API}/snapshot/{snapshot_id}/cancel", timeout=60)
        except requests.RequestException as exc:
            log.warning("Cancel of %s failed: %s", snapshot_id, exc)

    def wait(self, snapshot_id: str) -> dict:
        """Poll until the job is final. On timeout the job is cancelled so it stops using records."""
        deadline = time.monotonic() + self.timeout_seconds
        while True:
            prog = self.progress(snapshot_id)
            status = str(prog.get("status", "")).lower()
            if status in FINAL_STATUSES:
                log.info("Snapshot %s: %s, records=%s errors=%s", snapshot_id, status,
                         prog.get("records"), prog.get("errors"))
                return prog
            if time.monotonic() > deadline:
                self.cancel(snapshot_id)
                prog["status"] = "timeout"
                return prog
            time.sleep(self.poll_seconds)

    def download(self, snapshot_id: str) -> list[dict]:
        for _ in range(20):
            resp = self._get(f"/snapshot/{snapshot_id}", format="json")
            if resp.status_code == 202:  # snapshot still being built
                time.sleep(self.poll_seconds)
                continue
            if resp.status_code != 200:
                raise BrightDataError(f"snapshot: HTTP {resp.status_code} {resp.text[:300]}")
            data = resp.json()
            return data if isinstance(data, list) else [data]
        raise BrightDataError(f"snapshot {snapshot_id} was not ready for download")

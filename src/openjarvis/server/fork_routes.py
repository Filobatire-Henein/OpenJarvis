"""``GET /v1/fork/updates`` — read-only upstream update report for the fork.

Only contacts GitHub (``git fetch upstream``) when ``refresh=1`` is passed,
i.e. when the user opens the Updates tab or clicks "Check now". Never
merges or modifies the checkout.
"""

from __future__ import annotations

import threading
from typing import Any, Dict

from fastapi import APIRouter, Query

router = APIRouter(prefix="/v1/fork", tags=["fork"])

# Serialise git runs so a double-click can't start two fetches at once.
_lock = threading.Lock()


@router.get("/updates")
def fork_updates(refresh: bool = Query(False)) -> Dict[str, Any]:
    from openjarvis.fork.updates import build_report

    with _lock:
        try:
            return build_report(refresh=refresh)
        except Exception as exc:  # pragma: no cover - defensive
            return {
                "status": "error",
                "message": f"Couldn't build the update report: {exc}",
                "commits": [],
                "pending": 0,
            }

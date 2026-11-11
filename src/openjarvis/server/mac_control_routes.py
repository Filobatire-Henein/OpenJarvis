"""REST endpoints for macOS computer control (status + kill switch).

Approvals themselves go through the shared ``/v1/approvals/*`` routes; risky
``mac_*`` tool calls block on those until the user decides.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict

try:
    from fastapi import APIRouter, HTTPException
except ImportError:
    raise ImportError("fastapi is required for mac control routes")

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/v1/mac-control/status")
async def mac_control_status() -> Dict[str, Any]:
    from openjarvis.tools.mac_control import status_snapshot

    return await asyncio.to_thread(status_snapshot)


@router.post("/v1/mac-control/stop")
async def mac_control_stop() -> Dict[str, Any]:
    """Kill switch: refuse all computer actions and deny anything pending."""
    from openjarvis.tools.mac_control import get_controller

    denied = await asyncio.to_thread(get_controller().stop)
    logger.warning("mac_control kill switch engaged (%d pending denied)", denied)
    return {"stopped": True, "denied_pending": denied}


@router.post("/v1/mac-control/resume")
async def mac_control_resume() -> Dict[str, Any]:
    from openjarvis.tools.mac_control import get_controller

    await asyncio.to_thread(get_controller().resume)
    logger.info("mac_control kill switch released")
    return {"stopped": False}


# Fixed, whitelisted System Settings deep links (no user-controlled URL).
_SETTINGS_PANES = {
    "accessibility": "x-apple.systempreferences:com.apple.preference.security"
    "?Privacy_Accessibility",
    "screen_recording": "x-apple.systempreferences:com.apple.preference.security"
    "?Privacy_ScreenCapture",
    "automation": "x-apple.systempreferences:com.apple.preference.security"
    "?Privacy_Automation",
}


@router.post("/v1/mac-control/open-settings/{pane}")
async def mac_control_open_settings(pane: str) -> Dict[str, Any]:
    """Open the matching Privacy & Security pane in System Settings."""
    import subprocess
    import sys

    url = _SETTINGS_PANES.get(pane)
    if url is None:
        raise HTTPException(status_code=404, detail="Unknown settings pane")
    if sys.platform != "darwin":
        raise HTTPException(status_code=400, detail="macOS only")
    await asyncio.to_thread(
        subprocess.run, ["open", url], capture_output=True, timeout=10, check=False
    )
    return {"opened": pane}


__all__ = ["router"]

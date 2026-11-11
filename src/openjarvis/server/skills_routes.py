"""Skills advisor API — browse, review, install (gated) and remove skills.

Every install goes through the local skill reviewer first.  ``unsafe`` skills
are refused unless the request carries ``override_unsafe: true`` *and*
``confirm: true``; everything else still needs ``confirm: true`` so the user
has seen the review before anything is written to disk.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from openjarvis.skills import advisor_service as svc

router = APIRouter(prefix="/v1/skills", tags=["skills"])


class ReviewRequest(BaseModel):
    source: str = ""
    name: str
    category: str = ""
    url: str = ""
    explain: bool = False


class InstallRequest(BaseModel):
    source: str
    name: str
    category: str = ""
    url: str = ""
    confirm: bool = False
    override_unsafe: bool = False
    with_scripts: bool = False
    force: bool = False


def _http_error(exc: svc.AdvisorError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=str(exc))


@router.get("/catalog")
async def skills_catalog(
    source: str = "",
    q: str = "",
    refresh: bool = False,
    url: Optional[str] = None,
):
    """Available skills from configured sources, each with a local review."""
    try:
        return await asyncio.to_thread(
            svc.catalog, source, q, refresh=refresh, url=url or ""
        )
    except svc.AdvisorError as exc:
        raise _http_error(exc) from exc


@router.get("/installed")
async def skills_installed():
    """Skills installed in the user's skills directory, re-reviewed."""
    items = await asyncio.to_thread(svc.list_installed)
    return {"skills": items}


@router.get("/sources")
async def skills_sources():
    return {"sources": svc.configured_sources()}


@router.post("/review")
async def skills_review(req: ReviewRequest):
    """Review one skill by source + name (or an installed skill with no source)."""
    try:
        review = await asyncio.to_thread(
            svc.review_one,
            req.source,
            req.name,
            category=req.category,
            url=req.url,
            explain=req.explain,
        )
    except svc.AdvisorError as exc:
        raise _http_error(exc) from exc
    return review.to_dict()


@router.post("/install")
async def skills_install(req: InstallRequest):
    """Install a skill after the review gate."""
    try:
        outcome = await asyncio.to_thread(
            svc.install,
            req.source,
            req.name,
            category=req.category,
            url=req.url,
            confirm=req.confirm,
            override_unsafe=req.override_unsafe,
            with_scripts=req.with_scripts,
            force=req.force,
        )
    except svc.AdvisorError as exc:
        raise _http_error(exc) from exc
    status = {
        "installed": 200,
        "already_installed": 200,
        "needs_confirmation": 409,
        "blocked": 403,
        "failed": 422,
    }.get(outcome.status, 400)
    return JSONResponse(outcome.to_dict(), status_code=status)


@router.delete("/{skill_name}")
async def skills_remove(skill_name: str):
    try:
        removed = await asyncio.to_thread(svc.remove, skill_name)
    except svc.AdvisorError as exc:
        raise _http_error(exc) from exc
    return {"status": "removed", "removed": removed}


__all__ = ["router"]

"""`jarvis fork-updates` — show what upstream changed, without merging it."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import click


@click.command(
    "fork-updates",
    help=(
        "Show what's new upstream (open-jarvis/OpenJarvis) compared with this "
        "fork, flag anything that could break your customizations, and print "
        "the commands to merge it by hand. Never merges anything."
    ),
)
@click.option(
    "--no-fetch",
    is_flag=True,
    help="Don't contact GitHub; use the last downloaded copy of upstream.",
)
@click.option("--json", "as_json", is_flag=True, help="Print the raw JSON report.")
@click.option("--verbose", "-v", is_flag=True, help="Show reasons for every commit.")
@click.option(
    "--repo",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    default=None,
    help="Repository to inspect (default: the checkout OpenJarvis runs from).",
)
@click.option("--remote", default="upstream", show_default=True)
@click.option("--branch", default="main", show_default=True)
def fork_updates(
    no_fetch: bool,
    as_json: bool,
    verbose: bool,
    repo: Optional[Path],
    remote: str,
    branch: str,
) -> None:
    from openjarvis.fork.updates import build_report, render_text

    report = build_report(
        repo, refresh=not no_fetch, remote=remote, upstream_branch=branch
    )
    if as_json:
        click.echo(json.dumps(report, indent=2))
    else:
        click.echo(render_text(report, verbose=verbose))

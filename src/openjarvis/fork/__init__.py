"""Helpers for running OpenJarvis from a personal fork.

A fork must never replace itself with upstream code automatically. This
package detects fork checkouts (:mod:`openjarvis.fork.detect`) and builds a
read-only report of what upstream changed (:mod:`openjarvis.fork.updates`).
"""

from openjarvis.fork.detect import ForkInfo, detect_fork, is_fork_checkout

__all__ = ["ForkInfo", "detect_fork", "is_fork_checkout"]

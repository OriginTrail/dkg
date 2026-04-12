"""Standalone entry point for the bundled MarkItDown binary.

This wrapper keeps the DKG-facing CLI contract intentionally narrow:
- exactly one positional argument: the source file path
- markdown emitted to stdout
- errors emitted to stderr with a non-zero exit code
"""

from __future__ import annotations

import sys

from markitdown import MarkItDown


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: markitdown <file-path>\n")
        return 2

    file_path = sys.argv[1]
    result = MarkItDown(enable_plugins=False).convert(file_path)
    sys.stdout.write(result.text_content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

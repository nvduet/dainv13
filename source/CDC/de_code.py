"""Restore an archive from Base64 TXT parts, verifying metadata when present."""

import argparse
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

SCRIPT_DIR = Path(__file__).resolve().parent


def numbered_parts(directory):
    parts = sorted(
        (
            path
            for path in directory.iterdir()
            if path.is_file()
            and path.suffix.lower() == ".txt"
            and path.stem.isdigit()
            and int(path.stem) > 0
        ),
        key=lambda path: int(path.stem),
    )

    if (
        not parts
        or [int(path.stem) for path in parts]
        != list(range(1, len(parts) + 1))
    ):
        raise ValueError("TXT parts must be consecutive from 1.txt")

    return parts


def read_encoded(source):
    if source.is_dir():
        parts = numbered_parts(source)

    elif source.suffix.lower() == ".txt" and source.stem.isdigit():
        parts = numbered_parts(source.parent)

        if source not in parts:
            raise ValueError(
                "numbered TXT input does not exist: {}".format(source)
            )

    else:
        return source.read_text(encoding="utf-8-sig"), 1

    return (
        "".join(part.read_text(encoding="utf-8-sig") for part in parts),
        len(parts),
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)

    parser.add_argument(
        "source",
        nargs="?",
        type=Path,
        help=(
            "TXT directory, numbered part or single Base64 TXT "
            "(default: beside this script)"
        ),
    )

    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help=(
            "restored archive path (default: original filename with "
            "_restored; replaced on each run)"
        ),
    )

    args = parser.parse_args()

    try:
        source = (args.source or SCRIPT_DIR).expanduser().resolve()
        directory = source if source.is_dir() else source.parent

        encoded, count = read_encoded(source)

        data = base64.b64decode(
            "".join(encoded.split()),
            validate=True,
        )

        digest = hashlib.sha256(data).hexdigest()

        metadata_path = directory / "metadata.txt"
        if not metadata_path.is_file():
            metadata_path = directory / "metadata.json"

        filename = (
            "archive.7z"
            if data.startswith(b"7z\xbc\xaf\x27\x1c")
            else "archive.bin"
        )

        if metadata_path.exists():
            metadata = json.loads(
                metadata_path.read_text(encoding="ascii")
            )

            if (
                metadata["bytes"] != len(data)
                or metadata["sha256"] != digest
            ):
                raise ValueError(
                    "decoded size or SHA-256 does not match metadata"
                )

            if (
                (source.is_dir() or source.stem.isdigit())
                and metadata["parts"] != count
            ):
                raise ValueError(
                    "TXT part count does not match metadata"
                )

            filename = metadata["filename"]

            if (
                not isinstance(filename, str)
                or Path(filename).name != filename
                or filename in ("", ".", "..")
            ):
                raise ValueError(
                    "invalid archive filename in metadata"
                )

        original = Path(filename)

        output = (
            args.output
            or directory
            / (original.stem + "_restored" + original.suffix)
        ).expanduser().resolve()

        if (
            output == source
            or output == metadata_path
            or output.suffix.lower()
            in (".txt", ".py", ".json")
        ):
            raise ValueError(
                "output must not replace TXT input, metadata "
                "or Python scripts"
            )

        if args.output is not None and output.exists():
            raise ValueError(
                "output already exists; choose another path "
                "with -o: {}".format(output)
            )

        output.parent.mkdir(parents=True, exist_ok=True)

        temporary = None

        try:
            with tempfile.NamedTemporaryFile(
                dir=str(output.parent),
                prefix=".decode_",
                delete=False,
            ) as stream:
                temporary = Path(stream.name)
                stream.write(data)

            os.replace(str(temporary), str(output))

        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()

    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        binascii.Error,
    ) as error:
        print("Error: {}".format(error), file=sys.stderr)
        return 1

    print("Restored archive: {}".format(output))
    print("Bytes: {}; TXT parts: {}".format(len(data), count))
    print("SHA-256: {}".format(digest))
    print(
        "Metadata verification: {}".format(
            "PASS" if metadata_path.exists() else "not available"
        )
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())

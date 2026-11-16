#!/usr/bin/env bash
# Regenerates the Unifont files in public/.
#
#   public/unifont.woff2        full Unifont 12.1.04, all glyphs, WOFF2
#   public/unifont-subset.woff2 the code points the UI itself renders
#
# Both are declared in src/App.css as the same 'Unifont' family with
# complementary unicode-ranges, so the full file is only fetched when a
# character outside the subset (e.g. a CJK or Cyrillic file name) is on
# the page. If SUBSET_RANGES changes, update both unicode-range lines in
# src/App.css to the values this script prints.
#
# Requires: python3 with fonttools and brotli (pip install fonttools brotli)
#
# Usage: scripts/subset-font.sh [source-font]
#   source-font defaults to public/unifont.woff2 (any format fontTools
#   reads: .ttf, .woff, .woff2). Upstream source: unifont-12.1.04.ttf from
#   https://unifoundry.com/unifont/

set -euo pipefail

cd "$(dirname "$0")/.."

SRC="${1:-public/unifont.woff2}"
FULL=public/unifont.woff2
SUBSET=public/unifont-subset.woff2

# Whole blocks: Basic Latin + C0/C1 controls, Latin-1 Supplement,
# Latin Extended-A, General Punctuation, Currency Symbols, Letterlike
# Symbols, Arrows, Box Drawing (└ ├ │ ─), Block Elements, Geometric
# Shapes (▲ ▼). Single code points: ⊠ (U+22A0), ⛶ (U+26F6), U+FFFD.
SUBSET_RANGES="U+0000-017F,U+2000-206F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+22A0,U+2500-25FF,U+26F6,U+FFFD"

if [ "$(realpath "$SRC")" != "$(realpath -m "$FULL")" ]; then
  python3 -I - "$SRC" "$FULL" <<'PY'
import sys
from fontTools.ttLib import TTFont
font = TTFont(sys.argv[1])
font.flavor = 'woff2'
font.save(sys.argv[2])
PY
fi

python3 -I -m fontTools.subset "$FULL" \
  --unicodes="$SUBSET_RANGES" \
  --flavor=woff2 \
  --layout-features='*' \
  --name-IDs='*' \
  --name-legacy \
  --name-languages='*' \
  --notdef-outline \
  --output-file="$SUBSET"

# Check the subset holds every glyph the full font has in SUBSET_RANGES,
# then print the unicode-range values for src/App.css. (Should fontTools'
# glyph closure ever pull in code points outside SUBSET_RANGES, they are
# harmless: the CSS sends them to the full file, which has them too.)
python3 -I - "$FULL" "$SUBSET" "$SUBSET_RANGES" <<'PY'
import os, sys
from fontTools.ttLib import TTFont

full_path, subset_path, spec = sys.argv[1:]
ranges = []
for part in spec.split(','):
    lo, _, hi = part[2:].partition('-')
    ranges.append((int(lo, 16), int(hi or lo, 16)))

full = set(TTFont(full_path).getBestCmap())
subset = set(TTFont(subset_path).getBestCmap())
wanted = {cp for cp in full if any(lo <= cp <= hi for lo, hi in ranges)}
missing = wanted - subset
if missing:
    sys.exit('subset is missing: ' + ' '.join(f'U+{cp:04X}' for cp in sorted(missing)))

complement = []
start = 0
for lo, hi in sorted(ranges):
    if lo > start:
        complement.append((start, lo - 1))
    start = hi + 1
if start <= 0x10FFFF:
    complement.append((start, 0x10FFFF))

fmt = lambda rs: ', '.join(f'U+{lo:04X}' + (f'-{hi:04X}' if hi != lo else '') for lo, hi in rs)
print(f'{full_path}: {os.path.getsize(full_path)} bytes, {len(full)} code points')
print(f'{subset_path}: {os.path.getsize(subset_path)} bytes, {len(subset)} code points')
print(f'subset unicode-range: {fmt(ranges)};')
print(f'full unicode-range:   {fmt(complement)};')
PY

#!/usr/bin/env bash
# Build Figures 1 to 3 of the paper and the graphical abstract. Offline; no network access.
# Reads only files inside this repository: the four sources in figures/ and, for Figure 3,
# results/local_2026-11-09_n100.jsonl. Never writes into figures/ itself.
# Needs: pdflatex, pdfinfo, pdffonts and pdftoppm (tested with TeX Live 2024), and Python 3.12 with the packages
# in figures/requirements.txt (matplotlib 3.10.5).
# Usage, from any folder:  bash figures/build_all.sh [OUTPUT_FOLDER]   (default: figures/out, which git ignores)
# Optional: TEX=<folder of the TeX binaries> if they are not on PATH; PY=<python command> (default python3, else python).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/out}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
if [ "$OUT" = "$HERE" ] || [ "$OUT" = "$(dirname "$HERE")" ]; then
  echo "choose an output folder other than figures/ or the repository root" >&2; exit 2
fi
if [ -n "${TEX:-}" ]; then export PATH="$TEX:$PATH"; fi
if [ -z "${PY:-}" ]; then
  if python3 -c "import sys" > /dev/null 2>&1; then PY=python3; else PY=python; fi
fi
export SOURCE_DATE_EPOCH=1767225600 FORCE_SOURCE_DATE=1
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

build_tex() {  # $1 source .tex, $2 output name
  cp "$HERE/$1" "$WORK/"
  (cd "$WORK" && pdflatex -interaction=nonstopmode -halt-on-error "$1" > /dev/null)
  if grep -E "^!|Overfull" "$WORK/${1%.tex}.log"; then echo "LaTeX problem in $1" >&2; exit 1; fi
  cp "$WORK/${1%.tex}.pdf" "$OUT/$2"
}

build_tex gen_fig_1.tex Figure_1.pdf
build_tex gen_fig_2.tex Figure_2.pdf
build_tex gen_graphical_abstract.tex Graphical_Abstract.pdf
"$PY" -B "$HERE/gen_fig_3.py" --out-dir "$OUT"

# Graphical abstract PNG: 600 dpi at 100 mm x 120 mm (2362 x 2835 px).
pdftoppm -r 600 -png -singlefile "$OUT/Graphical_Abstract.pdf" "$OUT/Graphical_Abstract"

# Previews for checking (300 dpi, colour and greyscale).
mkdir -p "$OUT/previews"
for f in Figure_1 Figure_2 Figure_3; do
  pdftoppm -r 300 -png -singlefile "$OUT/$f.pdf" "$OUT/previews/$f"
  pdftoppm -r 300 -gray -png -singlefile "$OUT/$f.pdf" "$OUT/previews/${f}_grey"
done
pdftoppm -r 150 -gray -png -singlefile "$OUT/Graphical_Abstract.pdf" "$OUT/previews/Graphical_Abstract_grey"

# Font and size report, and hashes.
{
  for f in Figure_1 Figure_2 Figure_3 Graphical_Abstract; do
    echo "== $f.pdf"
    pdfinfo "$OUT/$f.pdf" | grep -E "Page size"
    pdffonts "$OUT/$f.pdf"
  done
} > "$OUT/fonts_report.txt"
(cd "$OUT" && sha256sum Figure_1.pdf Figure_2.pdf Figure_3.pdf Graphical_Abstract.pdf Graphical_Abstract.png \
   Figure_3_stats.json > SHA256SUMS.txt)
cat "$OUT/SHA256SUMS.txt"
echo "done: $OUT"

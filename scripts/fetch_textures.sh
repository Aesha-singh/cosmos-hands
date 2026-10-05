#!/usr/bin/env bash
# =============================================================================
#  COSMOS HANDS — asset fetcher
# =============================================================================
#  Downloads every optional runtime asset into ./public so the app can run
#  fully offline. The app NEVER hard-depends on these files: a complete
#  procedural fallback exists for every texture (see src/utils/procedural.js),
#  so this script is an optimisation, not a requirement.
#
#  Usage:  bash scripts/fetch_textures.sh [--fast] [--no-models] [--4k]
#
#  Licences:
#    - Planet / moon / sun maps : Solar System Scope  (CC BY 4.0)
#                                https://www.solarsystemscope.com/textures/
#    - MediaPipe task models    : Apache-2.0, Google LLC
#  Nothing here is redistributed inside this repo; the files land in public/.
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEX_DIR="$ROOT/public/textures"
MODEL_DIR="$ROOT/public/models"
WASM_DIR="$ROOT/public/mediapipe/wasm"
CACHE_DIR="$ROOT/.cache/assets"

RES="2k"
FETCH_MODELS=1
PARALLEL="${PARALLEL:-6}"

for arg in "$@"; do
  case "$arg" in
    --fast)      RES="1k" ;;
    --4k)        RES="4k" ;;
    --no-models) FETCH_MODELS=0 ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

mkdir -p "$TEX_DIR" "$MODEL_DIR" "$WASM_DIR" "$CACHE_DIR"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RED=$'\033[31m'; RST=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$BOLD" "$RST" "$*"; }
ok()   { printf '  %s[ok]%s %s\n'   "$GRN" "$RST" "$*"; }
skip() { printf '  %s[--]%s %s\n'   "$DIM" "$RST" "$*"; }
warn() { printf '  %s[!!]%s %s\n'   "$YEL" "$RST" "$*"; }
die()  { printf '  %s[xx]%s %s\n'   "$RED" "$RST" "$*"; }

# ---- fetch <url> <dest> -------------------------------------------------------
# Resumable, retries twice, caches by URL hash so re-runs are instant.
fetch() {
  local url="$1" dest="$2" key hash tmp
  key="$(printf '%s' "$url" | shasum -a 256 | cut -c1-16)"
  tmp="$CACHE_DIR/$key.bin"

  if [[ -s "$dest" ]]; then skip "$(basename "$dest") (already present)"; return 0; fi
  if [[ -s "$tmp"  ]]; then cp "$tmp" "$dest"; ok "$(basename "$dest") (from cache)"; return 0; fi

  for attempt in 1 2 3; do
    if curl -fsSL --retry 2 --retry-delay 1 --connect-timeout 12 --max-time 240 \
            "$url" -o "$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
      cp "$tmp" "$dest"; ok "$(basename "$dest")"; return 0
    fi
    sleep $((attempt * 2))
  done
  warn "$(basename "$dest") failed (${url}) — procedural fallback will be used"
  return 1
}

# =============================================================================
# 1. Planet, moon and sun maps  (Solar System Scope, CC BY 4.0)
# =============================================================================
say "Downloading Solar System Scope maps at ${RES} resolution"

SSS_BASE="https://www.solarsystemscope.com/textures/download"
declare -a MAPS=(
  "sun.jpg"                   # solar surface (photosphere)
  "mercury.jpg"               # Mercury surface
  "venus_surface.jpg"         # Venus surface
  "venus_atmosphere.jpg"      # Venus cloud deck
  "earth_daymap.jpg"          # Earth albedo
  "earth_nightmap.jpg"        # Earth city lights
  "earth_clouds.jpg"          # Earth cloud layer (alpha)
  "moon.jpg"                  # Luna surface
  "mars.jpg"                  # Mars surface
  "jupiter.jpg"               # Jupiter bands
  "saturn.jpg"                # Saturn bands
  "saturn_ring_alpha.png"     # Saturn ring optical depth
  "saturn_ring_color.png"     # Saturn ring colour
  "uranus.jpg"                # Uranus bands
  "neptune.jpg"               # Neptune bands
  "pluto.jpg"                 # Pluto surface
)

# The Galilean moons and Titan have no freely-hosted equirectangular map at a
# usable resolution, so COSMOS HANDS synthesises them instead — and honestly
# synthesises them *well*: Io's sulphur allotropes, Europa's cycloidal lineae,
# Ganymede's grooved terrain, Callisto's saturated cratering, Titan's haze.
# See src/utils/procedural.js → makeMoonTexture().
declare -a OPTIONAL_MAPS=(
  "io.jpg"
  "europa.jpg"
  "ganymede.jpg"
  "callisto.jpg"
  "titan.jpg"
)

download_maps() {
  local name
  for name in "${MAPS[@]}"; do
    fetch "${SSS_BASE}/${RES}_${name}" "$TEX_DIR/${RES}_${name}" &
    throttle
  done
  wait
  for name in "${OPTIONAL_MAPS[@]}"; do
    # No failure message: these genuinely do not exist upstream on all hosts.
    fetch "${SSS_BASE}/${RES}_${name}" "$TEX_DIR/${RES}_${name}" || rm -f "$TEX_DIR/${RES}_${name}"
  done
}

# macOS ships bash 3.2, which has no `wait -n`. Throttle with a job-count poll.
throttle() {
  local running
  while :; do
    running="$(jobs -rp | wc -l | tr -d ' ')"
    [[ "$running" -ge "$PARALLEL" ]] || break
    sleep 0.12
  done
}

download_maps

# Star sprite for the galaxy / constellation glow. The app *generates* this at
# runtime (src/utils/procedural.js → makeStarSprite) because a generated sprite
# has no seams and no mip artefacts, so this is purely a nicety.
fetch "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/sprites/spark.png" \
      "$TEX_DIR/star_sprite.png" || rm -f "$TEX_DIR/star_sprite.png"

# =============================================================================
# 2. MediaPipe hand-tracking models
# =============================================================================
if [[ "$FETCH_MODELS" == "1" ]]; then
  say "Downloading MediaPipe task models (Apache-2.0)"
  fetch "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task" \
        "$MODEL_DIR/hand_landmarker.task"
  fetch "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task" \
        "$MODEL_DIR/gesture_recognizer.task"
else
  skip "models (--no-models)"
fi

# =============================================================================
# 3. MediaPipe WASM runtime — copy straight out of node_modules
# =============================================================================
say "Staging MediaPipe WASM runtime"
MP_WASM="$ROOT/node_modules/@mediapipe/tasks-vision/wasm"
if [[ -d "$MP_WASM" ]]; then
  cp -f "$MP_WASM"/* "$WASM_DIR"/ 2>/dev/null && ok "wasm ($(ls -1 "$WASM_DIR" | wc -l | tr -d ' ') files, local = no CDN round-trip)"
else
  warn "@mediapipe/tasks-vision not installed — run 'npm install' first, app will fall back to jsDelivr CDN"
fi

# =============================================================================
# 4. Report
# =============================================================================
say "Summary"
TEX_COUNT=$(find "$TEX_DIR" -type f \( -name '*.jpg' -o -name '*.png' \) | wc -l | tr -d ' ')
TEX_SIZE=$(du -sh "$TEX_DIR" 2>/dev/null | cut -f1)
MOD_SIZE=$(du -sh "$MODEL_DIR" 2>/dev/null | cut -f1)
printf '    textures : %s files (%s)\n' "$TEX_COUNT" "${TEX_SIZE:-0}"
printf '    models   : %s (%s)\n' "$(find "$MODEL_DIR" -type f | wc -l | tr -d ' ')" "${MOD_SIZE:-0}"

if [[ "$TEX_COUNT" -lt 5 ]]; then
  printf '\n  %sHeads up:%s almost no textures downloaded. COSMOS HANDS still runs at\n' "$YEL" "$RST"
  printf '  full quality using its procedural texture generator.\n\n'
else
  printf '\n  %sReady.%s Run `npm run dev`.\n\n' "$GRN" "$RST"
fi

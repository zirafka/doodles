#!/usr/bin/env python3
"""Vyrobí čtvercové náhledy videí do thumbs/<id>.jpg.

Použití:
    pip install pillow
    python3 scripts/make_thumbs.py

Videa v playlistu jsou převážně svislá a YouTube je vkládá do vodorovného
rámu 16:9, takže náhled má uprostřed svislé video a po stranách rozmazané
nebo tmavé pruhy. Skript proto z náhledu vyřízne jen střed samotného videa:

1. Stáhne https://i.ytimg.com/vi/<id>/maxresdefault.jpg (1280x720, bez
   černých pruhů).
2. Ze středu vyřízne čtverec o straně poloviny výšky: pro 1280x720 je to
   360x360 od (460, 180) do (820, 540). To je 28 % šířky rámu, svislé video
   zabírá asi 32 %, takže se boční pruhy do ořezu nedostanou.
3. Zmenší ho na 144x144 (Lanczos) a uloží jako progresivní JPEG, kvalita 76.

Když maxresdefault neexistuje (HTTP 404), zkusí sddefault (640x480) a pak
hqdefault (480x360). Ty mají černé pruhy nahoře a dole, takže z nich nejdřív
vyřízne vycentrovaný obdélník 16:9 a na něj použije stejné pravidlo.
mqdefault nepoužívá, ořez z 90 px výšky by byl na jemných displejích
rozmazaný.

Zpracuje jen videa z data/videos.json, která ještě nemají soubor v thumbs/.
Existující soubory nepřepisuje: kdo chce náhled vyrobit znovu, smaže ho
a spustí skript znovu.

Ruční výjimky jsou v data/thumb_overrides.json (soubor nemusí existovat):
    {"<id>": [left, top, side]}
Souřadnice jsou v pixelech obrázku 1280x720. U videa z tohoto souboru skript
vyřízne zadaný čtverec místo pravidla.

Když se některý náhled nepodaří stáhnout, ostatní zpracuje a skončí s kódem 1.
Stránka místo chybějícího náhledu ukáže šedý čtverec.
"""

from __future__ import annotations

import io
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Chybí knihovna Pillow, nainstaluj ji: pip install pillow", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parent.parent
VIDEOS_FILE = ROOT / "data" / "videos.json"
OVERRIDES_FILE = ROOT / "data" / "thumb_overrides.json"
THUMBS_DIR = ROOT / "thumbs"

THUMB_URL = "https://i.ytimg.com/vi/{id}/{variant}.jpg"
# Od největšího. mqdefault (320x180) záměrně chybí.
VARIANTS = ("maxresdefault", "sddefault", "hqdefault")
MIN_WIDTH = 480  # menší obrázek je zástupný šedý obrázek, ne skutečný náhled

FRAME_W, FRAME_H = 1280, 720  # souřadnice v thumb_overrides.json
SIDE_RATIO = 0.5  # strana čtverce = polovina výšky obsahu
OUT_SIZE = 144  # na stránce 72 px, dvojnásobek pro jemné displeje
JPEG_QUALITY = 76

TIMEOUT_S = 30
ATTEMPTS = 3
MAX_BYTES = 5 * 1024 * 1024
USER_AGENT = "doodle-denik-thumbs/1.0"


class NotFound(Exception):
    """Varianta náhledu na YouTube neexistuje."""


class DownloadError(Exception):
    """Náhled se nepodařilo stáhnout."""


def load_overrides() -> dict[str, tuple[int, int, int]]:
    if not OVERRIDES_FILE.exists():
        return {}
    try:
        raw = json.loads(OVERRIDES_FILE.read_text(encoding="utf-8"))
    except ValueError as err:
        raise SystemExit(f"data/thumb_overrides.json není platný JSON: {err}")
    if not isinstance(raw, dict):
        raise SystemExit('data/thumb_overrides.json má mít tvar {"<id>": [left, top, side]}.')
    overrides = {}
    for video_id, box in raw.items():
        valid = (
            isinstance(box, list)
            and len(box) == 3
            and all(isinstance(v, int) and not isinstance(v, bool) for v in box)
        )
        if valid:
            left, top, side = box
            valid = side > 0 and left >= 0 and top >= 0 and left + side <= FRAME_W and top + side <= FRAME_H
        if not valid:
            raise SystemExit(
                f"data/thumb_overrides.json, video {video_id}: čekám [left, top, side] "
                f"v celých pixelech, čtverec celý uvnitř {FRAME_W}x{FRAME_H}, dostal jsem {box!r}."
            )
        overrides[video_id] = (left, top, side)
    return overrides


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(1, ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
                data = response.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise DownloadError("obrázek je podezřele velký")
            return data
        except urllib.error.HTTPError as err:
            if err.code == 404:
                raise NotFound() from None
            if err.code < 500 and err.code != 429:
                raise DownloadError(f"HTTP {err.code}") from None
            reason = f"HTTP {err.code}"
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            reason = str(getattr(err, "reason", err))
        if attempt == ATTEMPTS:
            raise DownloadError(reason)
        time.sleep(2 * attempt)
    raise AssertionError("nedosažitelné")


def download_source(video_id: str) -> tuple[str, Image.Image]:
    """Vrátí název varianty a obrázek v největší dostupné velikosti."""
    for variant in VARIANTS:
        try:
            data = fetch(THUMB_URL.format(id=video_id, variant=variant))
        except NotFound:
            continue
        image = Image.open(io.BytesIO(data))
        image.load()
        if image.width < MIN_WIDTH:
            continue
        return variant, image.convert("RGB")
    raise DownloadError("YouTube nemá ani maxresdefault, ani sddefault, ani hqdefault")


def content_frame(image: Image.Image) -> Image.Image:
    """Vyřízne vycentrovaný obdélník 16:9 přes celou šířku.

    U maxresdefault (1280x720) je to celý obrázek, u sddefault a hqdefault
    (4:3) se tím odříznou černé pruhy nahoře a dole.
    """
    width, height = image.size
    content_h = min(height, round(width * 9 / 16))
    top = (height - content_h) // 2
    if top == 0 and content_h == height:
        return image
    return image.crop((0, top, width, top + content_h))


def square_box(frame: Image.Image, override: tuple[int, int, int] | None) -> tuple[int, int, int, int]:
    width, height = frame.size
    if override:
        # Souřadnice jsou pro 1280x720, menší zálohu přepočítáme.
        scale = width / FRAME_W
        left, top, side = (round(v * scale) for v in override)
    else:
        side = round(height * SIDE_RATIO)
        left = (width - side) // 2
        top = (height - side) // 2
    return left, top, left + side, top + side


def make_thumb(video_id: str, override: tuple[int, int, int] | None) -> str:
    variant, image = download_source(video_id)
    if variant == "maxresdefault" and image.size != (FRAME_W, FRAME_H):
        print(f"  {video_id}: maxresdefault má nečekaný rozměr {image.width}x{image.height}", file=sys.stderr)
    frame = content_frame(image)
    box = square_box(frame, override)
    thumb = frame.crop(box).resize((OUT_SIZE, OUT_SIZE), Image.Resampling.LANCZOS)

    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    target = THUMBS_DIR / f"{video_id}.jpg"
    tmp = target.with_name(f".{target.name}.tmp")
    thumb.save(tmp, "JPEG", quality=JPEG_QUALITY, progressive=True, optimize=True)
    tmp.replace(target)
    how = "ruční výjimka" if override else "pravidlo"
    return f"{variant}, {how}, ořez {box[2] - box[0]} px od ({box[0]}, {box[1]})"


def main() -> int:
    videos = json.loads(VIDEOS_FILE.read_text(encoding="utf-8"))
    overrides = load_overrides()
    unknown = sorted(set(overrides) - {v["id"] for v in videos})
    if unknown:
        print(f"thumb_overrides.json obsahuje videa mimo seznam: {', '.join(unknown)}", file=sys.stderr)

    missing = [v["id"] for v in videos if not (THUMBS_DIR / f"{v['id']}.jpg").exists()]
    if not missing:
        print(f"Všech {len(videos)} náhledů už existuje.")
        return 0

    failed = []
    for video_id in missing:
        try:
            detail = make_thumb(video_id, overrides.get(video_id))
        except (DownloadError, OSError) as err:
            failed.append(video_id)
            print(f"  {video_id}: náhled se nepodařilo vyrobit ({err})", file=sys.stderr)
            continue
        print(f"  {video_id}: {detail}")

    made = len(missing) - len(failed)
    print(f"Nové náhledy: {made}, chyby: {len(failed)}.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Aktualizuje data/videos.json podle playlistu na YouTube.

Použití:
    YOUTUBE_API_KEY=... python3 scripts/update_playlist.py

Načte všechny položky playlistu (YouTube Data API v3, playlistItems.list se
stránkováním), k nim délky videí (videos.list) a výsledek zapíše do
data/videos.json, ale jen když se obsah změnil. Smazaná a soukromá videa
přeskočí. Z názvů odstraní hashtagy a nadbytečné mezery.

Když API vrátí chybu (třeba špatné ID playlistu nebo neplatný klíč), soubor
zůstane beze změny a skript skončí s nenulovým kódem.

Používá jen standardní knihovnu Pythonu.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# ID playlistu (část adresy za "list="). Jde přepsat proměnnou prostředí
# YOUTUBE_PLAYLIST_ID, třeba pro vyzkoušení jiného playlistu.
PLAYLIST_ID = "PLepb8U4Vq3Fg"

API_BASE = "https://www.googleapis.com/youtube/v3"
VIDEOS_FILE = Path(__file__).resolve().parent.parent / "data" / "videos.json"
PAGE_SIZE = 50  # maximum, které API dovolí na jednu stránku
TIMEOUT_S = 30
SKIPPED_TITLES = {"Deleted video", "Private video"}

DURATION_RE = re.compile(
    r"^P(?:(?P<days>\d+)D)?"
    r"(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?)?$"
)


class ApiError(Exception):
    """Chyba z YouTube Data API."""


def api_get(endpoint: str, params: dict[str, str], key: str) -> dict:
    query = urllib.parse.urlencode({**params, "key": key})
    url = f"{API_BASE}/{endpoint}?{query}"
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return json.load(response)
    except urllib.error.HTTPError as err:
        # Do chybové hlášky nikdy nedávej URL, obsahuje API klíč.
        detail = ""
        try:
            body = json.load(err)
            error = body.get("error", {})
            reasons = ", ".join(
                e.get("reason", "") for e in error.get("errors", []) if e.get("reason")
            )
            detail = f"{error.get('message', '')} ({reasons})" if reasons else error.get("message", "")
        except (ValueError, AttributeError):
            pass
        raise ApiError(f"{endpoint}: HTTP {err.code} {detail}".strip()) from None
    except urllib.error.URLError as err:
        raise ApiError(f"{endpoint}: spojení selhalo ({err.reason})") from None


def fetch_playlist_video_ids(playlist_id: str, key: str) -> list[str]:
    ids: list[str] = []
    page_token = ""
    while True:
        params = {
            "part": "snippet,contentDetails,status",
            "playlistId": playlist_id,
            "maxResults": str(PAGE_SIZE),
        }
        if page_token:
            params["pageToken"] = page_token
        data = api_get("playlistItems", params, key)
        for item in data.get("items", []):
            snippet = item.get("snippet", {})
            status = item.get("status", {})
            video_id = item.get("contentDetails", {}).get("videoId") or snippet.get(
                "resourceId", {}
            ).get("videoId")
            if not video_id:
                continue
            if status.get("privacyStatus") == "private":
                continue
            if snippet.get("title") in SKIPPED_TITLES:
                continue
            if video_id not in ids:
                ids.append(video_id)
        page_token = data.get("nextPageToken", "")
        if not page_token:
            return ids


def fetch_video_details(video_ids: list[str], key: str) -> dict[str, dict]:
    details: dict[str, dict] = {}
    for start in range(0, len(video_ids), PAGE_SIZE):
        chunk = video_ids[start : start + PAGE_SIZE]
        data = api_get(
            "videos",
            {"part": "snippet,contentDetails,status", "id": ",".join(chunk), "maxResults": str(PAGE_SIZE)},
            key,
        )
        for item in data.get("items", []):
            details[item["id"]] = item
    return details


def format_duration(iso: str) -> str:
    """PT2M4S -> 2:04, PT1H2M3S -> 1:02:03."""
    match = DURATION_RE.match(iso or "")
    if not match:
        return ""
    parts = {k: int(v) if v else 0 for k, v in match.groupdict().items()}
    total = ((parts["days"] * 24 + parts["hours"]) * 60 + parts["minutes"]) * 60 + parts["seconds"]
    hours, rest = divmod(total, 3600)
    minutes, seconds = divmod(rest, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


def videos_word(count: int) -> str:
    if count == 1:
        return "video"
    if 2 <= count <= 4:
        return "videa"
    return "videí"


def clean_title(title: str) -> str:
    """Odstraní slova začínající # a srazí mezery."""
    without_tags = " ".join(word for word in title.split() if not word.startswith("#"))
    return without_tags or " ".join(title.split())


def build_videos(playlist_id: str, key: str) -> list[dict]:
    ids = fetch_playlist_video_ids(playlist_id, key)
    details = fetch_video_details(ids, key)
    videos = []
    for video_id in ids:
        item = details.get(video_id)
        if item is None:  # smazané nebo nedostupné video
            continue
        if item.get("status", {}).get("privacyStatus") == "private":
            continue
        videos.append(
            {
                "id": video_id,
                "title": clean_title(item.get("snippet", {}).get("title", "")),
                "duration": format_duration(item.get("contentDetails", {}).get("duration", "")),
            }
        )
    return videos


def main() -> int:
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not key:
        print("Chybí proměnná prostředí YOUTUBE_API_KEY.", file=sys.stderr)
        return 2
    playlist_id = os.environ.get("YOUTUBE_PLAYLIST_ID", "").strip() or PLAYLIST_ID

    try:
        videos = build_videos(playlist_id, key)
    except ApiError as err:
        print(f"YouTube API vrátilo chybu, data/videos.json zůstává beze změny: {err}", file=sys.stderr)
        return 1

    if not videos:
        print("Playlist nevrátil žádné video, data/videos.json zůstává beze změny.", file=sys.stderr)
        return 1

    new_content = json.dumps(videos, ensure_ascii=False, indent=2) + "\n"
    old_content = VIDEOS_FILE.read_text(encoding="utf-8") if VIDEOS_FILE.exists() else ""
    if new_content == old_content:
        print(f"Beze změny ({len(videos)} {videos_word(len(videos))}).")
        return 0

    VIDEOS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = VIDEOS_FILE.with_suffix(".json.tmp")
    tmp.write_text(new_content, encoding="utf-8")
    tmp.replace(VIDEOS_FILE)
    print(f"Zapsáno {len(videos)} {videos_word(len(videos))} do data/videos.json.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Populate the BASE Viewer default asset bank.

For each species in output/known_species.json:
  - Downloads the best available CC-licensed photo from Wikimedia Commons
  - Downloads the best available CC-licensed recording from xeno-canto

Output:
  viewer/assets/images/{key}.jpg
  viewer/assets/sounds/{key}.mp3
  viewer/assets/attribution.json   machine-readable credits
  viewer/assets/CREDITS.md         human-readable credits

Skips files that already exist so the script is safe to re-run.

Usage (from repo root):
  python viewer/fetch_assets.py

Author: David Green, Blenheim Palace
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────────────

REPO_ROOT   = Path(__file__).parent.parent
SPECIES_DB  = REPO_ROOT / "output" / "known_species.json"
IMG_DIR     = REPO_ROOT / "viewer" / "assets" / "images"
SND_DIR     = REPO_ROOT / "viewer" / "assets" / "sounds"
ATTR_FILE   = REPO_ROOT / "viewer" / "assets" / "attribution.json"
CREDITS_FILE = REPO_ROOT / "viewer" / "assets" / "CREDITS.md"

UA = "BASE-Viewer/1.0 (https://github.com/blenheiminnovation/BioAcousticStreamEngine)"

# ── Helpers ───────────────────────────────────────────────────────────────────

def species_key(name: str) -> str:
    """Convert a common name to the viewer's asset filename key."""
    s = name.lower().replace("'", "")
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text).strip()


def download(url: str, dest: Path) -> None:
    if not url.startswith("http"):
        url = "https:" + url
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        dest.write_bytes(r.read())


# ── Wikimedia Commons ─────────────────────────────────────────────────────────

def get_wikimedia_image(name: str) -> dict | None:
    """Return image metadata for the species' Wikipedia infobox photo."""

    # Step 1 — get the infobox image filename from Wikipedia
    params = urllib.parse.urlencode({
        "action": "query", "titles": name, "redirects": 1,
        "prop": "pageimages", "piprop": "name", "format": "json",
    })
    data = fetch_json(f"https://en.wikipedia.org/w/api.php?{params}")
    pages = data.get("query", {}).get("pages", {})
    filename = None
    for page in pages.values():
        if page.get("pageimage"):
            filename = "File:" + page["pageimage"]
            break

    if not filename:
        return None

    # Step 2 — get the file URL and attribution from Commons
    params = urllib.parse.urlencode({
        "action": "query", "titles": filename,
        "prop": "imageinfo", "iiprop": "url|extmetadata",
        "iiurlwidth": 1200, "format": "json",
    })
    data = fetch_json(f"https://commons.wikimedia.org/w/api.php?{params}")
    for page in data.get("query", {}).get("pages", {}).values():
        ii_list = page.get("imageinfo", [])
        if not ii_list:
            continue
        ii   = ii_list[0]
        meta = ii.get("extmetadata", {})

        license_short = meta.get("LicenseShortName", {}).get("value", "")
        # Accept any Creative Commons or public domain licence
        if not any(tok in license_short for tok in ("CC", "Public domain", "PDM")):
            return None

        artist = strip_html(meta.get("Artist", {}).get("value", "Unknown"))
        return {
            "url":         ii.get("thumburl") or ii.get("url"),
            "source_url":  ii.get("descriptionurl", ""),
            "artist":      artist,
            "license":     license_short,
            "license_url": meta.get("LicenseUrl", {}).get("value", ""),
        }
    return None


# ── Wikimedia Commons audio ───────────────────────────────────────────────────

def get_commons_audio(name: str) -> dict | None:
    """Search Wikimedia Commons for a CC-licensed audio recording of the species."""

    audio_exts = (".mp3", ".ogg", ".oga", ".flac", ".wav")

    for query in [f"{name} song", f"{name} call", name]:
        params = urllib.parse.urlencode({
            "action": "query", "list": "search",
            "srnamespace": 6, "srsearch": query,
            "srlimit": 10, "format": "json",
        })
        data = fetch_json(f"https://commons.wikimedia.org/w/api.php?{params}")
        results = data.get("query", {}).get("search", [])

        for result in results:
            title = result["title"]
            if not any(title.lower().endswith(ext) for ext in audio_exts):
                continue

            # Get file URL and attribution
            params2 = urllib.parse.urlencode({
                "action": "query", "titles": title,
                "prop": "imageinfo", "iiprop": "url|extmetadata",
                "format": "json",
            })
            meta_data = fetch_json(f"https://commons.wikimedia.org/w/api.php?{params2}")
            for page in meta_data.get("query", {}).get("pages", {}).values():
                ii_list = page.get("imageinfo", [])
                if not ii_list:
                    continue
                ii   = ii_list[0]
                meta = ii.get("extmetadata", {})
                license_short = meta.get("LicenseShortName", {}).get("value", "")
                if not any(tok in license_short for tok in ("CC", "Public domain", "PDM")):
                    continue
                artist = strip_html(meta.get("Artist", {}).get("value", "Unknown"))
                return {
                    "url":         ii.get("url", ""),
                    "source_url":  ii.get("descriptionurl", ""),
                    "filename":    title,
                    "artist":      artist,
                    "license":     license_short,
                    "license_url": meta.get("LicenseUrl", {}).get("value", ""),
                }
    return None


# ── Attribution files ─────────────────────────────────────────────────────────

def save_attribution(attribution: dict) -> None:
    ATTR_FILE.write_text(json.dumps(attribution, indent=2, ensure_ascii=False))


def write_credits(attribution: dict) -> None:
    lines = [
        "# BASE Viewer — Asset Credits\n\n",
        "Images and sounds are used under Creative Commons licences.\n",
        "Full licence text is available at the links below.\n\n",
    ]

    img_entries = [(n, a["image"]) for n, a in sorted(attribution.items()) if "image" in a]
    snd_entries = [(n, a["sound"]) for n, a in sorted(attribution.items()) if "sound" in a]

    if img_entries:
        lines.append("## Images — Wikimedia Commons\n\n")
        for name, im in img_entries:
            lic_link = f"[{im['license']}]({im['license_url']})" if im.get("license_url") else im["license"]
            lines.append(
                f"**{name}** — © {im['artist']} · {lic_link} · "
                f"[Wikimedia Commons]({im['source_url']})\n\n"
            )

    if snd_entries:
        lines.append("## Sounds — Wikimedia Commons\n\n")
        for name, sn in snd_entries:
            lic_link = f"[{sn['license']}]({sn['license_url']})" if sn.get("license_url") else sn["license"]
            lines.append(
                f"**{name}** — {sn['artist']} · {lic_link} · "
                f"[Wikimedia Commons]({sn['source_url']})\n\n"
            )

    CREDITS_FILE.write_text("".join(lines), encoding="utf-8")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    if not SPECIES_DB.exists():
        sys.exit(f"Species DB not found: {SPECIES_DB}")

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    SND_DIR.mkdir(parents=True, exist_ok=True)

    species   = list(json.loads(SPECIES_DB.read_text()).keys())
    attribution = json.loads(ATTR_FILE.read_text()) if ATTR_FILE.exists() else {}

    total = len(species)
    img_ok = img_skip = img_fail = 0
    snd_ok = snd_skip = snd_fail = 0

    for i, name in enumerate(species, 1):
        key      = species_key(name)
        img_path = IMG_DIR / f"{key}.jpg"
        snd_path = SND_DIR / f"{key}.mp3"
        print(f"[{i:3}/{total}] {name}")

        # ── Image ──
        if img_path.exists():
            print(f"         image  · already exists")
            img_skip += 1
        else:
            try:
                info = get_wikimedia_image(name)
                if info and info.get("url"):
                    download(info["url"], img_path)
                    attribution.setdefault(name, {})["image"] = {
                        k: v for k, v in info.items() if k != "url"
                    }
                    print(f"         image  ✓ {info['artist']} [{info['license']}]")
                    img_ok += 1
                else:
                    print(f"         image  – not found")
                    img_fail += 1
            except Exception as exc:
                print(f"         image  ✗ {exc}")
                img_fail += 1
            time.sleep(0.4)

        # ── Sound ──
        if snd_path.exists():
            print(f"         sound  · already exists")
            snd_skip += 1
        else:
            try:
                info = get_commons_audio(name)
                if info and info.get("url"):
                    download(info["url"], snd_path)
                    attribution.setdefault(name, {})["sound"] = {
                        k: v for k, v in info.items() if k != "url"
                    }
                    print(f"         sound  ✓ {info['artist']} [{info['license']}]")
                    snd_ok += 1
                else:
                    print(f"         sound  – not found")
                    snd_fail += 1
            except Exception as exc:
                print(f"         sound  ✗ {exc}")
                snd_fail += 1
            time.sleep(0.4)

        # Save incrementally so a crash doesn't lose progress
        save_attribution(attribution)
        write_credits(attribution)

    print(f"""
Done.
  Images: {img_ok} downloaded, {img_skip} skipped, {img_fail} not found
  Sounds: {snd_ok} downloaded, {snd_skip} skipped, {snd_fail} not found

Attribution: {ATTR_FILE}
Credits:     {CREDITS_FILE}
""")


if __name__ == "__main__":
    main()

"""UpdatePlaylistPage.py - publishes the music library page
(redgemmusic.github.io/playlist/) by exporting the library and pushing to git.

Run by hand (UpdatePlaylistPage.bat). Each run:
  1. scans the live playlist folder for the songs and their lengths
     (Music.db stores no lengths), keyed by the file's Comment = SongID,
  2. reads Music.db for each song's community rating, its raters' latest
     ratings, and its tags (read only - nothing is written),
  3. writes data/library.json, commits and pushes.

PRIVACY - the site is public: raters are published by USERNAME ONLY (a UserID
is a YouTube channel ID and must never be written out), and no rating or tag
times are published.

  python UpdatePlaylistPage.py            export, commit, push
  python UpdatePlaylistPage.py --no-push  export only (preview the page locally)
"""

import argparse
import datetime
import json
import os
import subprocess
import sys
from pathlib import Path

from mutagen import File

HERE = os.path.dirname(os.path.abspath(__file__))
# Scripts root (StreamPaths / MusicDBAccess): <root>\Documents\Scripts, and this
# folder is <root>\Music\LibraryPage.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "Documents", "Scripts"))
from StreamPaths import LIVE_PLAYLIST, MUSIC_DB  # noqa: E402
from MusicDBAccess import get_connection  # noqa: E402

MUSIC_EXTENSIONS = {'.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma'}
DATA_FILE = os.path.join(HERE, "data", "library.json")


def first(audio, *keys):
    """First non-empty value of the first tag present (Vorbis keys, then ID3 frames)."""
    for k in keys:
        try:
            v = audio.get(k)
        except Exception:
            v = None
        if v is None:
            continue
        if isinstance(v, list):
            v = v[0] if v else None
        if hasattr(v, "text"):          # ID3 frame
            v = v.text[0] if v.text else None
        if v is not None and str(v).strip():
            return str(v).strip()
    return None


def num(s, default):
    """'3/12' -> 3."""
    try:
        return int(str(s).split('/')[0])
    except (TypeError, ValueError):
        return default


def read_file(path):
    try:
        audio = File(path)
    except Exception as e:
        print(f"Error reading {path}: {e}")
        return None
    if not audio:
        return None
    comment = first(audio, 'comment', 'COMM::eng', 'COMM')
    return {
        "artist": first(audio, 'artist', 'TPE1') or "Unknown Artist",
        "title": first(audio, 'title', 'TIT2') or Path(path).stem,
        "album": first(audio, 'album', 'TALB') or "",
        "albumartist": first(audio, 'albumartist', 'album artist', 'TPE2') or "",
        "disc": num(first(audio, 'discnumber', 'TPOS'), 1),
        "track": num(first(audio, 'tracknumber', 'TRCK'), 0),
        "length": int(audio.info.length) if audio.info else None,
        "songid": int(comment) if comment and comment.isdigit() else None,
    }


def scan_library(root):
    print(f"Scanning {root}...")
    songs = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if Path(name).suffix.lower() in MUSIC_EXTENSIONS:
                s = read_file(os.path.join(dirpath, name))
                if s:
                    songs.append(s)
                    if len(songs) % 500 == 0:
                        print(f"  {len(songs)} files...")
    print(f"Total files: {len(songs)}")
    return songs


def read_db():
    """({SongID: WeightedRating}, {SongID: [(UserID, rating)]}, {SongID: [tags]}, {UserID: name})"""
    conn = get_connection(MUSIC_DB)
    try:
        q = lambda sql: conn.execute(sql).fetchall()
        # Community rating = WeightedRating, as the HUD shows it.
        weighted = {r["SongID"]: r["WeightedRating"] for r in q(
            "SELECT SongID, WeightedRating FROM SongData WHERE WeightedRating IS NOT NULL")}
        # Each rater's LATEST rating per song: a re-rate supersedes (TrustRecalc's rule).
        ratings = {}
        for r in q("""SELECT r.SongID, r.UserID, r.Rating FROM RatingData r
                      JOIN (SELECT MAX(RatingID) AS id FROM RatingData GROUP BY UserID, SongID) l
                        ON l.id = r.RatingID
                      WHERE r.Rating IS NOT NULL"""):
            ratings.setdefault(r["SongID"], []).append((r["UserID"], r["Rating"]))
        # Tags are unique per song, case-insensitively (SongRatingManager's rule).
        tags = {}
        for r in q("SELECT SongID, Tag FROM TagData WHERE TRIM(COALESCE(Tag, '')) <> '' ORDER BY TagID"):
            t = " ".join(r["Tag"].split())
            tags.setdefault(r["SongID"], {}).setdefault(t.lower(), t)
        tags = {sid: sorted(d.values(), key=str.lower) for sid, d in tags.items()}
        # Each rater's CURRENT name: from their newest rating or tag.
        names = {}
        for r in q("""SELECT UserID, Username FROM (
                          SELECT UserID, Username, TimeRated AS t FROM RatingData
                          UNION ALL SELECT UserID, Username, TimeTagged FROM TagData)
                      WHERE Username IS NOT NULL AND Username <> '' ORDER BY t"""):
            names[r["UserID"]] = r["Username"]
        conn.rollback()
    finally:
        conn.close()
    return weighted, ratings, tags, names


def build_payload(files, weighted, ratings, tags, names):
    users, user_ix = [], {}
    songs, out_ratings = [], []
    for f in files:
        sid = f["songid"]
        # Disguised names (CLAUDE.md, "alternative names"): Album = the real game
        # when it differs from the Artist; Album Artist = the real title when set
        # and different from both. The page searches them but never shows them.
        alt_game = f["album"] if f["album"] and f["album"] != f["artist"] else ""
        alt_title = (f["albumartist"] if f["albumartist"]
                     and f["albumartist"] not in (f["artist"], f["title"]) else "")
        rs = ratings.get(sid, [])
        songs.append([f["artist"], f["title"], f["length"],
                      round(weighted[sid], 2) if sid in weighted else None, len(rs),
                      tags.get(sid, []), f["album"], f["disc"], f["track"], alt_game, alt_title])
        for uid, rating in rs:
            if uid not in user_ix:
                user_ix[uid] = len(users)
                users.append(names.get(uid) or "Unknown")
            out_ratings.append([len(songs) - 1, user_ix[uid], rating])
    return {
        "updated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "users": users,
        # [game, title, lengthSeconds|null, communityRating|null, raters, [tags],
        #  album, disc, track, altGame, altTitle]
        "songs": songs,
        # [songIndex, userIndex, rating]
        "ratings": out_ratings,
    }


def git(*args):
    print("git " + " ".join(args))
    subprocess.run(["git", *args], cwd=HERE, check=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-push", action="store_true", help="write the data file only")
    args = ap.parse_args()

    if not os.path.isdir(LIVE_PLAYLIST):
        print(f"Error: {LIVE_PLAYLIST} does not exist!")
        return 1
    files = scan_library(LIVE_PLAYLIST)
    if not files:
        print("No music files found!")
        return 1
    payload = build_payload(files, *read_db())
    no_id = sum(1 for f in files if f["songid"] is None)
    if no_id:
        print(f"Warning: {no_id} file(s) have no numeric SongID comment (shown with no rating or tags).")

    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, DATA_FILE)
    print(f"Wrote {DATA_FILE}: {len(payload['songs'])} songs, {len(payload['ratings'])} ratings, "
          f"{len(payload['users'])} raters")

    if args.no_push:
        return 0
    git("add", "-A")
    git("commit", "-m", "Update music library")
    git("push")
    print("Pushed to GitHub!")
    return 0


if __name__ == "__main__":
    sys.exit(main())

import os
import csv
from pathlib import Path
from mutagen import File
from mutagen.mp3 import MP3
from mutagen.flac import FLAC
from mutagen.oggvorbis import OggVorbis
from mutagen.wave import WAVE
from mutagen.mp4 import MP4
from mutagen.asf import ASF

def get_track_length(filepath):
    """Get track length in MM:SS format"""
    try:
        audio = File(filepath)
        if audio and audio.info:
            length_seconds = int(audio.info.length)
            minutes = length_seconds // 60
            seconds = length_seconds % 60
            return f"{minutes}:{seconds:02d}"
    except Exception as e:
        print(f"Error reading {filepath}: {e}")
    return "Unknown"

def get_metadata(filepath):
    """Extract artist, title, album, album artist, disc, and track from file metadata"""
    try:
        audio = File(filepath)
        if audio:
            artist = audio.get('artist', [None])[0] if isinstance(audio.get('artist'), list) else audio.get('artist')
            title = audio.get('title', [None])[0] if isinstance(audio.get('title'), list) else audio.get('title')
            album = audio.get('album', [None])[0] if isinstance(audio.get('album'), list) else audio.get('album')
            album_artist = audio.get('albumartist', [None])[0] if isinstance(audio.get('albumartist'), list) else audio.get('albumartist')
            disc = audio.get('discnumber', [None])[0] if isinstance(audio.get('discnumber'), list) else audio.get('discnumber')
            track = audio.get('tracknumber', [None])[0] if isinstance(audio.get('tracknumber'), list) else audio.get('tracknumber')
            
            # Handle different tag formats
            if artist is None:
                artist = audio.get('TPE1', [None])[0] if 'TPE1' in audio else None
            if title is None:
                title = audio.get('TIT2', [None])[0] if 'TIT2' in audio else None
            if album is None:
                album = audio.get('TALB', [None])[0] if 'TALB' in audio else None
            if album_artist is None:
                album_artist = audio.get('TPE2', [None])[0] if 'TPE2' in audio else None
            if disc is None:
                disc = audio.get('TPOS', [None])[0] if 'TPOS' in audio else None
            if track is None:
                track = audio.get('TRCK', [None])[0] if 'TRCK' in audio else None
            
            # Clean disc/track (they often come as "1/2" format, we want just the first number)
            if disc and '/' in str(disc):
                disc = str(disc).split('/')[0]
            if track and '/' in str(track):
                track = str(track).split('/')[0]
            
            # Fallbacks
            if not title:
                title = Path(filepath).stem
            if not artist:
                artist = "Unknown Artist"
            if not album:
                album = ""
            if not album_artist:
                album_artist = ""
            if not disc:
                disc = "1"
            if not track:
                track = "0"
            
            return str(artist), str(title), str(album), str(album_artist), str(disc), str(track)
    except Exception as e:
        print(f"Error reading metadata from {filepath}: {e}")
    
    return "Unknown Artist", Path(filepath).stem, "", "", "1", "0"

def scan_music_library(root_path):
    """Recursively scan directory for music files"""
    music_extensions = {'.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma'}
    music_data = []
    
    print(f"Scanning {root_path}...")
    
    for root, dirs, files in os.walk(root_path):
        for file in files:
            if Path(file).suffix.lower() in music_extensions:
                filepath = os.path.join(root, file)
                artist, title, album, album_artist, disc, track = get_metadata(filepath)
                length = get_track_length(filepath)
                music_data.append([artist, title, length, album, album_artist, disc, track])
                
                if len(music_data) % 100 == 0:
                    print(f"Processed {len(music_data)} files...")
    
    print(f"Total files processed: {len(music_data)}")
    return music_data

def write_csv(data, output_path):
    """Write music data to CSV file"""
    with open(output_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f, delimiter=',')
        writer.writerow(['Artist', 'Title', 'Length', 'Album', 'AlbumArtist', 'Disc', 'Track'])
        writer.writerows(data)
    print(f"CSV written to {output_path}")

def main():
    music_path = r"D:\Music\Playlist"
    output_csv = "music_library.csv"
    
    if not os.path.exists(music_path):
        print(f"Error: Path {music_path} does not exist!")
        return
    
    music_data = scan_music_library(music_path)
    
    if music_data:
        write_csv(music_data, output_csv)
        print("\nDone! Now pushing to GitHub...")
        
        # Git commands
        os.system('git add -A')
        os.system('git commit -m "Update music library"')
        os.system('git push')
        print("Pushed to GitHub!")
    else:
        print("No music files found!")

if __name__ == "__main__":
    main()
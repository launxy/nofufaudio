#!/usr/bin/env python3
"""
spotify_scraper_helper.py
Extrae datos de una playlist de Spotify usando SpotifyScraper (sin API key).
Uso: python3 spotify_scraper_helper.py <playlist_url>
Salida: JSON por stdout. SOLO JSON, nada más.
"""

import sys
import io
import json
import logging

# Forzar stdout a UTF-8 en Windows (evita UnicodeEncodeError con cp1252)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# Redirigir TODOS los logs (SpotifyScraper, requests, etc.) a stderr
# para que stdout sea JSON puro
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

# Silenciar librerías que loguean a stdout o al root logger
for name in ('spotify_scraper', 'urllib3', 'requests', 'selenium'):
    logging.getLogger(name).setLevel(logging.ERROR)


def main():
    if len(sys.argv) < 2:
        sys.stderr.write(json.dumps({"error": "Falta URL de playlist"}) + "\n")
        sys.exit(1)

    playlist_url = sys.argv[1]

    try:
        from spotify_scraper import SpotifyClient
    except ImportError:
        sys.stderr.write(json.dumps({"error": "spotifyscraper no instalado. Ejecuta: pip install spotifyscraper"}) + "\n")
        sys.exit(1)

    try:
        # log_level='ERROR' para que SpotifyScraper no imprima nada en stdout
        client = SpotifyClient(log_level='ERROR')
        playlist = client.get_playlist_info(playlist_url)
        client.close()
    except Exception as e:
        sys.stderr.write(json.dumps({"error": str(e)}) + "\n")
        sys.exit(1)

    playlist_title = playlist.get('name', 'Playlist de Spotify')
    raw_tracks = playlist.get('tracks', [])

    tracks = []
    for t in raw_tracks:
        if not t or not t.get('name'):
            continue
        artists = t.get('artists', [])
        artist_str = ', '.join(
            a['name'] for a in artists if isinstance(a, dict) and a.get('name')
        )
        album_info = t.get('album', {}) or {}
        images = album_info.get('images', []) if isinstance(album_info, dict) else []
        cover = ''
        if images:
            cover = images[1]['url'] if len(images) > 1 else images[0].get('url', '')

        duration_ms = t.get('duration_ms', 0) or 0
        tracks.append({
            'id':       t.get('id') or t.get('name', ''),
            'title':    t.get('name', ''),
            'artist':   artist_str,
            'album':    album_info.get('name', '') if isinstance(album_info, dict) else '',
            'cover':    cover,
            'duration': int(duration_ms / 1000),
        })

    result = {
        'playlistTitle': playlist_title,
        'tracks': tracks,
    }

    # Única escritura en stdout: el JSON limpio
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == '__main__':
    main()

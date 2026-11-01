from spotdl import Spotdl

def download_playlist(spotify_url):
    # Inicializamos Spotdl. (Si tienes algún error aquí, puedes probar a dejarlo solo como spotdl = Spotdl() )
    spotdl = Spotdl(client_id=None, client_secret=None)
    
    print(f"\nAnalizando la playlist: {spotify_url}...")
    try:
        # AQUÍ ESTÁ EL CAMBIO: usamos search y metemos la URL entre corchetes
        songs = spotdl.search([spotify_url])
        print(f"Se encontraron {len(songs)} canciones. Iniciando descarga...\n")
        
        # Descargar las canciones a la carpeta actual
        spotdl.download_songs(songs)
        
        print("\n¡Proceso terminado! Tus canciones se han guardado en esta carpeta.")
        
    except Exception as e:
        print(f"\nOcurrió un error durante el proceso: {e}")

if __name__ == "__main__":
    print("--- DESCARGADOR DE PLAYLISTS DE SPOTIFY ---")
    url = input("Pega la URL de la playlist de Spotify: ")
    
    # Verificación sencilla para evitar que se cuelgue si no pones nada
    if url.strip():
        download_playlist(url)
    else:
        print("No ingresaste ninguna URL válida.")
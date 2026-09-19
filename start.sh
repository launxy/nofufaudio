#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
#  NofufAudio — Lanzador para Linux
#  Compatible con CachyOS, Arch, Ubuntu, Fedora, Debian...
#  Solo necesitas tener Node.js instalado (o npm/pnpm).
# ═══════════════════════════════════════════════════════════

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colores ──────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[nofufaudio]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
error()   { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo -e "${BOLD}"
echo "  ███╗   ██╗ ██████╗ ███████╗██╗   ██╗███████╗"
echo "  ████╗  ██║██╔═══██╗██╔════╝██║   ██║██╔════╝"
echo "  ██╔██╗ ██║██║   ██║█████╗  ██║   ██║█████╗  "
echo "  ██║╚██╗██║██║   ██║██╔══╝  ██║   ██║██╔══╝  "
echo "  ██║ ╚████║╚██████╔╝██║     ╚██████╔╝██║     "
echo "  ╚═╝  ╚═══╝ ╚═════╝ ╚═╝      ╚═════╝ ╚═╝     "
echo -e "${NC}"

# ── 1. Comprobar Node.js ─────────────────────────────────
if ! command -v node &>/dev/null; then
  error "Node.js no encontrado. Instálalo desde https://nodejs.org o con tu gestor de paquetes:\n       sudo pacman -S nodejs npm  (Arch/CachyOS)\n       sudo apt install nodejs npm  (Debian/Ubuntu)\n       sudo dnf install nodejs  (Fedora)"
fi
NODE_VER=$(node -e "process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "old")
if [ "$NODE_VER" = "old" ]; then
  warn "Node.js $(node --version) detectado. Se recomienda Node 18+."
fi
success "Node.js $(node --version) OK"

# ── 2. Instalar dependencias npm si hacen falta ──────────
if [ ! -d "node_modules/electron" ]; then
  info "Instalando dependencias (primera vez — tarda un poco)..."
  npm install --prefer-offline 2>&1 | grep -E "added|warn|error|npm" | head -20 || true
  success "Dependencias instaladas"
else
  success "Dependencias ya presentes"
fi

# ── 3. Descargar yt-dlp para Linux si no existe ──────────
YTDLP_BIN="$SCRIPT_DIR/yt-dlp"

if [ ! -f "$YTDLP_BIN" ]; then
  info "yt-dlp no encontrado — descargando binario de GitHub..."

  # Detectar arquitectura
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)       YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" ;;
    aarch64|arm64) YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64" ;;
    armv7l)       YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_armv7l" ;;
    *)
      warn "Arquitectura $ARCH no reconocida. Intentando binario genérico x86_64..."
      YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"
      ;;
  esac

  # Intentar con curl o wget
  if command -v curl &>/dev/null; then
    curl -L --progress-bar "$YTDLP_URL" -o "$YTDLP_BIN"
  elif command -v wget &>/dev/null; then
    wget -q --show-progress "$YTDLP_URL" -O "$YTDLP_BIN"
  else
    error "curl y wget no encontrados. Instala uno de ellos:\n       sudo pacman -S curl  (Arch/CachyOS)\n       sudo apt install curl  (Debian/Ubuntu)"
  fi

  chmod +x "$YTDLP_BIN"
  success "yt-dlp descargado en $YTDLP_BIN"
else
  # Asegurar permisos de ejecución aunque ya exista
  chmod +x "$YTDLP_BIN" 2>/dev/null || true
  success "yt-dlp OK ($(\"$YTDLP_BIN\" --version 2>/dev/null || echo 'presente'))"
fi

# ── 4. Detectar y eliminar posibles yt-dlp.exe ───────────
if [ -f "$SCRIPT_DIR/yt-dlp.exe" ] && [ ! -f "$YTDLP_BIN" ]; then
  warn "Se encontró yt-dlp.exe (Windows) pero no yt-dlp (Linux). El .exe no es ejecutable en Linux."
fi

# ── 5. Lanzar Electron ──────────────────────────────────
info "Iniciando NofufAudio..."
exec npx electron . "$@"

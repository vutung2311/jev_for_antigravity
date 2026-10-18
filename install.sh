#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Jev System One Co-Processor Installer for Google Antigravity
# Installs Jev Executive Decision Engine (PreInvocation) and Real-Time Code &
# Command Guardrails (PreToolUse) across Antigravity, Antigravity IDE, and CLI.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_HOME="${HOME}"
CONFIG_DIR="${TARGET_HOME}/.gemini/config"
PLUGIN_DEST="${CONFIG_DIR}/plugins/jev-coprocessor"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

MODE="install"
API_KEY_ARG=""

usage() {
    cat <<EOF
Usage: ./install.sh [OPTIONS]

Options:
  --install            Install or update the Jev plugin and hooks (default)
  --uninstall          Remove the Jev plugin and hooks from Antigravity
  --check              Verify installation status and test Jev API connectivity
  --api-key <KEY>      Configure TYPESAFE_API_KEY in ~/.zshenv and systemd user env
  -h, --help           Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --install)
            MODE="install"
            shift
            ;;
        --uninstall)
            MODE="uninstall"
            shift
            ;;
        --check)
            MODE="check"
            shift
            ;;
        --api-key)
            if [[ $# -lt 2 ]]; then
                echo -e "${RED}Error: --api-key requires a value${NC}" >&2
                exit 1
            fi
            API_KEY_ARG="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}" >&2
            usage
            exit 1
            ;;
    esac
done

check_prerequisites() {
    local missing=0
    for cmd in node rg git; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            echo -e "${RED}✗ Missing required dependency: $cmd${NC}" >&2
            missing=1
        fi
    done
    if [[ $missing -ne 0 ]]; then
        echo -e "${YELLOW}Please install Node.js (>= 18), ripgrep (rg), and git before continuing.${NC}" >&2
        exit 1
    fi
}

configure_api_key() {
    local key="$1"
    if [[ -z "$key" ]]; then
        return 0
    fi
    local zshenv="${TARGET_HOME}/.zshenv"
    touch "$zshenv"
    chmod 600 "$zshenv"
    if grep -q "^export TYPESAFE_API_KEY=" "$zshenv" 2>/dev/null; then
        sed -i "s|^export TYPESAFE_API_KEY=.*|export TYPESAFE_API_KEY=\"${key}\"|" "$zshenv"
    else
        printf '\nexport TYPESAFE_API_KEY="%s"\n' "$key" >> "$zshenv"
    fi
    export TYPESAFE_API_KEY="$key"
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user set-environment TYPESAFE_API_KEY="$key" 2>/dev/null || true
    fi
    echo -e "  ${GREEN}✓ Configured TYPESAFE_API_KEY in ~/.zshenv and user environment${NC}"
}

enable_plugin_in_config() {
    local cfg_file="${CONFIG_DIR}/config.json"
    mkdir -p "$CONFIG_DIR"
    node -e '
const fs = require("node:fs");
const file = process.argv[1];
const enable = process.argv[2] === "true";
let cfg = {};
if (fs.existsSync(file)) {
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    cfg = {};
  }
}
cfg.plugins = cfg.plugins || {};
if (enable) {
  cfg.plugins["jev-coprocessor"] = { enabled: true };
} else {
  delete cfg.plugins["jev-coprocessor"];
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
' "$cfg_file" "$1"
}

run_smoke_check() {
    echo -e "${CYAN}Running Jev Co-Processor health check...${NC}"
    if [[ ! -f "${PLUGIN_DEST}/bin/jev-hook.mjs" ]]; then
        echo -e "  ${RED}✗ Plugin not installed at ${PLUGIN_DEST}${NC}" >&2
        exit 1
    fi
    echo -e "  ${GREEN}✓ Plugin scripts present at ${PLUGIN_DEST}${NC}"

    for agy_dir in "${TARGET_HOME}/.gemini/antigravity" "${TARGET_HOME}/.gemini/antigravity-ide"; do
        if [[ -d "$agy_dir" ]]; then
            if [[ -L "${agy_dir}/hooks.json" && -L "${agy_dir}/plugins/jev-coprocessor" ]]; then
                echo -e "  ${GREEN}✓ Linked into ${agy_dir}${NC}"
            else
                echo -e "  ${YELLOW}! Missing symlinks in ${agy_dir} (run ./install.sh to repair)${NC}"
            fi
        fi
    done

    local out
    out="$(node "${PLUGIN_DEST}/bin/jev-hook.mjs" PreToolUse <<'EOF'
{"conversationId":"install-health-check","stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"go test ./... || true","Cwd":"/tmp"}}}
EOF
)"
    if echo "$out" | grep -q '"overwrite"'; then
        echo -e "  ${GREEN}✓ Live Jev System One API & PreToolUse overwrite verified:${NC} $out"
    else
        echo -e "  ${YELLOW}! Hook responded without live overwrite (check TYPESAFE_API_KEY in environment / ~/.zshenv):${NC} $out"
    fi
}

install_plugin() {
    check_prerequisites
    echo -e "${CYAN}Installing Jev System One Co-Processor for Antigravity...${NC}"

    if [[ -n "$API_KEY_ARG" ]]; then
        configure_api_key "$API_KEY_ARG"
    fi

    mkdir -p "${PLUGIN_DEST}/bin" "${PLUGIN_DEST}/assets"

    install -m 644 "${SCRIPT_DIR}/hooks.json" "${CONFIG_DIR}/hooks.json"
    install -m 644 "${SCRIPT_DIR}/plugins/jev-coprocessor/hooks.json" "${PLUGIN_DEST}/hooks.json"
    install -m 644 "${SCRIPT_DIR}/plugins/jev-coprocessor/plugin.json" "${PLUGIN_DEST}/plugin.json"
    install -m 644 "${SCRIPT_DIR}/plugins/jev-coprocessor/README.md" "${PLUGIN_DEST}/README.md"
    install -m 644 "${SCRIPT_DIR}/plugins/jev-coprocessor/assets/logo.svg" "${PLUGIN_DEST}/assets/logo.svg"
    install -m 755 "${SCRIPT_DIR}/plugins/jev-coprocessor/bin/jev-client.mjs" "${PLUGIN_DEST}/bin/jev-client.mjs"
    install -m 755 "${SCRIPT_DIR}/plugins/jev-coprocessor/bin/jev-hook.mjs" "${PLUGIN_DEST}/bin/jev-hook.mjs"

    enable_plugin_in_config "true"
    echo -e "  ${GREEN}✓ Installed plugin and hooks to ${CONFIG_DIR}${NC}"

    for agy_dir in "${TARGET_HOME}/.gemini/antigravity" "${TARGET_HOME}/.gemini/antigravity-ide"; do
        mkdir -p "${agy_dir}/plugins"
        ln -sfn "${CONFIG_DIR}/hooks.json" "${agy_dir}/hooks.json"
        ln -sfn "${PLUGIN_DEST}" "${agy_dir}/plugins/jev-coprocessor"
        echo -e "  ${GREEN}✓ Linked hooks and plugin into ${agy_dir}${NC}"
    done

    echo ""
    run_smoke_check
    echo ""
    echo -e "${GREEN}Done! Jev System One Co-Processor is active by default for Antigravity & Antigravity IDE.${NC}"
}

uninstall_plugin() {
    echo -e "${CYAN}Uninstalling Jev System One Co-Processor...${NC}"
    for agy_dir in "${TARGET_HOME}/.gemini/antigravity" "${TARGET_HOME}/.gemini/antigravity-ide"; do
        rm -f "${agy_dir}/hooks.json" "${agy_dir}/plugins/jev-coprocessor"
    done
    rm -f "${CONFIG_DIR}/hooks.json"
    rm -rf "${PLUGIN_DEST}"
    enable_plugin_in_config "false"
    echo -e "${GREEN}✓ Uninstalled Jev Co-Processor from Antigravity.${NC}"
}

case "$MODE" in
    install)
        install_plugin
        ;;
    uninstall)
        uninstall_plugin
        ;;
    check)
        run_smoke_check
        ;;
esac

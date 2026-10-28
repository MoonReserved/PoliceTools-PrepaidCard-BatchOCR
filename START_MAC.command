#!/bin/sh
# Double-click from Finder after extracting the complete project ZIP.
# No Python installation is required. Only this package's executable mode
# may be repaired below; macOS quarantine and security settings are untouched.

POLICE_PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd -- "$POLICE_PROJECT_DIR" || exit 1

case "$(uname -s)" in
  Darwin) ;;
  *)
    printf '%s\n' 'This launcher is for macOS. On Windows, use START_WINDOWS.bat.'
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64) POLICE_BINARY="$POLICE_PROJECT_DIR/local-server/bin/police-ocr-server-macos-arm64" ;;
  x86_64) POLICE_BINARY="$POLICE_PROJECT_DIR/local-server/bin/police-ocr-server-macos-amd64" ;;
  *)
    printf '%s\n' 'Unsupported Mac architecture. This package supports Apple silicon and Intel 64-bit Macs.'
    printf '%s' 'Press Enter to close. '
    read -r POLICE_REPLY
    exit 1
    ;;
esac

if [ ! -f "$POLICE_BINARY" ] || [ ! -f "$POLICE_PROJECT_DIR/docs/index.html" ]; then
  printf '%s\n' 'The project is incomplete. Extract the entire ZIP before starting.'
  printf '%s\n' '專案檔案不完整。請先完整解壓縮 ZIP，再雙擊啟動工具。'
  printf '%s' 'Press Enter to close / 按 Enter 關閉。 '
  read -r POLICE_REPLY
  exit 1
fi

if [ ! -x "$POLICE_BINARY" ]; then
  chmod u+x "$POLICE_BINARY" || {
    printf '%s\n' 'Cannot set the executable permission on the bundled server.'
    printf '%s' 'Press Enter to close. '
    read -r POLICE_REPLY
    exit 1
  }
fi

"$POLICE_BINARY" --root "$POLICE_PROJECT_DIR/docs" "$@"
POLICE_EXIT=$?
if [ "$POLICE_EXIT" -ne 0 ]; then
  printf '\n%s\n' 'If macOS blocked this program, review its message in System Settings > Privacy & Security.'
  printf '%s\n' '若 macOS 顯示阻擋訊息，請依系統提示確認來源與允許開啟；不要關閉整體保護。'
  printf '%s' 'Press Enter to close / 按 Enter 關閉。 '
  read -r POLICE_REPLY
fi
exit "$POLICE_EXIT"

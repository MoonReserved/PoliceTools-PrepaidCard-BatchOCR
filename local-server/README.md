# 本機雙擊啟動器

這個資料夾包含「警政小工具-點數卡批次OCR辨識」的本機靜態網站啟動器。完整解壓縮專案後，在專案最外層雙擊：

- **macOS：`START_MAC.command`**
- **Windows：`START_WINDOWS.bat`**

啟動器會自動選擇對應 CPU 的程式，開啟 [http://127.0.0.1:8787/](http://127.0.0.1:8787/)。不需要另外安裝 Python、Go、Node.js 或任何套件，也不會在啟動時下載執行環境。

請保留啟動視窗；結束使用時可按 `Ctrl+C` 停止本機服務。若瀏覽器沒有自動開啟，手動輸入視窗中的網址即可。

## 平台

| 檔案 | 平台 |
| --- | --- |
| `bin/police-ocr-server-macos-arm64` | macOS 13 Ventura 以上，Apple silicon（M 系列） |
| `bin/police-ocr-server-macos-amd64` | macOS 13 Ventura 以上，Intel 64 位元 |
| `bin/police-ocr-server-windows-amd64.exe` | Windows 10／11，x64（Intel／AMD） |
| `bin/police-ocr-server-windows-arm64.exe` | Windows ARM64；建議 Windows 11 |

macOS 最低版本依 [Go 1.27 官方發布說明](https://go.dev/doc/go1.27#darwin)。實際 OCR 可用性仍取決於瀏覽器、記憶體及其 WebAssembly 等功能。

本次已在 Linux 執行同一份伺服器來源的測試，並完成四種目標平台的交叉編譯與執行檔格式檢查；尚未在實體 Mac／Windows 電腦驗證雙擊流程。隨附程式沒有 Apple Developer ID 公證或 Windows 發行者簽章，第一次啟動可能需要依系統提示確認來源；請遵守組織的應用程式政策，不要關閉整體保護。

## 與網站的關係

伺服器只讀取專案中的 `docs/`，綁定位址固定為 `127.0.0.1`，不向區域網路公開。它不提供上傳、OCR API 或資料儲存功能；圖片和 PDF 仍由瀏覽器讀取與辨識。

它只接受 `GET`／`HEAD`，拒絕其他 HTTP 方法，不顯示資料夾清單，並限制 Host 與跨來源資源要求。檔案操作使用 Go `os.Root`，防止透過路徑或符號連結讀取 `docs` 以外的內容。

GitHub Pages 只需發布 `docs/`。本資料夾可留在儲存庫最外層供下載，但不需要放入 `docs`，手機瀏覽網站時也不會下載這些桌面啟動器。

## 常見啟動問題

- **8787 已被占用**：先關閉另一個本機啟動視窗。若需要同時開啟另一份專案，可在專案資料夾執行 `./START_MAC.command --port 8788`（macOS）或 `START_WINDOWS.bat --port 8788`（Windows），再使用視窗顯示的網址。
- **改埠之後需要重新準備離線資源**：瀏覽器將不同埠視為不同來源；第一次使用新的埠時需重新建立快取。
- **Mac 從 GitHub 重新下載後顯示沒有執行權限**：網頁上傳可能不保留 Unix 執行位元。在專案資料夾執行 `chmod u+x START_MAC.command`，再雙擊。腳本會只為當次選中的隨附伺服器補上執行權限；不更動 quarantine 或系統安全設定。
- **程式或 docs 找不到**：完整解壓縮專案，不要只取出啟動檔，也不要在壓縮檔預覽中直接執行。
- **Windows 網路磁碟路徑不能啟動**：先複製完整專案到本機磁碟，再解壓縮及執行。

已安裝 Python 3 的使用者，也可回到專案最外層使用 `python3 serve.py`；Windows 可使用 `py -3 serve.py`。這是保留的後備方式，一般雙擊啟動不依賴 Python。

## 來源與重新編譯

主程式為 [main.go](main.go)，測試為 [main_test.go](main_test.go)。隨附程式以官方 Go **1.27.3**、`CGO_ENABLED=0` 建置；各檔案 SHA-256 與工具鏈來源列在 [BUILD_INFO.json](BUILD_INFO.json)。

以下命令在已安裝 Go 1.27.3 的 macOS／Linux 終端機執行，位置為本資料夾。重新編譯不需要外部 Go 套件：

```bash
go test ./...
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o bin/police-ocr-server-macos-arm64 .
CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o bin/police-ocr-server-macos-amd64 .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o bin/police-ocr-server-windows-amd64.exe .
CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o bin/police-ocr-server-windows-arm64.exe .
```

進階使用可直接執行對應平台的程式：

```text
police-ocr-server --root <專案中的 docs 路徑> --port 8787 --no-browser
```

`--no-browser` 只取消自動開啟瀏覽器；`--port 0` 可供測試時選取可用埠，實際網址會輸出到終端機。預設資料夾根據執行檔所在的 `local-server/bin` 位置推算，不依賴目前工作目錄。

## 第三方授權

Go 執行環境與標準函式庫依其原有授權使用，請保留：

- [Go BSD 授權](LICENSE_GO.txt)
- [Go 專利授權聲明](PATENTS_GO.txt)
- [其他第三方聲明](THIRD_PARTY_NOTICES.txt)

上述授權適用各自的第三方元件，不代表將本工具自有程式碼一併改為相同授權。OCR、PDF.js、字型等網站元件的授權請參考專案根目錄 README 與 `docs/licenses/`。

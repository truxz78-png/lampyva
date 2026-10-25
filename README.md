# Lampyva

Free, private image studio: AI upscaling, background removal and format conversion — all running in your browser. Your images never leave your device.

Live site: https://truxz78-png.github.io/lampyva/

## How it works
- **AI upscaling** — waifu2x models (MIT) on the device's GPU with WebGL2. Plan B: high-quality resize.
- **Background removal** — U²-Net "u2netp" (Apache-2.0) on the GPU. Plan B: the same model on the CPU.
- **Print-on-demand ready** — store presets (Amazon Merch, Redbubble, Spreadshirt, TeePublic, Zazzle, Displate), white or AI background removal, trim, AI enlarge, 300 DPI PNG.
- **Format converter** — PNG, JPG, WebP, AVIF, GIF, BMP, TIFF, ICO, PDF, HEIC. Plan B: save as PNG.
- Everything (code, libraries, models) is stored in this repository — no external servers.

## Settings
Edit `config.js`: PayPal link, crypto addresses, contact email and the statistics robot URL (`tools/statistics/Code.gs`, Google Apps Script → your own Google Sheet + daily email).

## Robot (automatic checks)
`.github/workflows/monitor.yml` checks the live site every day and every upload with `tests/monitor.mjs`.
If something is broken it opens an issue labeled **robot** (GitHub emails the owner) and closes it when fixed.

© DriftforgeDev

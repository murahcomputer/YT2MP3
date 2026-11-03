# YT2MP3 — Konverter YouTube ke MP3

Website konverter YouTube → MP3 langsung dari link, dengan pilihan kualitas
**128 / 192 / 256 / 320 kbps**, progres unduh real-time, dan **PO Token**
agar tidak diblokir YouTube ketika di-deploy ke server (mis. AWS EC2).

## Fitur

- Tempel link YouTube (`watch`, `youtu.be`, `/shorts/`, `/embed/`, `/live/`) → analisis judul, durasi, thumbnail
- Pilih kualitas MP3: 128, 192, 256, 320 kbps (re-encode dengan ffmpeg)
- Progres live via Server-Sent Events (unduh → konversi → selesai)
- File otomatis terunduh saat selesai + bisa unduh ulang selama 30 menit
- **PO Token** (`visitorData` + `poToken`) untuk melewati deteksi bot YouTube
- Rate limit per IP, batas job bersamaan, pembersihan file otomatis
- Tanpa database, tanpa build step frontend — langsung jalan

## Cara kerja (termasuk PO Token)

```
Browser ── POST /api/info ──► Express ──► yt-dlp --dump-json ──► YouTube
Browser ── POST /api/jobs ──► Express ──► yt-dlp -x --audio-format mp3
                                   │
                                   ├─ server/poToken.js (cache token)
                                   │      └─ spawn node server/generatePoToken.js
                                   │             └─ youtube-po-token-generator (BotGuard)
                                   └─ hasil MP3 di tmp/ ──► Browser (SSE progress)
```

`youtube-po-token-generator` menghasilkan pasangan `{ visitorData, poToken }`
yang saling terikat. Pasangan itu dikirim ke yt-dlp sebagai:

```
--extractor-args "youtube:po_token=web.gvs+<TOKEN>;visitor_data=<VISITOR_DATA>;player_skip=webpage,configs"
```

### Penting: kenapa generator dijalankan sebagai subprocess?

Package asli menyimpan token dalam loop `while (poToken.length === 164)`.
Sejak YouTube mengubah format token (kini ±692 karakter) dan skrip BotGuard
kadang mengembalikan string error, loop tersebut **tidak pernah berakhir** dan
menghabiskan memori sampai proses mati (OOM).

Karena itu project ini memakai `server/generatePoToken.js` — implementasi
orkestrasi yang sama (memakai file vendor + `inject.js` dari package asli,
lisensi MIT) tetapi dengan:

1. batas percobaan & timeout (±55 detik),
2. polyfill API yang hilang di jsdom (`performance.timing`, `screen`, dsb.)
   agar BotGuard tidak error `DFO:Invalid::Error`,
3. validasi token: string error ditolak, token asli diterima berapa pun panjangnya,
4. dijalankan sebagai **subprocess terisolasi** (batas memori 768 MB) sehingga
   kegagalan hanya memengaruhi satu request — server tetap hidup.

Jika pembuatan token gagal, server otomatis **fallback tanpa PO token**
(klien default yt-dlp yang saat ini tidak selalu membutuhkan token), jadi
website tetap melayani pengguna.

## Prasyarat

| Komponen | Versi |
| --- | --- |
| Node.js | ≥ 18 (dites dengan Node 26) |
| yt-dlp | terbaru (dites 2026.10.26) — [unduh di sini](https://github.com/yt-dlp/yt-dlp/releases) |
| ffmpeg | tersedia di PATH (`ffmpeg -version`) |

## Menjalankan secara lokal

```bash
# 1. Instal dependensi
npm install

# 2. (Opsional) salin konfigurasi
copy .env.example .env        # Windows
cp .env.example .env          # Linux/macOS

# 3. Jalankan
npm start                     # atau: npm run dev (auto-reload)
```

Buka <http://localhost:3000>.

Cek kesehatan server (binary, status PO token):

```bash
curl http://localhost:3000/api/health
```

## Konfigurasi (`.env`)

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port server |
| `YTDLP_PATH` | `yt-dlp` | Path binary yt-dlp |
| `FFMPEG_PATH` | `ffmpeg` | Path binary ffmpeg |
| `PO_CLIENT` | `web.gvs` | Konteks PO Token (`web.gvs`, `mweb.gvs`, `ios.gvs`) |
| `PO_TOKEN_TTL_MINUTES` | `20` | Masa berlaku cache token |
| `PLAYER_SKIP` | `webpage,configs` | Argumen yt-dlp saat `visitor_data` eksternal dipakai; kosongkan untuk default |
| `MAX_CONCURRENT_JOBS` | `3` | Job konversi bersamaan |
| `JOB_TTL_MINUTES` | `30` | Umur file hasil & riwayat job |
| `RATE_LIMIT_INFO` / `RATE_LIMIT_JOBS` | `20` / `8` | Batas request per IP per menit |
| `HTTPS_PROXY` | — | Proxy untuk YouTube (lihat bagian troubleshooting) |

## Deploy ke AWS EC2

Contoh menggunakan **Ubuntu 24.04 LTS**, `t3.small` (1 GB RAM kurang untuk
ffmpeg + jsdom, minimal disarankan 2 GB).

### 1. Security Group

Buka hanya port yang perlu:

| Port | Sumber | Keterangan |
| --- | --- | --- |
| 22 | IP Anda | SSH |
| 80 | 0.0.0.0/0 | HTTP |
| 443 | 0.0.0.0/0 | HTTPS (opsional) |

### 2. Instal prasyarat di server

```bash
sudo apt update && sudo apt install -y ffmpeg python3 curl unzip git

# Node.js 22 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# yt-dlp versi terbaru (versi apt sering terlalu lama)
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod 755 /usr/local/bin/yt-dlp

# Verifikasi
node --version && yt-dlp --version && ffmpeg -version
```

### 3. Upload project

Dari mesin lokal (di folder project):

```bash
scp -r . ubuntu@IP_EC2:/home/ubuntu/yt2mp3
```

Atau `git clone` bila sudah di-repository. Lalu di server:

```bash
cd /var/www && sudo mkdir -p yt2mp3 && sudo chown -R ubuntu:ubuntu /var/www/yt2mp3
# pindahkan hasil upload ke /var/www/yt2mp3, lalu:
cd /var/www/yt2mp3
npm install --omit=dev
mkdir -p .home .cache tmp
```

### 4. Jalankan sebagai service (systemd)

```bash
sudo cp deploy/yt2mp3.service /etc/systemd/system/yt2mp3.service
sudo systemctl daemon-reload
sudo systemctl enable --now yt2mp3
systemctl status yt2mp3          # harus "active (running)"
curl http://127.0.0.1:3000/api/health
```

Lihat log:

```bash
journalctl -u yt2mp3 -f
```

> Jika Node terinstal lewat nvm, sesuaikan `ExecStart` di service file
> (mis. `/home/ubuntu/.nvm/versions/node/v22.x.y/bin/node`).

### 5. Pasang nginx (reverse proxy)

```bash
sudo apt install -y nginx
sudo cp deploy/nginx.conf /etc/nginx/sites-available/yt2mp3
sudo ln -s /etc/nginx/sites-available/yt2mp3 /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> **Catatan penting:** `proxy_buffering off` pada konfigurasi nginx wajib ada,
> supaya progress SSE tampil real-time di browser.

### 6. HTTPS (opsional, direkomendasikan)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d domainanda.com
```

### 7. Uji

Buka `http://IP_EC2` dari browser, tempel link YouTube, pilih kualitas, konversi.

## Troubleshooting

### YouTube memblokir permintaan ("Sign in to confirm you're not a bot")

Penyebab utama: **IP datacenter** (EC2) dianggap tidak wajar. Solusi berurutan:

1. **Pastikan PO token aktif** — cek `curl http://IP/api/health` → `poToken.ready: true`.
   Bila `lastError` terisi, lihat log `journalctl -u yt2mp3`.
2. **Tunggu & coba lagi** — YouTube membatasi ±300 video/jam per sesi tamu;
   server ini sudah punya rate limit dan retry otomatis (token baru → fallback tanpa token).
3. **Gunakan proxy** — set `HTTPS_PROXY=http://127.0.0.1:8888` (mis. via
   Squid/V2Ray di server yang sama atau provider proxy). Proxy dipakai baik oleh
   generator token maupun yt-dlp.
4. **Alternatif provider token** — komunitas yt-dlp menyarankan plugin
   [`bgutil-ytdlp-pot-provider`](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
   (dipelihara oleh maintainer yt-dlp) yang menghasilkan token **terikat video ID**
   secara otomatis. Plugin ini bisa dipasang bersamaan tanpa mengubah kode:
   ```bash
   yt-dlp --plugin-dirs /path/to/bgutil-ytdlp-pot-provider/ytdlp_plugin \
          --extractor-args "youtube:player_client=mweb"
   ```
   Bila memakai plugin, nonaktifkan token manual kami dengan mengosongkan
   `PO_CLIENT` (set `PO_CLIENT=`) agar tidak bentrok — atau biarkan, karena
   retry otomatis akan memilih jalur yang berhasil.

### `ffmpeg: not found` / konversi selalu gagal

Pastikan `ffmpeg -version` jalan di mesin yang sama dengan service, atau set
`FFMPEG_PATH=/path/lengkap/ffmpeg` di `.env` / service file.

### Progress tidak muncul di browser (padahal di log jalan)

nginx menahan buffering SSE — pastikan `proxy_buffering off;` ada (sudah disediakan
di `deploy/nginx.conf`).

### File hasil tidak bisa diunduh lagi

File MP3 dihapus otomatis setelah `JOB_TTL_MINUTES` (default 30 menit).
Konversi ulang bila dibutuhkan.

### Debug PO Token

```bash
node server/generatePoToken.js      # cetak {"visitorData":...,"poToken":...}
node scripts/debug-po.js            # diagnostik loop generator (versi library asli)
node scripts/dump-po.js             # lihat isi mentah token yang dihasilkan
```

## API

| Method | Endpoint | Body | Keterangan |
| --- | --- | --- | --- |
| `POST` | `/api/info` | `{ "url": "..." }` | Metadata video (judul, durasi, thumbnail) |
| `POST` | `/api/jobs` | `{ "url", "quality": 192, "title"? }` | Mulai konversi → `{ id }` |
| `GET` | `/api/jobs/:id` | — | Status job (fallback polling) |
| `GET` | `/api/jobs/:id/events` | — | Live update (SSE) |
| `GET` | `/api/jobs/:id/file` | — | Unduh MP3 |
| `GET` | `/api/health` | — | Status binary, PO token, job aktif |

Kualitas yang diterima: `128`, `192`, `256`, `320`.

## Struktur project

```
├── server/
│   ├── index.js            # Express: route API + static + rate limit
│   ├── config.js           # konfigurasi (env .env)
│   ├── jobs.js             # penyimpanan & orkestrasi job + broadcast SSE
│   ├── youtube.js          # validasi URL, info, download+konversi MP3, retry token
│   ├── poToken.js          # cache token (subprocess spawn)
│   └── generatePoToken.js  # pembangkit token (subprocess terisolasi)
├── public/                 # frontend statis (HTML/CSS/JS, tanpa build)
├── deploy/
│   ├── yt2mp3.service      # unit systemd untuk EC2
│   └── nginx.conf          # reverse proxy + SSE
├── scripts/                # diagnostik PO token
└── tmp/                    # file MP3 sementara (dibersihkan otomatis)
```

## Catatan

Gunakan hanya untuk konten yang Anda punya haknya (video sendiri, Creative
Commons, atau yang izin unduhnya jelas). Penyalahgunaan hak cipta bukan
tanggung jawab pengembang. Mengunduh YouTube juga dapat melanggar
[YouTube Terms of Service](https://www.youtube.com/t/terms) — pastikan Anda
memahami risikonya.

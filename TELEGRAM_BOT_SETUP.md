# Template Setup Bot Telegram PSC

## 1. Yang Wajib Diisi

Isi bagian ini di file `.env`.

```env
BOT_TOKEN=
WHITELIST_ID=
PSC_EMAIL=
PSC_PASS=
DEFAULT_PRICE_PER_ACCOUNT=2000
MIN_KAIT_ACCOUNTS=1
UNIQUE_PAYMENT_CODE=true
UNIQUE_PAYMENT_CODE_MIN=156
UNIQUE_PAYMENT_CODE_MAX=200
SUPPORT_USERNAME=@username_support
```

Keterangan:

```text
BOT_TOKEN
Token bot dari @BotFather. Nama ini sama seperti bot auto order lama.

WHITELIST_ID
ID Telegram admin. Nama ini sama seperti bot auto order lama. Kalau lebih dari satu admin, bot baru juga mendukung format koma.
Contoh: 7455452803,123456789

PSC_EMAIL
Email akun PaysafeCard yang dipakai worker untuk mengisi form Add PaysafeCard di Play Store.

PSC_PASS
Password akun PaysafeCard yang dipakai worker untuk mengisi form Add PaysafeCard di Play Store.

DEFAULT_PRICE_PER_ACCOUNT
Harga per 1 akun valid.

MIN_KAIT_ACCOUNTS
Minimal akun valid untuk order Kait PSC.

UNIQUE_PAYMENT_CODE
Tambahkan kode unik ke total pembayaran supaya order dengan nominal sama tidak bentrok. Isi `true` untuk production.

UNIQUE_PAYMENT_CODE_MIN / UNIQUE_PAYMENT_CODE_MAX
Range kode unik khusus bot ini. Kalau QRIS dipakai bareng bot lain, pisahkan range. Bot auto order lama kamu memakai `0-155`, jadi bot ini disarankan memakai `156-200`.

SUPPORT_USERNAME
Username support yang tampil di menu utama.
```

## 2. Port Emulator

Isi sesuai port emulator yang kamu pakai.

```env
port1=16512
port2=16448
port3=16416
```

Kalau emulator cuma 1, isi `port1` saja. Kalau 4 emulator, lanjutkan:

```env
port4=16480
```

## 3. Python Worker

```env
PYTHON_BIN=python
WORKER_POLL_MS=5000
ESTIMATE_SECONDS_PER_ACCOUNT=120
PSC_MAX_RETRY_PASSES=3
PSC_VERIFY_MAX_ROUNDS=3
CHECKER_THREADS=1
U2_WAIT_TIMEOUT=10
U2_ACTION_TIMEOUT_MULTIPLIER=1
U2_SLEEP_MULTIPLIER=1
PSC_CONNECT_RETRY=5
```

Kalau `python` tidak jalan di Windows, ganti:

```env
PYTHON_BIN=py
```

Atau pakai path lengkap:

```env
PYTHON_BIN=C:\Users\NamaUser\AppData\Local\Programs\Python\Python311\python.exe
```

## 4. Order Kuota / QRIS

Kalau detail API Order Kuota belum diisi, bot tetap bisa jalan mode manual. Admin tinggal pakai:

```text
/paid ORDER_ID
```

Template konfigurasi gateway:

```env
ORDERKUOTA_CREATE_URL=
ORDERKUOTA_STATUS_URL=
ORDERKUOTA_API_TOKEN=
ORDERKUOTA_REF_PATH=data.reference
ORDERKUOTA_QRIS_PATH=data.qris
ORDERKUOTA_QRIS_IMAGE_PATH=data.qr_image
ORDERKUOTA_STATUS_PATH=data.status
```

```env
QRCODE_TEXT=
APIKEY_ORKUT=
CODE_TEXT=
MERCHANT_KEY=
ORKUT_KEY=
USERNAME_ORKUT=
AUTH_TOKEN=
PAYMENT_CHECK_INTERVAL_MS=15000
ORKUT_MUTASI_CACHE_MS=5000
ORKUT_MUTASI_URL=https://order-kuota.web.id/api.php
```

`QRCODE_TEXT` atau `CODE_TEXT` akan dipakai bot untuk generate QRIS dinamis sesuai total bayar order. Untuk cek pembayaran otomatis dengan Orkut, isi `APIKEY_ORKUT`, `USERNAME_ORKUT`, dan `AUTH_TOKEN`.

Keterangan:

```text
ORDERKUOTA_CREATE_URL
Endpoint untuk membuat invoice/QRIS.

ORDERKUOTA_STATUS_URL
Endpoint untuk cek status pembayaran.

ORDERKUOTA_API_TOKEN
Token/API key Order Kuota.

ORDERKUOTA_REF_PATH
Path response JSON untuk reference invoice.

ORDERKUOTA_QRIS_PATH
Path response JSON untuk teks QRIS.

ORDERKUOTA_QRIS_IMAGE_PATH
Path response JSON untuk gambar QRIS, jika ada.

ORDERKUOTA_STATUS_PATH
Path response JSON untuk status pembayaran.
```

## 5. Template `.env` Lengkap

```env
# Telegram
BOT_TOKEN=ISI_TOKEN_BOT_DARI_BOTFATHER
WHITELIST_ID=ISI_ID_TELEGRAM_ADMIN
SUPPORT_USERNAME=@username_support

# Harga
DEFAULT_PRICE_PER_ACCOUNT=2000
MIN_KAIT_ACCOUNTS=1



# Worker PSC
PSC_EMAIL=isi_email_psc
PSC_PASS=isi_password_psc
PYTHON_BIN=python
WORKER_POLL_MS=5000

# Emulator ports
port1=16512
port2=16448
port3=16416

# QRIS / Orkut - gaya nama lama bot auto order
QRCODE_TEXT=isi_qris_text_static
APIKEY_ORKUT=isi_apikey_orkut
MERCHANT_KEY=isi_merchant_key
```

## 6. Cara Jalan

Terminal 1:

```powershell
npm.cmd run bot
```

Terminal 2:

```powershell
npm.cmd run worker:psc
```

Terminal 3 (antrean GoPay terpisah):

```powershell
npm.cmd run worker:gopay
```

Worker GoPay memakai `GOPAY_BROWSERS=2` dan `GOPAY_MAX_BATCHES=3`. Pastikan dependency
`autokaitgopay/requirements.txt`, browser Playwright Chromium, serta server OTP sudah aktif.

## 7. Admin Command

```text
/admin
/setharga 2000
/orders
/paid ORDER_ID
/broadcast pesan
/pause
/resume
```

## 8. Flow Test Manual

1. Jalankan bot.
2. Buka Telegram, kirim `/start`.
3. Klik `Kait PSC`.
4. Kirim minimal 10 akun format `email|password`.
5. Bot buat order QRIS manual.
6. Admin kirim `/paid ORDER_ID`.
7. Jalankan worker.
8. Worker proses order dari `data/orders/ORDER_ID/input.txt`.
9. Hasil sukses masuk ke `data/orders/ORDER_ID/success.txt`.

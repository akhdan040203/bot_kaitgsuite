# Auto Kait GoPay

Paket ini hanya berisi:

- Login akun GSuite dari `Gsuite.txt`.
- Menautkan GoPay, mengambil OTP dari webhook, memasukkan PIN, dan menyimpan hasil.
- Checker status GoPay linked.
- Server webhook penerima OTP di folder `WA OTP API`.

PSC dan DOKU tidak disertakan.

## Menjalankan

1. Install Python dependency:
   `pip install -r requirements.txt`
2. Install browser Playwright:
   `playwright install chromium`
3. Isi `.env` dengan `GOPAY_PHONE`, `GOPAY_PIN`, dan `OTP_WEBHOOK_URL`.
4. Pastikan aplikasi forward notifikasi mengirim JSON ke `POST /webhook`.
5. Jalankan `RUN_OTP_API.bat` jika memakai server OTP dari folder ini.
6. Jalankan `RUN_SEKARANG.bat`, lalu pilih auto-link atau checker.

## Mode worker bot (non-interaktif)

Worker utama menjalankan script dengan file khusus milik setiap order, jadi order tidak
bercampur dan tidak meminta input dari terminal:

```text
python APP/app.py --input-file <input> --success-file <linked> --failure-file <failed> --browsers 2
python APP/checker.py --input-file <linked> --checked-file <success> --empty-file <empty> --browsers 2
```

Jalankan antrean GoPay dari root proyek menggunakan `npm run worker:gopay`.

Format akun pada `Gsuite.txt`:

```text
email@domain.com|password
```

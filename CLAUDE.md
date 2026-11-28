# CLAUDE.md — SOP Tetap Proyek Sistem Presensi RFID Polnes

## Identitas (jangan diubah tanpa persetujuan pemilik)
- Repo GitHub: `klouaeirinrouaeiver-ship-it/presensi-rfid` (branch `main`)
- Vercel: project `presensi-rfid-polnes-kelompok3` (paket Hobby), domain `presensi-rfid-polnes-kelompok3.vercel.app`
- Supabase: project `muwlrysxpuygrinrnere`

## Aturan Tetap
1. **1 file `api/*` = 1 tanggung jawab.**
   - `api/tap.js` → HANYA endpoint hardware RFID ESP8266 (POST, header `x-device-key`, RPC `proses_tap`).
   - `api/telegram-webhook.js` → HANYA webhook/bot Telegram.
   - `api/kirim-wa.js` → HANYA worker pengirim antrean notifikasi.
2. **JANGAN PERNAH menimpa `api/tap.js`.** Insiden 2026-11-28: commit `15ea983` menimpa `tap.js` dengan kode webhook Telegram sehingga hardware mati; dipulihkan dari `be03224`. Sebelum commit apa pun ke `api/tap.js`, bandingkan dengan `be03224`.
3. `vercel.json` hanya di ROOT repo, berisi `functions` saja. Penjadwalan memakai `pg_cron` + `pg_net` di Supabase (bukan Vercel Cron, karena paket Hobby).
4. Semua endpoint rahasia memakai `Authorization: Bearer <secret>` — jangan pernah menerima rahasia lewat query URL.
5. Webhook Telegram bersifat fail-closed: tanpa `TELEGRAM_WEBHOOK_SECRET` di server, tolak semua POST.
6. Fungsi RPC `SECURITY DEFINER` wajib `SET search_path TO ''` dan punya pemeriksaan otorisasi sendiri; fungsi internal/trigger di-`REVOKE` dari `PUBLIC, anon, authenticated`.
7. `anggota.punya_kartu` adalah kolom `GENERATED ALWAYS` — jangan pernah di-assign pada `UPDATE`/`INSERT`.
8. Rahasia (token bot, service key, `CRON_SECRET`) hanya di env Vercel / Supabase Vault — jangan di-commit.

## Protokol Estafet
Setiap sesi: baca `STATE.md` dulu, kerjakan, perbarui `STATE.md`, lalu tutup dengan format
`1. SUDAH SELESAI / 2. BELUM SELESAI / 3. PROMPT LANJUTAN`.

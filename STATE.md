# STATE.md — Status Estafet (diperbarui 2026-11-28)

## Selesai
- **Audit RLS** (migrasi `audit_rls_tutup_eskalasi_peran_dan_rpc_anon`, `pulihkan_trigger_batasi_kolom_punya_kartu`, `notifikasi_log_izinkan_status_proses_dan_waktu_klaim`) — SELESAI.
- **Supabase Blok A** — `public.kode_prodi()` + `siapkan_antrean_wa()` memakai kode prodi dinamis (TI/TK/TIM/TRK). Terapkan & terverifikasi.
- **Supabase Blok B** — `simpan_profil_mandiri()` divalidasi (nama 3–80, 4 prodi resmi, NIM 6–20 digit), celah merge Mode Auto ditutup, `punya_kartu` dihapus dari UPDATE (terbukti error `428C9`), urutan hapus-lalu-update agar tidak melanggar UNIQUE `nim/uid_kartu/telegram_chat_id`. Diuji dengan data sintetis (di-rollback).
- **Supabase Blok D** — `REVOKE ALL ON FUNCTION public.catat_audit()` dari `PUBLIC, anon, authenticated`.
- **Audit 6 RPC** — lihat bagian "Temuan Audit".

## Belum selesai (menunggu akses tulis GitHub)
- [ ] **P0** `api/tap.js` di `main` masih berisi kode webhook Telegram → hardware RFID mati. File pemulih identik `be03224` (blob `6f367fb5…`) sudah siap.
- [ ] `vercel.json` ke root + hapus `api/vercel.json`.
- [ ] `api/telegram-webhook.js` versi fail-closed.
- [ ] `api/kirim-wa.js` versi baru (tanpa `?secret=`, JWT via `auth_user_id`, isi `diklaim_pada`).
- [ ] `CLAUDE.md` + `STATE.md` di root.
- [ ] **Blok C** (`pg_net` + `public.picu_kirim_wa()` + jadwal `antrean-wa`) — jalankan SETELAH `kirim-wa.js` baru ter-deploy.

## Temuan Audit (lihat laporan sesi)
- `terapkan_paket_prodi`: pengguna non-admin boleh memasukkan parameter `p_prodi` apa pun untuk dirinya sendiri → bisa mendaftar ke semua mata kuliah prodi lain. Perbaikan: abaikan `p_prodi` untuk non-admin.
- `simpan_profil_mandiri`: pengguna terdaftar (mis. mahasiswa yang didaftarkan admin) masih bisa mengganti `peran` menjadi `dosen` sendiri.
- Fallback NIM/Email Telegram: siapa pun yang tahu NIM/email bisa menautkan akun yang belum tertaut. Set `TELEGRAM_FALLBACK=0` di Vercel jika tidak diperlukan.

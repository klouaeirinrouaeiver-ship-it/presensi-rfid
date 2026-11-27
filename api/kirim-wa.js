// api/kirim-wa.js — Worker Pengirim Notifikasi Telegram Presensi RFID Polnes
import { createClient } from '@supabase/supabase-js';
import { createHash, timingSafeEqual } from 'node:crypto';

const BATCH_SIZE = 20;
const DELAY_MS = 150;
const FETCH_TIMEOUT_MS = 10_000;
const TIME_BUDGET_MS = 50_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY belum diset');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function authorize(req, supabase) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'] || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  const bearer = m ? m[1].trim() : '';

  if (cronSecret && bearer && safeEqual(bearer, cronSecret)) {
    return { ok: true, via: 'cron-header', isAdmin: true };
  }

  const q = req.query?.secret;
  const qSecret = Array.isArray(q) ? q[0] : q;
  if (cronSecret && qSecret && safeEqual(String(qSecret), cronSecret)) {
    return { ok: true, via: 'cron-query', isAdmin: true };
  }

  if (bearer) {
    try {
      const { data, error } = await supabase.auth.getUser(bearer);
      if (error || !data?.user?.email) return { ok: false };
      const email = data.user.email.trim().toLowerCase();
      const { data: rows, error: e2 } = await supabase
        .from('anggota')
        .select('id, nama, peran, telegram_chat_id')
        .eq('email', email)
        .eq('aktif', true)
        .limit(1);
      if (e2 || !rows?.length) return { ok: false };
      const user = rows[0];
      return {
        ok: true,
        via: 'user-jwt',
        isAdmin: String(user.peran).toLowerCase() === 'admin',
        user,
      };
    } catch {
      return { ok: false };
    }
  }
  return { ok: false };
}

async function kirimTelegram(chatId, pesan) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, info: 'TELEGRAM_BOT_TOKEN belum diset' };

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: String(chatId),
        text: pesan,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    const ok = res.ok && json?.ok === true;
    return { ok, info: `HTTP ${res.status}: ${text}`.slice(0, 500) };
  } catch (err) {
    const msg = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      ? `Timeout ${FETCH_TIMEOUT_MS / 1000} detik`
      : `Error jaringan: ${err?.message || err}`;
    return { ok: false, info: msg.slice(0, 500) };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method tidak diizinkan' });
  }

  let supabase;
  try {
    supabase = getSupabase();
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  const auth = await authorize(req, supabase);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  // Mode tes mandiri oleh user yang sedang login (Mahasiswa/Dosen/Admin)
  if (req.query?.action === 'test' && auth.user) {
    if (!auth.user.telegram_chat_id) {
      return res.status(400).json({ ok: false, error: 'Akun Telegram Anda belum ditautkan.' });
    }
    const r = await kirimTelegram(
      auth.user.telegram_chat_id,
      `🔔 <b>Tes Notifikasi Berhasil!</b>\n\nHalo <b>${auth.user.nama}</b>, koneksi Telegram untuk <b>Presensi RFID TRK Polnes</b> sudah aktif dan siap menerima pengingat jadwal kuliah.`
    );
    if (!r.ok) return res.status(502).json({ ok: false, error: r.info });
    return res.status(200).json({ ok: true, message: 'Pesan tes terkirim ke Telegram Anda!' });
  }

  if (!auth.isAdmin) {
    return res.status(403).json({ ok: false, error: 'Hanya admin atau cron yang boleh memicu antrean.' });
  }

  const mulai = Date.now();
  const hasil = { ok: true, antrean_baru: 0, diproses: 0, terkirim: 0, gagal: 0 };

  try {
    const { data: cfg } = await supabase.from('pengaturan').select('notif_aktif').limit(1).maybeSingle();
    if (cfg && cfg.notif_aktif === false) {
      return res.status(200).json({ ...hasil, catatan: 'Notifikasi dinonaktifkan di pengaturan' });
    }

    const { data: n, error: rpcErr } = await supabase.rpc('siapkan_antrean_wa');
    if (rpcErr) {
      hasil.peringatan = `RPC siapkan_antrean_wa gagal: ${rpcErr.message}`;
    } else {
      hasil.antrean_baru = Number(n) || 0;
    }

    const { data: kandidat, error: selErr } = await supabase
      .from('notifikasi_log')
      .select('id')
      .eq('status_kirim', 'antri')
      .order('tanggal', { ascending: true })
      .limit(BATCH_SIZE);
    if (selErr) throw new Error(`Gagal membaca antrean: ${selErr.message}`);

    if (!kandidat?.length) return res.status(200).json(hasil);

    const { data: klaim, error: claimErr } = await supabase
      .from('notifikasi_log')
      .update({ status_kirim: 'proses' })
      .in('id', kandidat.map((k) => k.id))
      .eq('status_kirim', 'antri')
      .select('id, nomor_tujuan, pesan, tanggal')
      .order('tanggal', { ascending: true });
    if (claimErr) throw new Error(`Gagal klaim antrean: ${claimErr.message}`);

    const baris = klaim || [];
    hasil.diproses = baris.length;

    for (let i = 0; i < baris.length; i++) {
      const row = baris[i];

      if (Date.now() - mulai > TIME_BUDGET_MS) {
        const sisa = baris.slice(i).map((r) => r.id);
        await supabase.from('notifikasi_log').update({ status_kirim: 'antri' }).in('id', sisa);
        hasil.diproses -= sisa.length;
        hasil.catatan = `Batas waktu tercapai, ${sisa.length} pesan dikembalikan ke antrean`;
        break;
      }

      const r = await kirimTelegram(row.nomor_tujuan, row.pesan);
      const patch = r.ok
        ? { status_kirim: 'terkirim', dikirim_pada: new Date().toISOString(), respon_gateway: r.info }
        : { status_kirim: 'gagal', respon_gateway: r.info };

      const { error: updErr } = await supabase.from('notifikasi_log').update(patch).eq('id', row.id);
      if (updErr) console.error(`Gagal update log ${row.id}:`, updErr.message);

      if (r.ok) hasil.terkirim++; else hasil.gagal++;

      if (i < baris.length - 1) await sleep(DELAY_MS);
    }

    return res.status(200).json(hasil);
  } catch (err) {
    console.error('kirim-wa error:', err);
    return res.status(500).json({ ...hasil, ok: false, error: err?.message || String(err) });
  }
}
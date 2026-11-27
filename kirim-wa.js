// api/kirim-wa.js — Vercel Serverless Function (ES Modules)
import { createClient } from '@supabase/supabase-js';
import { createHash, timingSafeEqual } from 'node:crypto';

const BATCH_SIZE = 15;
const DELAY_MIN_MS = 800;
const DELAY_MAX_MS = 1200;
const FETCH_TIMEOUT_MS = 10_000;
const TIME_BUDGET_MS = 50_000;

const ADMIN = {
  table: 'anggota',
  emailCol: 'email',
  roleCol: 'peran',
  roleValue: 'admin',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1));

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

  // 1) Bearer = CRON_SECRET
  if (cronSecret && bearer && safeEqual(bearer, cronSecret)) return { ok: true, via: 'cron-header' };

  // 2) ?secret=CRON_SECRET (cron-job.org)
  const q = req.query?.secret;
  const qSecret = Array.isArray(q) ? q[0] : q;
  if (cronSecret && qSecret && safeEqual(String(qSecret), cronSecret)) return { ok: true, via: 'cron-query' };

  // 3) Bearer = JWT user Supabase yang berperan admin & aktif
  if (bearer) {
    try {
      const { data, error } = await supabase.auth.getUser(bearer);
      if (error || !data?.user?.email) return { ok: false };
      const email = data.user.email.trim().toLowerCase();
      const { data: rows, error: e2 } = await supabase
        .from(ADMIN.table)
        .select(ADMIN.roleCol)
        .eq(ADMIN.emailCol, email)
        .eq('aktif', true)
        .limit(1);
      if (e2 || !rows?.length) return { ok: false };
      if (String(rows[0][ADMIN.roleCol]).toLowerCase() === ADMIN.roleValue) {
        return { ok: true, via: 'admin-jwt' };
      }
    } catch (_) {
      return { ok: false };
    }
  }
  return { ok: false };
}

async function kirimKeGateway(nomor, pesan) {
  const url = process.env.WA_GATEWAY_URL || 'https://api.fonnte.com/send';
  const token = process.env.WA_API_TOKEN;
  if (!token) return { ok: false, info: 'WA_API_TOKEN belum diset' };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ target: nomor, message: pesan }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* respons bukan JSON */ }

    const ok = res.ok && !(json && json.status === false);
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

  const mulai = Date.now();
  const hasil = { ok: true, antrean_baru: 0, diproses: 0, terkirim: 0, gagal: 0 };

  try {
    const { data: cfg } = await supabase.from('pengaturan').select('notif_aktif').limit(1).maybeSingle();
    if (cfg && cfg.notif_aktif === false) {
      return res.status(200).json({ ...hasil, catatan: 'Notifikasi dinonaktifkan di pengaturan' });
    }

    // Langkah 1: isi antrean jadwal kuliah saat ini
    const { data: n, error: rpcErr } = await supabase.rpc('siapkan_antrean_wa');
    if (rpcErr) {
      hasil.peringatan = `RPC siapkan_antrean_wa gagal: ${rpcErr.message}`;
    } else {
      hasil.antrean_baru = Number(n) || 0;
    }

    // Langkah 2: ambil kandidat lalu claim secara atomik
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

    // Langkah 3 & 4: kirim satu per satu
    for (let i = 0; i < baris.length; i++) {
      const row = baris[i];

      if (Date.now() - mulai > TIME_BUDGET_MS) {
        const sisa = baris.slice(i).map((r) => r.id);
        await supabase.from('notifikasi_log').update({ status_kirim: 'antri' }).in('id', sisa);
        hasil.diproses -= sisa.length;
        hasil.catatan = `Batas waktu tercapai, ${sisa.length} pesan dikembalikan ke antrean`;
        break;
      }

      const r = await kirimKeGateway(row.nomor_tujuan, row.pesan);
      const patch = r.ok
        ? { status_kirim: 'terkirim', dikirim_pada: new Date().toISOString(), respon_gateway: r.info }
        : { status_kirim: 'gagal', respon_gateway: r.info };

      const { error: updErr } = await supabase.from('notifikasi_log').update(patch).eq('id', row.id);
      if (updErr) console.error(`Gagal update log ${row.id}:`, updErr.message);

      if (r.ok) hasil.terkirim++; else hasil.gagal++;

      if (i < baris.length - 1) await sleep(jitter());
    }

    return res.status(200).json(hasil);
  } catch (err) {
    console.error('kirim-wa error:', err);
    return res.status(500).json({ ...hasil, ok: false, error: err?.message || String(err) });
  }
}
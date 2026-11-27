import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const teks = (res, status, isi) =>
  res.status(status).setHeader('Content-Type', 'text/plain; charset=utf-8').send(isi);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return teks(res, 405, 'ERROR||Metode tidak diizinkan');
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.error('Env SUPABASE_URL atau SUPABASE_SECRET_KEY belum diatur di Vercel');
    return teks(res, 500, 'ERROR||Konfigurasi server');
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // 1. Validasi kunci perangkat lewat hash SHA-256
  const kunci = req.headers['x-device-key'];
  if (!kunci) return teks(res, 401, 'AUTH||Kunci perangkat kosong');
  const hash = createHash('sha256').update(String(kunci)).digest('hex');

  const { data: perangkat, error: errPerangkat } = await supabase
    .from('perangkat')
    .select('id')
    .eq('kunci_hash', hash)
    .eq('aktif', true)
    .maybeSingle();

  if (errPerangkat) {
    console.error('Gagal membaca perangkat:', errPerangkat.message);
    return teks(res, 500, 'ERROR||Server bermasalah');
  }
  if (!perangkat) return teks(res, 401, 'AUTH||Kunci tidak valid');

  // 2. Parsing body aman (baik object maupun raw string)
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  // 3. Tanpa UID = sinyal heartbeat perangkat
  const uid = String(body?.uid ?? '').trim().toUpperCase();
  if (!uid) {
    await supabase
      .from('perangkat')
      .update({ terakhir_terlihat: new Date().toISOString() })
      .eq('id', perangkat.id);
    return teks(res, 200, 'PING||OK');
  }

  if (!/^[0-9A-F]{8,14}$/.test(uid)) {
    return teks(res, 400, 'ERROR||UID tidak valid');
  }

  // 4. Jalankan aturan presensi & Mode Auto di database
  const { data, error } = await supabase.rpc('proses_tap', {
    p_uid: uid,
    p_perangkat: perangkat.id,
  });

  if (error) {
    console.error('Gagal memproses tap:', error.message);
    return teks(res, 500, 'ERROR||Gagal memproses');
  }

  return teks(res, 200, data);
}

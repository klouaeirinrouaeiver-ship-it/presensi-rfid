// Letakkan file ini di folder api/ pada proyek Vercel (api/tap.js).
// Alamatnya menjadi: https://NAMA-PROYEK.vercel.app/api/tap
//
// Variabel lingkungan (Vercel > Settings > Environment Variables):
//   SUPABASE_URL         alamat proyek Supabase
//   SUPABASE_SECRET_KEY  kunci rahasia (secret key atau service_role) milik server
// Kunci rahasia ini tidak boleh masuk ke kode website atau firmware.

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const teks = (res, status, isi) =>
  res.status(status).setHeader('Content-Type', 'text/plain; charset=utf-8').send(isi);

export default async function handler(req, res) {
  if (req.method !== 'POST') return teks(res, 405, 'ERROR||Metode tidak diizinkan');

  // 1. Periksa kunci perangkat (yang disimpan di database hanya hash-nya)
  const kunci = req.headers['x-device-key'];
  if (!kunci) return teks(res, 401, 'AUTH||Kunci perangkat tidak ada');
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
  if (!perangkat) return teks(res, 401, 'AUTH||Kunci perangkat tidak valid');

  // 2. Tanpa UID = sinyal "perangkat masih hidup" (heartbeat)
  const uid = String(req.body?.uid ?? '').trim().toUpperCase();
  if (!uid) {
    await supabase
      .from('perangkat')
      .update({ terakhir_terlihat: new Date().toISOString() })
      .eq('id', perangkat.id);
    return teks(res, 200, 'PING||OK');
  }
  if (!/^[0-9A-F]{8,14}$/.test(uid)) return teks(res, 400, 'ERROR||UID tidak valid');

  // 3. Semua aturan presensi dijalankan di database (fungsi proses_tap)
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

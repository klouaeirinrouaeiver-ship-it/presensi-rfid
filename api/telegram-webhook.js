-- 1. Tambah kolom telegram_chat_id pada tabel anggota
ALTER TABLE public.anggota
  ADD COLUMN IF NOT EXISTS telegram_chat_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_anggota_telegram_chat_id
  ON public.anggota (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

-- 2. Izinkan pengguna non-admin memperbarui telegram_chat_id & no_wa miliknya sendiri
CREATE OR REPLACE FUNCTION public.trg_anggota_batasi_kolom()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND NOT public.is_admin() THEN
    IF (to_jsonb(new) - 'no_wa' - 'telegram_chat_id' - 'punya_kartu')
       IS DISTINCT FROM
       (to_jsonb(old) - 'no_wa' - 'telegram_chat_id' - 'punya_kartu') THEN
      RAISE EXCEPTION 'Pengguna non-admin hanya boleh mengubah pengaturan notifikasi miliknya sendiri.'
        USING errcode = '42501';
    END IF;
  END IF;
  RETURN new;
END;
$function$;

-- 3. Perbarui tautkan_akun agar login Gmail langsung masuk tanpa blokir nomor WA
DROP FUNCTION IF EXISTS public.tautkan_akun(text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.tautkan_akun(
  p_no_wa text DEFAULT '',
  p_peran text DEFAULT 'mahasiswa',
  p_nama  text DEFAULT '',
  p_nim   text DEFAULT '',
  p_kelas text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_uid           uuid := auth.uid();
  v_email         text := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
  v_meta_nama     text := trim(coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() -> 'user_metadata' ->> 'name', ''));
  v_ang           public.anggota%rowtype;
  v_peran         text := lower(trim(coalesce(p_peran, 'mahasiswa')));
  v_nama          text := trim(coalesce(p_nama, ''));
  v_nim           text := regexp_replace(trim(coalesce(p_nim, '')), '[^0-9]', '', 'g');
  v_kelas         text := trim(coalesce(p_kelas, ''));
  v_nim_sementara text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'Anda belum login.');
  END IF;

  IF v_email = '' THEN
    RETURN jsonb_build_object('error', 'Email akun tidak ditemukan.');
  END IF;

  IF v_peran NOT IN ('admin', 'dosen', 'mahasiswa') THEN
    v_peran := 'mahasiswa';
  END IF;

  SELECT * INTO v_ang
  FROM public.anggota
  WHERE auth_user_id = v_uid OR email = v_email
  ORDER BY CASE WHEN auth_user_id = v_uid THEN 0 ELSE 1 END
  LIMIT 1;

  IF NOT FOUND THEN
    IF v_nama = '' THEN
      v_nama := COALESCE(NULLIF(v_meta_nama, ''), split_part(v_email, '@', 1));
    END IF;

    IF v_nim !~ '^[0-9]{6,20}$' THEN
      v_nim_sementara := '99' || lpad((abs(('x' || substr(replace(v_uid::text, '-', ''), 1, 10))::bit(40)::bigint) % 10000000000)::text, 10, '0');
      v_nim := v_nim_sementara;
    END IF;

    INSERT INTO public.anggota (nim, nama, kelas, peran, email, auth_user_id, aktif)
    VALUES (
      v_nim,
      left(v_nama, 80),
      v_kelas,
      v_peran,
      v_email,
      v_uid,
      true
    )
    RETURNING * INTO v_ang;
  ELSE
    IF NOT v_ang.aktif THEN
      RETURN jsonb_build_object('error', 'Akun Anda sedang dinonaktifkan oleh Admin.');
    END IF;

    IF v_ang.auth_user_id IS NOT NULL AND v_ang.auth_user_id <> v_uid THEN
      RETURN jsonb_build_object('error', 'Email ini sudah tertaut ke akun login lain.');
    END IF;

    UPDATE public.anggota
    SET auth_user_id = COALESCE(auth_user_id, v_uid),
        email        = COALESCE(email, v_email),
        peran        = CASE WHEN peran = 'admin' THEN 'admin' ELSE COALESCE(NULLIF(v_peran, ''), peran) END,
        kelas        = CASE WHEN v_kelas <> '' THEN v_kelas ELSE kelas END
    WHERE id = v_ang.id
    RETURNING * INTO v_ang;
  END IF;

  RETURN jsonb_build_object(
    'id', v_ang.id,
    'peran', v_ang.peran,
    'nama', v_ang.nama,
    'punya_kartu', (v_ang.uid_kartu IS NOT NULL),
    'punya_telegram', (coalesce(v_ang.telegram_chat_id, '') <> ''),
    'terkalibrasi_notif', (
      v_ang.aktif
      AND v_ang.uid_kartu IS NOT NULL
      AND coalesce(v_ang.telegram_chat_id, '') <> ''
      AND coalesce(v_ang.email, '') <> ''
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.tautkan_akun(text, text, text, text, text) TO authenticated, service_role;

-- 4. Perbarui siapkan_antrean_wa() agar menargetkan telegram_chat_id terkalibrasi
CREATE OR REPLACE FUNCTION public.siapkan_antrean_wa()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_lokal   timestamp := now() AT TIME ZONE 'Asia/Makassar';
  v_tanggal date      := (now() AT TIME ZONE 'Asia/Makassar')::date;
  v_hari    smallint  := extract(dow FROM (now() AT TIME ZONE 'Asia/Makassar'))::smallint;
  v_notif   boolean;
  v_tol     integer;
  v_total   integer := 0;
  v_n       integer;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Hanya admin atau layanan terjadwal yang boleh menyiapkan antrean notifikasi.'
      USING errcode = '42501';
  END IF;

  SELECT p.notif_aktif, p.toleransi_menit INTO v_notif, v_tol
  FROM public.pengaturan p LIMIT 1;

  IF NOT coalesce(v_notif, false) THEN
    RETURN 0;
  END IF;

  -- Pengingat Mahasiswa (aktif + punya UID kartu + punya Gmail + tertaut Telegram)
  INSERT INTO public.notifikasi_log (anggota_id, mata_kuliah_id, tanggal, peran, nomor_tujuan, pesan)
  SELECT
    a.id, mk.id, v_tanggal, 'mahasiswa', a.telegram_chat_id,
    format(
      '⏰ <b>Pengingat Presensi TRK Polnes</b>' || E'\n\n' ||
      'Halo <b>%s</b>, kuliah <b>%s (%s)</b> telah dimulai pukul <b>%s WITA</b>%s.' || E'\n' ||
      'Segera tap kartu RFID Anda sebelum batas toleransi pukul <b>%s WITA</b> agar tidak tercatat terlambat.',
      replace(replace(replace(a.nama, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
      replace(replace(replace(mk.nama, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
      replace(replace(replace(mk.kode, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
      left(mk.mulai::text, 5),
      CASE WHEN coalesce(mk.ruangan, '') <> '' THEN ' di <b>' || replace(replace(replace(mk.ruangan, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</b>' ELSE '' END,
      left((mk.mulai + make_interval(mins => coalesce(mk.toleransi_menit, v_tol)))::text, 5)
    )
  FROM public.mata_kuliah mk
  JOIN public.peserta p ON p.mata_kuliah_id = mk.id
  JOIN public.anggota a ON a.id = p.anggota_id
  WHERE mk.hari = v_hari
    AND v_lokal BETWEEN (v_tanggal + mk.mulai) AND (v_tanggal + mk.mulai) + interval '5 minutes'
    AND a.aktif
    AND a.uid_kartu IS NOT NULL
    AND coalesce(a.email, '') <> ''
    AND coalesce(a.telegram_chat_id, '') <> ''
    AND NOT EXISTS (
      SELECT 1 FROM public.presensi pr
      WHERE pr.anggota_id = a.id AND pr.mata_kuliah_id = mk.id AND pr.tanggal = v_tanggal
    )
  ON CONFLICT (anggota_id, mata_kuliah_id, tanggal) DO NOTHING;

  GET DIAGNOSTICS v_n = row_count;
  v_total := v_total + v_n;

  -- Ringkasan Kehadiran untuk Dosen Pengampu
  INSERT INTO public.notifikasi_log (anggota_id, mata_kuliah_id, tanggal, peran, nomor_tujuan, pesan)
  SELECT
    d.id, mk.id, v_tanggal, 'dosen', d.telegram_chat_id,
    format(
      '📊 <b>Ringkasan Awal Kuliah TRK Polnes</b>' || E'\n\n' ||
      'Halo <b>%s</b>, kuliah <b>%s (%s)</b> telah dimulai pukul <b>%s WITA</b>.' || E'\n' ||
      'Status saat ini: <b>%s dari %s</b> mahasiswa sudah tap (Hadir: <b>%s</b>, Terlambat: <b>%s</b>).',
      replace(replace(replace(d.nama, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
      replace(replace(replace(mk.nama, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
      replace(replace(replace(mk.kode, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
      left(mk.mulai::text, 5),
      s.hadir + s.telat, s.total, s.hadir, s.telat
    )
  FROM public.mata_kuliah mk
  JOIN public.anggota d ON d.id = mk.dosen_id
  CROSS JOIN LATERAL (
    SELECT count(*) AS total,
           count(*) FILTER (WHERE pr.status = 'Hadir') AS hadir,
           count(*) FILTER (WHERE pr.status = 'Terlambat') AS telat
    FROM public.peserta p
    LEFT JOIN public.presensi pr
      ON pr.anggota_id = p.anggota_id
     AND pr.mata_kuliah_id = mk.id
     AND pr.tanggal = v_tanggal
    WHERE p.mata_kuliah_id = mk.id
  ) s
  WHERE mk.hari = v_hari
    AND v_lokal BETWEEN (v_tanggal + mk.mulai) AND (v_tanggal + mk.mulai) + interval '5 minutes'
    AND d.aktif
    AND coalesce(d.telegram_chat_id, '') <> ''
  ON CONFLICT (anggota_id, mata_kuliah_id, tanggal) DO NOTHING;

  GET DIAGNOSTICS v_n = row_count;
  v_total := v_total + v_n;

  RETURN v_total;
END;
$$;
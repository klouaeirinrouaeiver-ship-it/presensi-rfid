// api/telegram-webhook.js — Auto-Setup, Bot Info, Deep-Link /start & Fallback NIM/Email
import { createClient } from '@supabase/supabase-js';
import { createHash, timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

async function replyTelegram(botToken, chatId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

function formatKartuStatus(uidKartu) {
  return uidKartu
    ? `✅ Kartu RFID terpasang (<code>${uidKartu}</code>)`
    : '⏳ Kartu RFID belum di-scan Admin (Mode Auto)';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const cronSecret = process.env.CRON_SECRET;

  // 1. Endpoint publik ringan untuk mengambil username bot ke frontend
  if (req.method === 'GET' && req.query?.bot === '1') {
    if (!botToken) return res.status(500).json({ ok: false });
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(8000),
    }).then((r) => r.json()).catch(() => null);
    return res.status(200).json({ ok: Boolean(meRes?.ok), username: meRes?.result?.username || '' });
  }

  // 2. Endpoint aktivasi webhook otomatis lewat server Vercel
  if (req.method === 'GET' && req.query?.setup === '1') {
    const q = Array.isArray(req.query?.secret) ? req.query.secret[0] : req.query?.secret;
    if (!cronSecret || !safeEqual(String(q || ''), cronSecret)) {
      return res.status(401).json({ ok: false, error: 'Secret tidak cocok' });
    }
    if (!botToken || !webhookSecret) {
      return res.status(500).json({ ok: false, error: 'Env Telegram belum lengkap di Vercel' });
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host || 'presensi-rfid-polnes-kelompok3.vercel.app';
    const webhookUrl = `https://${host}/api/telegram-webhook`;

    const [meRes, hookRes] = await Promise.all([
      fetch(`https://api.telegram.org/bot${botToken}/getMe`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json()),
      fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl, secret_token: webhookSecret }),
        signal: AbortSignal.timeout(10000),
      }).then((r) => r.json()),
    ]);

    return res.status(200).json({
      ok: Boolean(meRes?.ok && hookRes?.ok),
      bot_username: meRes?.result?.username || '',
      webhook_url: webhookUrl,
      set_webhook_result: hookRes,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
  if (webhookSecret && !safeEqual(String(incomingSecret || ''), webhookSecret)) {
    return res.status(401).json({ ok: false, error: 'Invalid webhook secret' });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!botToken || !url || !key) {
    return res.status(200).json({ ok: false, error: 'Server env belum lengkap' });
  }

  const msg = req.body?.message;
  const chatId = msg?.chat?.id;
  const text = String(msg?.text || '').trim();

  if (!chatId || !text) {
    return res.status(200).json({ ok: true });
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Jalur A: Deep-link 1-Klik (/start <uuid>)
  const startMatch = text.match(/^\/start(?:@\S+)?\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (startMatch) {
    const anggotaId = startMatch[1].toLowerCase();

    await supabase
      .from('anggota')
      .update({ telegram_chat_id: null })
      .eq('telegram_chat_id', String(chatId))
      .neq('id', anggotaId);

    const { data: ang, error } = await supabase
      .from('anggota')
      .update({ telegram_chat_id: String(chatId) })
      .eq('id', anggotaId)
      .eq('aktif', true)
      .select('nama, nim, peran, uid_kartu')
      .maybeSingle();

    if (error || !ang) {
      await replyTelegram(
        botToken,
        chatId,
        '❌ <b>Gagal menautkan akun.</b>\nPastikan Anda sudah login di web Presensi RFID Polnes, atau ketik <b>NIM</b> / <b>Email Gmail</b> Anda langsung di chat ini.'
      );
      return res.status(200).json({ ok: true });
    }

    await replyTelegram(
      botToken,
      chatId,
      `✅ <b>Telegram Berhasil Terhubung!</b>\n\n` +
      `Nama: <b>${ang.nama}</b>\n` +
      `Peran: <b>${String(ang.peran || 'mahasiswa').toUpperCase()}</b>\n` +
      `Status Kartu: ${formatKartuStatus(ang.uid_kartu)}\n\n` +
      `Pengingat jadwal kuliah & ringkasan presensi akan dikirim otomatis ke chat ini.`
    );
    return res.status(200).json({ ok: true });
  }

  // Jalur B: Fallback penautan langsung dengan mengetik NIM atau Email (jika deep-link terpotong login Telegram Web)
  const isNim = /^\d{6,15}$/.test(text);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

  if (isNim || isEmail) {
    let query = supabase
      .from('anggota')
      .select('id, nama, nim, peran, uid_kartu, telegram_chat_id')
      .eq('aktif', true);

    query = isNim ? query.eq('nim', text) : query.eq('email', text.toLowerCase());
    const { data: found } = await query.maybeSingle();

    if (!found) {
      await replyTelegram(
        botToken,
        chatId,
        '⚠️ <b>Data tidak ditemukan.</b>\nPastikan Anda sudah pernah login ke web Presensi RFID Polnes menggunakan akun Google Anda terlebih dahulu.'
      );
      return res.status(200).json({ ok: true });
    }

    if (found.telegram_chat_id && found.telegram_chat_id !== String(chatId)) {
      await replyTelegram(
        botToken,
        chatId,
        '🔒 <b>Akun ini sudah tertaut ke Telegram lain.</b>\nUntuk mengganti perangkat Telegram, login di web Presensi RFID Polnes lalu klik <b>Tautkan Ulang</b>.'
      );
      return res.status(200).json({ ok: true });
    }

    await supabase
      .from('anggota')
      .update({ telegram_chat_id: null })
      .eq('telegram_chat_id', String(chatId))
      .neq('id', found.id);

    await supabase
      .from('anggota')
      .update({ telegram_chat_id: String(chatId) })
      .eq('id', found.id);

    await replyTelegram(
      botToken,
      chatId,
      `✅ <b>Telegram Berhasil Terhubung!</b>\n\n` +
      `Nama: <b>${found.nama}</b>\n` +
      `NIM: <code>${found.nim}</code>\n` +
      `Status Kartu: ${formatKartuStatus(found.uid_kartu)}\n\n` +
      `Anda sudah bisa menutup tab ini dan kembali ke web Presensi RFID Polnes.`
    );
    return res.status(200).json({ ok: true });
  }

  // Jalur C: Pesan /start polos atau pesan teks lainnya
  await replyTelegram(
    botToken,
    chatId,
    '👋 <b>Bot Presensi RFID TRK Polnes</b>\n\n' +
    'Untuk menghubungkan akun Anda secara instan, balas chat ini dengan <b>NIM</b> Anda (contoh: <code>256661042</code>) atau <b>Email Gmail</b> yang terdaftar di web.'
  );
  return res.status(200).json({ ok: true });
}

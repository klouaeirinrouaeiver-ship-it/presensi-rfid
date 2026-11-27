// api/telegram-webhook.js — Auto-Setup Webhook & Penautan /start <anggota_id>
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const cronSecret = process.env.CRON_SECRET;

  // Kembalikan username bot ke frontend secara otomatis
  if (req.method === 'GET' && req.query?.bot === '1') {
    if (!botToken) return res.status(500).json({ ok: false });
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(8000),
    }).then((r) => r.json()).catch(() => null);
    return res.status(200).json({ ok: Boolean(meRes?.ok), username: meRes?.result?.username || '' });
  }

  // Jalur pendaftaran otomatis dari server Vercel (bebas blokir DNS ISP)
  if (req.method === 'GET' && req.query?.setup === '1') {
    const q = Array.isArray(req.query?.secret) ? req.query.secret[0] : req.query?.secret;
    if (!cronSecret || !safeEqual(String(q || ''), cronSecret)) {
      return res.status(401).json({ ok: false, error: 'Secret tidak cocok atau CRON_SECRET belum di-redeploy' });
    }
    if (!botToken || !webhookSecret) {
      return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN atau TELEGRAM_WEBHOOK_SECRET belum diset di Vercel' });
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

    const username = meRes?.result?.username || '';
    return res.status(200).json({
      ok: Boolean(meRes?.ok && hookRes?.ok),
      bot_username: username,
      tempel_ke_index_html: username ? `const TG_BOT='${username}';` : 'Token bot tidak valid',
      webhook_url: webhookUrl,
      set_webhook_result: hookRes,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Gunakan ?setup=1&secret=... untuk aktivasi webhook' });
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

  const match = text.match(/^\/start(?:@\S+)?\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!match) {
    await replyTelegram(
      botToken,
      chatId,
      '👋 <b>Bot Presensi RFID TRK Polnes</b>\n\nUntuk menghubungkan akun Anda, login di web Presensi RFID Polnes lalu klik tombol <b>Hubungkan Telegram (1 Klik)</b> pada menu <b>Telegram</b>.'
    );
    return res.status(200).json({ ok: true });
  }

  const anggotaId = match[1].toLowerCase();
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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
      '❌ <b>Gagal menautkan akun.</b>\nPastikan akun Anda aktif di web Presensi RFID Polnes, lalu ulangi klik tombol dari web.'
    );
    return res.status(200).json({ ok: true });
  }

  const statusKartu = ang.uid_kartu
    ? `✅ Kartu RFID terpasang (<code>${ang.uid_kartu}</code>)`
    : '⏳ Kartu RFID belum di-scan Admin (Mode Auto)';

  await replyTelegram(
    botToken,
    chatId,
    `✅ <b>Telegram Berhasil Terhubung!</b>\n\n` +
    `Nama: <b>${ang.nama}</b>\n` +
    `Peran: <b>${ang.peran.toUpperCase()}</b>\n` +
    `Status Kartu: ${statusKartu}\n\n` +
    `Pengingat jadwal kuliah & ringkasan presensi akan dikirim otomatis ke chat ini.`
  );

  return res.status(200).json({ ok: true });
}

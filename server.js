require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Redis } = require('@upstash/redis');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация Upstash Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Инициализация Telegram Бота
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// ------------------------------------------------------------------
// ВАЛИДАЦИЯ TELEGRAM WEBAPP INITDATA
// ------------------------------------------------------------------
function verifyTelegramWebAppData(initData) {
  if (!initData) return null;
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');

  const paramsToSign = Array.from(urlParams.entries())
    .map(([key, val]) => `${key}=${val}`)
    .sort()
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData')
    .update(process.env.TELEGRAM_BOT_TOKEN)
    .digest();

  const calculatedHash = crypto.createHmac('sha256', secretKey)
    .update(paramsToSign)
    .digest('hex');

  if (calculatedHash === hash) {
    const userStr = urlParams.get('user');
    return userStr ? JSON.parse(userStr) : null;
  }
  return null;
}

// ------------------------------------------------------------------
// ИНТЕГРАЦИЯ С ПАНЕЛЬЮ 3X-UI
// ------------------------------------------------------------------
async function generate3xUiKey(clientTgId, username) {
  const host = process.env.XUI_HOST;
  const loginUrl = `${host}/login`;
  
  // 1. Авторизация в панели
  const authRes = await axios.post(loginUrl, {
    username: process.env.XUI_USERNAME,
    password: process.env.XUI_PASSWORD
  }, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  const cookie = authRes.headers['set-cookie'];
  const clientUuid = uuidv4();
  const clientEmail = `user_${clientTgId}_${Date.now()}`;

  // 2. Добавление клиента в инбаунд STROMVPN
  const inboundId = parseInt(process.env.XUI_INBOUND_ID || '1');
  const addClientUrl = `${host}/panel/api/inbounds/addClient`;
  
  const clientData = {
    id: inboundId,
    settings: JSON.stringify({
      clients: [{
        id: clientUuid,
        email: clientEmail,
        flow: "xtls-rprx-vision",
        limitIp: 2,
        totalGB: 0,
        expiryTime: Date.now() + (30 * 24 * 60 * 60 * 1000), // 30 дней
        enable: true,
        tgId: String(clientTgId)
      }]
    })
  };

  await axios.post(addClientUrl, clientData, {
    headers: { 'Cookie': cookie, 'Content-Type': 'application/json' }
  });

  // В реальных условиях URL генерируется по параметрам инбаунда панели.
  // Ниже приведен стандартный шаблон для VLESS-Reality 3x-ui:
  const vlessKey = `vless://${clientUuid}@213.176.95.147:443?type=tcp&security=reality&pbk=STROMVPN_KEY&fp=chrome&sni=yahoo.com&sid=123456#STROMVPN-${username || clientTgId}`;
  return vlessKey;
}

// ------------------------------------------------------------------
// API ENDPOINTS
// ------------------------------------------------------------------

// Регистрация/проверка реферала и количества ключей юзера
app.post('/api/init', async (req, res) => {
  const { initData, ref } = req.body;
  const user = verifyTelegramWebAppData(initData);
  
  if (!user) {
    return res.status(401).json({ error: 'Неверные данные Telegram API' });
  }

  const userId = user.id;

  // Закрепляем реферал намертво, если еще не был закреплен
  if (ref && ref === 'BLOGER2026') {
    const existingRef = await redis.get(`user:${userId}:ref`);
    if (!existingRef) {
      await redis.set(`user:${userId}:ref`, 'BLOGER2026');
    }
  }

  // Считаем количество активных ключей юзера
  const userKeys = await redis.lrange(`user:${userId}:keys`, 0, -1) || [];
  
  res.json({
    user,
    keysCount: userKeys.length,
    canBuy: userKeys.length < 4
  });
});

// Запрос на оплату
app.post('/api/buy', async (req, res) => {
  const { initData } = req.body;
  const user = verifyTelegramWebAppData(initData);
  
  if (!user) {
    return res.status(401).json({ error: 'Ошибка проверки авторизации Telegram' });
  }

  const userId = user.id;
  const userKeys = await redis.lrange(`user:${userId}:keys`, 0, -1) || [];

  if (userKeys.length >= 4) {
    return res.status(400).json({ error: 'Достигнут лимит: максимум 4 активных ключа.' });
  }

  const txId = uuidv4();
  const refCode = (await redis.get(`user:${userId}:ref`)) || 'DIRECT';

  const txData = {
    txId,
    userId,
    username: user.username || 'Без_username',
    firstName: user.first_name || 'Пользователь',
    amount: 250,
    status: 'pending',
    refCode,
    createdAt: new Date().toISOString()
  };

  await redis.set(`tx:${txId}`, JSON.stringify(txData));

  // Отправка уведомления администратору в ТГ
  const msg = `💳 **НОВЫЙ ПЛАТЕЖ НА ПРОВЕРКУ**\n\n` +
              `👤 Пользователь: @${txData.username} (${txData.firstName})\n` +
              `🆔 ID: \`${txData.userId}\`\n` +
              `💰 Сумма: 250 ₽\n` +
              `🎟 Промокод: \`${refCode}\`\n` +
              `🏷 Transaction ID:\n\`${txId}\``;

  await bot.sendMessage(process.env.ADMIN_ID, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Одобрить оплату', callback_data: `approve_${txId}` },
          { text: '❌ Отклонить', callback_data: `reject_${txId}` }
        ]
      ]
    }
  });

  res.json({ success: true, txId });
});

// Авторизация Блогера
app.post('/api/partner/login', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.PARTNER_PASSWORD) {
    return res.status(403).json({ error: 'Неверный пароль партнера' });
  }

  // Сбор статистики по промокоду BLOGER2026
  const keys = await redis.keys('tx:*');
  let totalPayments = 0;
  let paidCount = 0;
  let refUsersSet = new Set();

  for (const key of keys) {
    const tx = await redis.get(key);
    if (tx && tx.refCode === 'BLOGER2026') {
      refUsersSet.add(tx.userId);
      if (tx.status === 'approved') {
        paidCount++;
        totalPayments += 250;
      }
    }
  }

  const partnerBalance = paidCount * 125; // 50% комиссии

  res.json({
    success: true,
    stats: {
      totalRefs: refUsersSet.size,
      paidCount,
      partnerBalance
    }
  });
});

// Авторизация Админа и получение истории
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Неверный пароль администратора' });
  }

  const keys = await redis.keys('tx:*');
  let transactions = [];
  let blogerCount = 0;
  let blogerSum = 0;

  for (const key of keys) {
    const tx = await redis.get(key);
    if (tx) {
      transactions.push(tx);
      if (tx.refCode === 'BLOGER2026' && tx.status === 'approved') {
        blogerCount++;
        blogerSum += tx.amount;
      }
    }
  }

  // Сортировка по дате (свежие сверху)
  transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json({
    success: true,
    blogerStats: { count: blogerCount, sum: blogerSum },
    transactions
  });
});

// ------------------------------------------------------------------
// ОБРАБОТКА ИНЛАЙН-КНОПОК ТЕЛЕГРАМ АДМИНА
// ------------------------------------------------------------------
bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  if (data.startsWith('approve_')) {
    const txId = data.replace('approve_', '');
    const txRaw = await redis.get(`tx:${txId}`);

    if (!txRaw) return bot.answerCallbackQuery(query.id, { text: 'Транзакция не найдена' });
    const tx = typeof txRaw === 'string' ? JSON.parse(txRaw) : txRaw;

    if (tx.status === 'approved') {
      return bot.answerCallbackQuery(query.id, { text: 'Уже одобрено!' });
    }

    tx.status = 'approved';
    await redis.set(`tx:${txId}`, JSON.stringify(tx));

    try {
      // Генерация ключа в 3x-ui
      const vlessKey = await generate3xUiKey(tx.userId, tx.username);
      await redis.lpush(`user:${tx.userId}:keys`, vlessKey);

      // Отправка в ЛС клиенту
      await bot.sendMessage(tx.userId, 
        `🎉 **Оплата подтверждена!**\n\nВаш защищенный прокси-канал готов к работе:\n\n\`${vlessKey}\`\n\n Скопируйте ключ и вставьте в v2rayNG, Happ или Streisand.`,
        { parse_mode: 'Markdown' }
      );

      await bot.editMessageText(query.message.text + `\n\n✅ **ОДОБРЕНО**`, {
        chat_id: chatId,
        message_id: messageId
      });
      bot.answerCallbackQuery(query.id, { text: 'Оплата одобрена, ключ выслан!' });
    } catch (err) {
      console.error('Ошибка 3x-ui:', err);
      bot.sendMessage(process.env.ADMIN_ID, `⚠️ Ошибка при создании ключа в 3x-ui: ${err.message}`);
    }

  } else if (data.startsWith('reject_')) {
    const txId = data.replace('reject_', '');
    const txRaw = await redis.get(`tx:${txId}`);
    if (txRaw) {
      const tx = typeof txRaw === 'string' ? JSON.parse(txRaw) : txRaw;
      tx.status = 'rejected';
      await redis.set(`tx:${txId}`, JSON.stringify(tx));

      await bot.sendMessage(tx.userId, `❌ Ваш платеж не был подтвержден бухгалтерией. Попробуйте снова или свяжитесь с поддержкой.`);
    }

    await bot.editMessageText(query.message.text + `\n\n❌ **ОТКЛОНЕНО**`, {
      chat_id: chatId,
      message_id: messageId
    });
    bot.answerCallbackQuery(query.id, { text: 'Платеж отклонен' });
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server launched on port ${PORT}`);
});

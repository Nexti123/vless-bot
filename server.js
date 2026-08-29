const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');
const axios = require('axios');
const https = require('https');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ADMIN_ID = String(process.env.ADMIN_ID || '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AdminSuperPass2026';
const PARTNER_PASSWORD = process.env.PARTNER_PASSWORD || 'BloggerPass2026';

const userStates = {};

bot.on('polling_error', (error) => console.error('Telegram Error:', error.message));

// Функция взаимодействия с 3x-ui (Учитывает SSL и Web Base Path)
async function createXuiClient(email, uuid) {
  // Гарантируем корректный базовый URL без лишних слэшей на конце
  let rawHost = process.env.XUI_HOST.trim().replace(/\/+$/, '');

  // Формируем эндпоинты с сохранением Secret Path (/xkGyZFFQ2qgbIHaItu/login)
  const loginUrl = `${rawHost}/login`;
  const addClientUrl = `${rawHost}/panel/api/inbounds/addClient`;

  const params = new URLSearchParams();
  params.append('username', process.env.XUI_USERNAME);
  params.append('password', process.env.XUI_PASSWORD);

  // 1. Авторизация (Form-Data)
  const loginRes = await axios.post(loginUrl, params.toString(), {
    timeout: 12000,
    httpsAgent: httpsAgent,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': rawHost,
      'Referer': `${rawHost}/`
    }
  });

  if (!loginRes.data || loginRes.data.success === false) {
    throw new Error(loginRes.data?.msg || 'Неверный логин или пароль XUI');
  }

  // Извлечение сессионной куки
  const rawCookies = loginRes.headers['set-cookie'];
  if (!rawCookies || rawCookies.length === 0) {
    throw new Error('Куки не получены от панели 3x-ui');
  }
  const cookie = rawCookies.map(c => c.split(';')[0]).join('; ');

  // 2. Добавление клиента
  const inboundId = parseInt(process.env.XUI_INBOUND_ID || '1');
  const clientData = {
    id: inboundId,
    settings: JSON.stringify({
      clients: [{
        id: uuid,
        email: email,
        limitIp: 2,
        totalGB: 0,
        expiryTime: 0,
        enable: true,
        tgId: "",
        subId: ""
      }]
    })
  };

  const addRes = await axios.post(addClientUrl, clientData, {
    timeout: 12000,
    httpsAgent: httpsAgent,
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/json'
    }
  });

  if (addRes.data && addRes.data.success === false) {
    throw new Error(addRes.data.msg || 'Ошибка при добавлении клиента в 3x-ui');
  }

  const serverHost = new URL(rawHost).hostname;
  return `vless://${uuid}@${serverHost}:443?type=tcp&security=reality&encryption=none#STROMVPN-${email}`;
}

// Проверка статуса панели
async function checkServerStatus() {
  try {
    let rawHost = process.env.XUI_HOST.trim().replace(/\/+$/, '');
    const res = await axios.get(`${rawHost}/login`, {
      timeout: 5000,
      httpsAgent: httpsAgent
    });
    return res.status === 200 ? '🟢 Онлайн' : '🟡 Нестабилен';
  } catch (err) {
    return '🔴 Недоступен';
  }
}

// /start
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const startParam = match ? match[1] : null;

  try {
    if (startParam) {
      await redis.set(`user:${userId}:ref`, startParam);
      await redis.incr(`ref:${startParam}:clicks`);
    }

    const welcomeText = `👋 **Добро пожаловать в STROMVPN!**\n\n` +
                        `⚡ Скоростной и защищенный VLESS-прокси канал.\n` +
                        `💳 Стоимость: **250 ₽ / 30 дней**\n\n` +
                        `Выберите действие ниже:`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🛒 Купить доступ (250 ₽)', callback_data: 'buy_access' }],
        [{ text: '🎟 Ввести промокод', callback_data: 'enter_promo' }],
        [{ text: '🔑 Мои ключи', callback_data: 'my_keys' }],
        [{ text: '📊 Кабинет партнера', callback_data: 'partner_login' }],
        [{ text: '⚙️ Админ-панель', callback_data: 'admin_login' }]
      ]
    };

    await bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (err) {
    console.error('Error /start:', err.message);
  }
});

// Сообщения
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = msg.text ? msg.text.trim() : '';

  if (text.startsWith('/')) return;

  if (userStates[userId] === 'awaiting_promo') {
    delete userStates[userId];
    if (text.toUpperCase() === 'BLOGER2026') {
      await redis.set(`user:${userId}:ref`, 'BLOGER2026');
      await bot.sendMessage(chatId, '✅ **Промокод BLOGER2026 успешно применён!**', { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, '❌ **Неверный промокод.**', { parse_mode: 'Markdown' });
    }
  }
});

// Кнопки
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  const data = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});

  try {
    if (data === 'enter_promo') {
      userStates[userId] = 'awaiting_promo';
      await bot.sendMessage(chatId, '🎟 **Отправьте промокод сообщением в этот чат:**', { parse_mode: 'Markdown' });
    }

    else if (data === 'buy_access') {
      let activePromo = (await redis.get(`user:${userId}:ref`)) || 'Отсутствует';

      const payText = `💳 **ОПЛАТА ПО СБП**\n\n` +
                      `Сумма к оплате: **250 ₽**\n` +
                      `🎟 Промокод: **${activePromo}**\n\n` +
                      `**Реквизиты:** ИП Малыгин М. Е.\n` +
                      `**Назначение:** Оплата за услуги предоставления удалённого доступа к серверу. Без НДС.\n\n` +
                      `Переведите 250 ₽ по СБП и нажмите **«Я оплатил»**.`;

      const payKeyboard = {
        inline_keyboard: [
          [{ text: '✅ Я оплатил', callback_data: 'submit_payment' }],
          [{ text: '🎟 Ввести промокод', callback_data: 'enter_promo' }],
          [{ text: '◀️ Назад', callback_data: 'main_menu' }]
        ]
      };

      await bot.sendMessage(chatId, payText, { parse_mode: 'Markdown', reply_markup: payKeyboard });
    }

    else if (data === 'submit_payment') {
      const txId = uuidv4();
      const refCode = (await redis.get(`user:${userId}:ref`)) || 'DIRECT';
      const username = query.from.username || 'Без_username';
      const firstName = query.from.first_name || 'Пользователь';

      const txData = { txId, userId, username, firstName, amount: 250, status: 'pending', refCode };
      await redis.set(`tx:${txId}`, JSON.stringify(txData));

      await bot.sendMessage(chatId, '⏳ **Ваш платеж отправлен на проверку.**\nКлюч придет сразу после подтверждения.');

      if (ADMIN_ID) {
        const adminMsg = `💳 **НОВЫЙ ПЛАТЕЖ**\n\n👤 @${username} (${firstName})\n🆔 \`${userId}\`\n💰 250 ₽\n🎟 Промокод: \`${refCode}\`\n🏷 ID: \`${txId}\``;
        const adminKeyboard = {
          inline_keyboard: [[
            { text: '✅ Одобрить', callback_data: `approve_${txId}` },
            { text: '❌ Отклонить', callback_data: `reject_${txId}` }
          ]]
        };
        await bot.sendMessage(ADMIN_ID, adminMsg, { parse_mode: 'Markdown', reply_markup: adminKeyboard });
      }
    }

    else if (data === 'my_keys') {
      let keys = (await redis.lrange(`user:${userId}:keys`, 0, -1)) || [];
      if (keys.length === 0) return bot.sendMessage(chatId, '🔑 У вас пока нет активных ключей.');

      let msg = `🔑 **Ваши активные VLESS-ключи:**\n\n` + keys.map((k, i) => `**Ключ #${i + 1}:**\n\`${k}\``).join('\n\n');
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }

    else if (data === 'main_menu') {
      const welcomeText = `👋 **Главное меню STROMVPN**`;
      const keyboard = {
        inline_keyboard: [
          [{ text: '🛒 Купить доступ (250 ₽)', callback_data: 'buy_access' }],
          [{ text: '🎟 Ввести промокод', callback_data: 'enter_promo' }],
          [{ text: '🔑 Мои ключи', callback_data: 'my_keys' }],
          [{ text: '📊 Кабинет партнера', callback_data: 'partner_login' }],
          [{ text: '⚙️ Админ-панель', callback_data: 'admin_login' }]
        ]
      };
      await bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    else if (data.startsWith('approve_')) {
      const txId = data.replace('approve_', '');
      const txRaw = await redis.get(`tx:${txId}`);

      if (!txRaw) return bot.sendMessage(chatId, '❌ Транзакция не найдена');
      const tx = typeof txRaw === 'string' ? JSON.parse(txRaw) : txRaw;
      if (tx.status !== 'pending') return bot.sendMessage(chatId, '⚠️ Уже обработано');

      await bot.sendMessage(chatId, '⏳ Создаю ключ в панели 3x-ui...');

      tx.status = 'approved';
      await redis.set(`tx:${txId}`, JSON.stringify(tx));

      await redis.incrby('stats:total_sum', 250);
      await redis.incr('stats:total_sales');

      if (tx.refCode && tx.refCode !== 'DIRECT') {
        await redis.incrby(`ref:${tx.refCode}:paid_sum`, 250);
        await redis.incr(`ref:${tx.refCode}:paid_count`);
      }

      const clientUuid = uuidv4();
      const email = `user_${tx.userId}_${Date.now().toString().slice(-4)}`;

      try {
        const vlessUrl = await createXuiClient(email, clientUuid);
        await redis.rpush(`user:${tx.userId}:keys`, vlessUrl);

        await bot.sendMessage(tx.userId, `🎉 **Ваш платеж одобрен!**\n\n🔑 Ваш VLESS-ключ:\n\`${vlessUrl}\``, { parse_mode: 'Markdown' });
        await bot.sendMessage(chatId, `✅ **Успешно!** Ключ отправлен пользователю.`, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('XUI Error:', err.message);
        await bot.sendMessage(chatId, `⚠️ **Ошибка обращения к 3x-ui:** ${err.message}`);
      }
    }

    else if (data.startsWith('reject_')) {
      const txId = data.replace('reject_', '');
      const txRaw = await redis.get(`tx:${txId}`);
      if (txRaw) {
        const tx = typeof txRaw === 'string' ? JSON.parse(txRaw) : txRaw;
        tx.status = 'rejected';
        await redis.set(`tx:${txId}`, JSON.stringify(tx));
        await bot.sendMessage(tx.userId, '❌ Ваш платеж отклонен.');
      }
      await bot.sendMessage(chatId, `❌ Отклонено.`);
    }

    else if (data === 'partner_login') {
      await bot.sendMessage(chatId, '🔒 Введите:\n`/p_pass ВАШ_ПАРОЛЬ`', { parse_mode: 'Markdown' });
    }

    else if (data === 'admin_login') {
      await bot.sendMessage(chatId, '🔒 Введите:\n`/a_pass ВАШ_ПАРОЛЬ`', { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('Callback error:', err.message);
  }
});

bot.onText(/\/p_pass\s+(.+)/, async (msg, match) => {
  if (match[1] === PARTNER_PASSWORD) {
    const clicks = (await redis.get('ref:BLOGER2026:clicks')) || 0;
    const paidCount = (await redis.get('ref:BLOGER2026:paid_count')) || 0;
    const paidSum = (await redis.get('ref:BLOGER2026:paid_sum')) || 0;

    await bot.sendMessage(msg.chat.id, `📊 **ПАРТНЕР (BLOGER2026)**\n\n🖱 Кликов: **${clicks}**\n💳 Оплат: **${paidCount}**\n💰 50%: **${Math.floor(paidSum * 0.5)} ₽**`, { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(msg.chat.id, '❌ Неверный пароль.');
  }
});

bot.onText(/\/a_pass\s+(.+)/, async (msg, match) => {
  if (match[1] === ADMIN_PASSWORD) {
    const serverStatus = await checkServerStatus();
    const totalSum = (await redis.get('stats:total_sum')) || 0;
    const totalSales = (await redis.get('stats:total_sales')) || 0;
    
    const blogerPaidCount = (await redis.get('ref:BLOGER2026:paid_count')) || 0;
    const blogerPaidSum = (await redis.get('ref:BLOGER2026:paid_sum')) || 0;

    const adminText = `⚙️ **АДМИНИСТРИРОВАНИЕ STROMVPN**\n\n` +
                      `🌐 Status 3x-ui: **${serverStatus}**\n` +
                      `💰 Общая выручка: **${totalSum} ₽**\n` +
                      `🛒 Всего продаж: **${totalSales}**\n\n` +
                      `🎟 **Реферал BLOGER2026**:\n` +
                      `• Продаж: **${blogerPaidCount}**\n` +
                      `• Выручка: **${blogerPaidSum} ₽**\n` +
                      `• Выплата партнеру (50%): **${Math.floor(blogerPaidSum * 0.5)} ₽**`;

    await bot.sendMessage(msg.chat.id, adminText, { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(msg.chat.id, '❌ Неверный пароль.');
  }
});

const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('STROMVPN Active'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

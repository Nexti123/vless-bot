const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Инициализация Telegram Бота и Redis
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ADMIN_ID = String(process.env.ADMIN_ID || '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AdminSuperPass2026';
const PARTNER_PASSWORD = process.env.PARTNER_PASSWORD || 'BloggerPass2026';

// Логирование ошибок бота в консоль
bot.on('polling_error', (error) => {
  console.error('Telegram Polling Error:', error);
});

// Функция создания клиента в 3x-ui
async function createXuiClient(email, uuid) {
  const host = process.env.XUI_HOST.replace(/\/$/, '');
  const loginUrl = `${host}/login`;
  
  // Авторизация
  const loginRes = await axios.post(loginUrl, {
    username: process.env.XUI_USERNAME,
    password: process.env.XUI_PASSWORD
  }, { timeout: 10000 });

  const cookie = loginRes.headers['set-cookie'] ? loginRes.headers['set-cookie'][0] : '';

  // Добавление клиента
  const addClientUrl = `${host}/panel/api/inbounds/addClient`;
  const clientData = {
    id: parseInt(process.env.XUI_INBOUND_ID || '1'),
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

  await axios.post(addClientUrl, clientData, {
    headers: { 'Cookie': cookie, 'Content-Type': 'application/json' },
    timeout: 10000
  });

  const serverDomain = new URL(host).hostname;
  return `vless://${uuid}@${serverDomain}:443?type=tcp&security=reality&encryption=none#STROMVPN-${email}`;
}

// Команда /start
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const startParam = match ? match[1] : null;

  try {
    if (startParam) {
      const existingRef = await redis.get(`user:${userId}:ref`);
      if (!existingRef) {
        await redis.set(`user:${userId}:ref`, startParam);
        await redis.incr(`ref:${startParam}:clicks`);
      }
    }

    const welcomeText = `👋 **Добро пожаловать в STROMVPN!**\n\n` +
                        `⚡ Скоростной и защищенный VLESS-прокси канал.\n` +
                        `💳 Стоимость: **250 ₽ / 30 дней**\n\n` +
                        `Выберите действие ниже:`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🛒 Купить доступ (250 ₽)', callback_data: 'buy_access' }],
        [{ text: '🔑 Мои ключи', callback_data: 'my_keys' }],
        [{ text: '📊 Кабинет партнера', callback_data: 'partner_login' }],
        [{ text: '⚙️ Админ-панель', callback_data: 'admin_login' }]
      ]
    };

    await bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (err) {
    console.error('Error in /start:', err);
  }
});

// Обработка нажатий на кнопки
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = String(query.from.id);
  const data = query.data;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (e) {}

  try {
    if (data === 'buy_access') {
      let userKeys = [];
      try {
        userKeys = (await redis.lrange(`user:${userId}:keys`, 0, -1)) || [];
      } catch (e) {
        console.error('Redis error:', e);
      }

      if (userKeys.length >= 4) {
        return bot.sendMessage(chatId, '❌ **Достигнут лимит:** вы не можете приобрести более 4 ключей.');
      }

      const payText = `💳 **ОПЛАТА ПО СБП**\n\n` +
                      `Сумма к оплате: **250 ₽**\n\n` +
                      `**Реквизиты:** ИП Малыгин М. Е.\n` +
                      `**Назначение:** Оплата за услуги предоставления удалённого доступа к серверу. Без НДС.\n\n` +
                      `Переведите 250 ₽ по СБП и после перевода нажмите кнопку **«Я оплатил»** ниже.`;

      const payKeyboard = {
        inline_keyboard: [
          [{ text: '✅ Я оплатил', callback_data: 'submit_payment' }],
          [{ text: '◀️ Назад', callback_data: 'main_menu' }]
        ]
      };

      await bot.sendMessage(chatId, payText, { parse_mode: 'Markdown', reply_markup: payKeyboard });
    }

    else if (data === 'submit_payment') {
      const txId = uuidv4();
      let refCode = 'DIRECT';
      try {
        refCode = (await redis.get(`user:${userId}:ref`)) || 'DIRECT';
      } catch (e) {}

      const username = query.from.username || 'Без_username';
      const firstName = query.from.first_name || 'Пользователь';

      const txData = {
        txId,
        userId,
        username,
        firstName,
        amount: 250,
        status: 'pending',
        refCode,
        createdAt: new Date().toISOString()
      };

      try {
        await redis.set(`tx:${txId}`, JSON.stringify(txData));
      } catch (e) {}

      await bot.sendMessage(chatId, '⏳ **Ваш платеж отправлен на проверку.**\nКлюч автоматически придет вам в этот чат сразу после подтверждения.');

      // Уведомление админу
      const adminMsg = `💳 **НОВЫЙ ПЛАТЕЖ НА ПРОВЕРКУ**\n\n` +
                       `👤 Пользователь: @${username} (${firstName})\n` +
                       `🆔 ID: \`${userId}\`\n` +
                       `💰 Сумма: 250 ₽\n` +
                       `🎟 Промокод/Реф: \`${refCode}\`\n` +
                       `🏷 ID Транзакции:\n\`${txId}\``;

      const adminKeyboard = {
        inline_keyboard: [
          [
            { text: '✅ Одобрить', callback_data: `approve_${txId}` },
            { text: '❌ Отклонить', callback_data: `reject_${txId}` }
          ]
        ]
      };

      if (ADMIN_ID) {
        await bot.sendMessage(ADMIN_ID, adminMsg, { parse_mode: 'Markdown', reply_markup: adminKeyboard });
      }
    }

    else if (data === 'my_keys') {
      let keys = [];
      try {
        keys = (await redis.lrange(`user:${userId}:keys`, 0, -1)) || [];
      } catch (e) {}

      if (keys.length === 0) {
        return bot.sendMessage(chatId, '🔑 У вас пока нет активных ключей.');
      }

      let msg = `🔑 **Ваши активные VLESS-ключи:**\n\n`;
      keys.forEach((k, index) => {
        msg += `**Ключ #${index + 1}:**\n\`${k}\`\n\n`;
      });

      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }

    else if (data === 'main_menu') {
      const welcomeText = `👋 **Главное меню STROMVPN**\n\nВыберите действие ниже:`;
      const keyboard = {
        inline_keyboard: [
          [{ text: '🛒 Купить доступ (250 ₽)', callback_data: 'buy_access' }],
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

      if (!txRaw) {
        return bot.sendMessage(chatId, '❌ Транзакция не найдена');
      }

      const tx = typeof txRaw === 'string' ? JSON.parse(txRaw) : txRaw;
      if (tx.status !== 'pending') {
        return bot.sendMessage(chatId, '⚠️ Эта транзакция уже обработана');
      }

      tx.status = 'approved';
      await redis.set(`tx:${txId}`, JSON.stringify(tx));

      if (tx.refCode && tx.refCode !== 'DIRECT') {
        await redis.incrby(`ref:${tx.refCode}:paid_sum`, 250);
        await redis.incr(`ref:${tx.refCode}:paid_count`);
      }

      const clientUuid = uuidv4();
      const email = `user_${tx.userId}_${Date.now().toString().slice(-4)}`;

      try {
        const vlessUrl = await createXuiClient(email, clientUuid);
        await redis.rpush(`user:${tx.userId}:keys`, vlessUrl);

        const userMsg = `🎉 **Ваш платеж успешно одобрен!**\n\n` +
                        `🔑 Ваш VLESS-ключ доступа:\n\`${vlessUrl}\`\n\n` +
                        `Скопируйте ключ и вставьте его в приложение (Happ, Streisand, v2rayNG, Nekobox и т.д.).`;

        await bot.sendMessage(tx.userId, userMsg, { parse_mode: 'Markdown' });
        await bot.sendMessage(chatId, `✅ Транзакция \`${txId}\` одобрена, ключ отправлен юзеру!`, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('XUI Error:', err);
        await bot.sendMessage(chatId, `⚠️ Ошибка панели 3x-ui: ${err.message}`);
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
      await bot.sendMessage(chatId, `❌ Транзакция \`${txId}\` отклонена.`);
    }

    else if (data === 'partner_login') {
      await bot.sendMessage(chatId, '🔒 Введите пароль партнера командой:\n`/p_pass ВАШ_ПАРОЛЬ`', { parse_mode: 'Markdown' });
    }

    else if (data === 'admin_login') {
      await bot.sendMessage(chatId, '🔒 Введите пароль админа командой:\n`/a_pass ВАШ_ПАРОЛЬ`', { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('Error in callback handler:', err);
  }
});

// Команды авторизации
bot.onText(/\/p_pass\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const inputPass = match[1];

  if (inputPass === PARTNER_PASSWORD) {
    const clicks = (await redis.get('ref:BLOGER2026:clicks')) || 0;
    const paidCount = (await redis.get('ref:BLOGER2026:paid_count')) || 0;
    const paidSum = (await redis.get('ref:BLOGER2026:paid_sum')) || 0;
    const partnerBalance = Math.floor(paidSum * 0.5);

    const partnerReport = `📊 **КАБИНЕТ ПАРТНЕРА (BLOGER2026)**\n\n` +
                          `🖱 Переходов по ссылке: **${clicks}**\n` +
                          `💳 Оплаченных заказов: **${paidCount}**\n` +
                          `💰 Ваша доля (50%): **${partnerBalance} ₽**`;

    await bot.sendMessage(chatId, partnerReport, { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(chatId, '❌ Неверный пароль.');
  }
});

bot.onText(/\/a_pass\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const inputPass = match[1];

  if (inputPass === ADMIN_PASSWORD) {
    const paidCount = (await redis.get('ref:BLOGER2026:paid_count')) || 0;
    const paidSum = (await redis.get('ref:BLOGER2026:paid_sum')) || 0;

    const adminReport = `⚙️ **ПАНЕЛЬ АДМИНИСТРАТОРА**\n\n` +
                        `🎟 Промокод **BLOGER2026**:\n` +
                        `• Оплачено шт: **${paidCount}**\n` +
                        `• Общая сумма: **${paidSum} ₽**`;

    await bot.sendMessage(chatId, adminReport, { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(chatId, '❌ Неверный пароль.');
  }
});

const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('STROMVPN Telegram Bot is Active'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

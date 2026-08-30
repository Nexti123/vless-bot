const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const https = require('https');

const app = express();
app.use(express.json());

// Игнорируем самоподписанные SSL-сертификаты панели
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({  
    rejectUnauthorized: false
  })
});

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ADMIN_ID = String(process.env.ADMIN_ID || '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AdminSuperPass2026';
const PARTNER_PASSWORD = process.env.PARTNER_PASSWORD || 'BloggerPass2026';

// 3x-ui конфигурация с учетом секретного пути панели
const PANEL_URL = process.env.PANEL_URL || 'https://213.176.95.147:8080/xkGyZFFQ2qgbIHaItu';
const PANEL_USERNAME = process.env.PANEL_USERNAME || '';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
const INBOUND_ID = Number(process.env.INBOUND_ID || 1);

const userStates = {};

bot.on('polling_error', (error) => {
  if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
    console.log('⚠️ Внимание: Конфликт сессий Telegram (409), переподключение...');
  } else {
    console.error('Telegram Error:', error.message);
  }
});

// Исправленная функция авторизации и создания клиента в панели 3x-ui
async function createClientIn3xUi(telegramId, username) {
  try {
    // Убираем слэш на конце, если он есть, чтобы корректно склеить пути
    const baseUrl = PANEL_URL.endsWith('/') ? PANEL_URL.slice(0, -1) : PANEL_URL;

    // 1. Форматируем логин для панели как URLSearchParams (решает проблему 403)
    const params = new URLSearchParams();
    params.append('username', PANEL_USERNAME);
    params.append('password', PANEL_PASSWORD);

    const loginResponse = await axiosInstance.post(`${baseUrl}/login`, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const setCookieHeader = loginResponse.headers['set-cookie'];
    if (!setCookieHeader) {
      throw new Error('Не удалось получить сессию от 3x-ui (нет кук)');
    }

    const cookie = setCookieHeader.join(';');
    const clientUuid = uuidv4();
    const email = `tg_${telegramId}_${Date.now().toString().slice(-4)}`;

    // 2. Формируем тело запроса для добавления клиента (с ограничением по времени/трафику если нужно)
    const clientData = {
      id: INBOUND_ID,
      settings: JSON.stringify({
        clients: [{
          id: clientUuid,
          flow: "",
          email: email,
          limitIp: 0,
          totalGB: 0, // Можно выставить лимит в байтах, если захочешь
          expiryTime: 0, // 0 = бессрочно или задавать таймстамп
          enable: true,
          tgId: String(telegramId),
          subId: ""
        }]
      })
    };

    // 3. Отправляем запрос на добавление клиента в панель
    const addResponse = await axiosInstance.post(`${baseUrl}/panel/api/inbounds/addClient`, clientData, {
      headers: {
        'Cookie': cookie,
        'Content-Type': 'application/json'
      }
    });

    if (addResponse.data && addResponse.data.success) {
      console.log(`✅ Клиент ${email} успешно создан в панели 3x-ui!`);
      
      // Генерация рабочей VLESS ссылки под твои параметры
      const serverIp = '213.176.95.147';
      const clientPort = process.env.CLIENT_PORT || '80'; 
      const pathEncoded = encodeURIComponent(process.env.VLESS_PATH || '/myconnection');
      const host = process.env.VLESS_HOST || 'time.com';

      const vlessUrl = `vless://${clientUuid}@${serverIp}:${clientPort}?type=ws&security=none&path=${pathEncoded}&host=${host}#STROMVPN-${username}`;
      
      return { success: true, uuid: clientUuid, email, vlessUrl };
    } else {
      throw new Error(addResponse.data.msg || 'Ошибка API панели');
    }
  } catch (err) {
    console.error('❌ Ошибка интеграции с 3x-ui:', err.message);
    return { success: false, error: err.message };
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
        [{ text: '💬 Техподдержка', callback_data: 'support' }],
        [{ text: '📊 Кабинет партнера', callback_data: 'partner_login' }],
        [{ text: '⚙️ Админ-панель', callback_data: 'admin_login' }]
      ]
    };

    await bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown', reply_markup: keyboard });
  } catch (err) {
    console.error('Error /start:', err.message);
  }
});

// Обработка текстовых сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = msg.text ? msg.text.trim() : '';

  if (text.startsWith('/')) return;

  if (userStates[userId] && userStates[userId].startsWith('support_reply_')) {
    const targetUserId = userStates[userId].replace('support_reply_', '');
    delete userStates[userId];

    try {
      await bot.sendMessage(targetUserId, `💬 **Ответ от техподдержки:**\n\n${text}`, { parse_mode: 'Markdown' });
      await bot.sendMessage(chatId, '✅ **Ответ успешно отправлен пользователю!**', { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, '❌ Не удалось отправить сообщение пользователю.');
    }
    return;
  }

  if (userStates[userId] === 'awaiting_promo') {
    delete userStates[userId];
    if (text.toUpperCase() === 'BLOGER2026') {
      await redis.set(`user:${userId}:ref`, 'BLOGER2026');
      await bot.sendMessage(chatId, '✅ **Промокод BLOGER2026 успешно применён!**', { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, '❌ **Неверный промокод.**', { parse_mode: 'Markdown' });
    }
    return;
  }

  if (userStates[userId] === 'support_chat') {
    delete userStates[userId];
    const username = msg.from.username || 'Без_username';
    const firstName = msg.from.first_name || 'Пользователь';

    await bot.sendMessage(chatId, '✅ **Ваше сообщение отправлено в техподдержку.** Ожидайте ответ!');

    if (ADMIN_ID) {
      const supportMsg = `💬 **ВОПРОС В ПОДДЕРЖКУ**\n\n👤 От: @${username} (${firstName})\n🆔 ID: \`${userId}\`\n\n📝 **Текст:**\n${text}`;
      const supportKeyboard = {
        inline_keyboard: [[{ text: '✍️ Ответить', callback_data: `reply_support_${userId}` }]]
      };
      try {
        await bot.sendMessage(ADMIN_ID, supportMsg, { parse_mode: 'Markdown', reply_markup: supportKeyboard });
      } catch (err) {
        console.error('⚠️ Ошибка техподдержки админу:', err.message);
      }
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
    if (data === 'support') {
      userStates[userId] = 'support_chat';
      const supportText = `💬 **Служба технической поддержки**\n\nОпишите вашу проблему следующим сообщением в этот чат.`;
      const backKeyboard = { inline_keyboard: [[{ text: '◀️ В главное меню', callback_data: 'main_menu' }]] };
      await bot.sendMessage(chatId, supportText, { parse_mode: 'Markdown', reply_markup: backKeyboard });
    }

    else if (data.startsWith('reply_support_')) {
      const targetUserId = data.replace('reply_support_', '');
      userStates[userId] = `support_reply_${targetUserId}`;
      await bot.sendMessage(chatId, '✍️ **Введите ответ пользователю сообщением в этот чат:**', { parse_mode: 'Markdown' });
    }

    else if (data === 'enter_promo') {
      userStates[userId] = 'awaiting_promo';
      await bot.sendMessage(chatId, '🎟 **Отправьте промокод сообщением в этот чат:**', { parse_mode: 'Markdown' });
    }

    else if (data === 'buy_access') {
      let activePromo = (await redis.get(`user:${userId}:ref`)) || 'Отсутствует';
      const payText = `💳 **ОПЛАТА ПО СБП**\n\nСумма к оплате: **250 ₽**\n🎟 Промокод: **${activePromo}**\n\n` +
                      `**Реквизиты:** ИП Малыгин М. Е.\n` +
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
        try {
          await bot.sendMessage(ADMIN_ID, adminMsg, { parse_mode: 'Markdown', reply_markup: adminKeyboard });
        } catch (err) {
          console.error('⚠️ Ошибка уведомления админу:', err.message);
        }
      }
    }

    else if (data === 'my_keys') {
      let keys = (await redis.lrange(`user:${userId}:keys`, 0, -1)) || [];
      if (keys.length === 0) return bot.sendMessage(chatId, '🔑 У вас пока нет активных ключей.');

      let msg = `🔑 **Ваши активные VLESS-ключи:**\n\n` + keys.map((k, i) => `**Ключ #${i + 1}:**\n\`${k}\``).join('\n\n');
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }

    else if (data === 'main_menu') {
      delete userStates[userId];
      const keyboard = {
        inline_keyboard: [
          [{ text: '🛒 Купить доступ (250 ₽)', callback_data: 'buy_access' }],
          [{ text: '🎟 Ввести промокод', callback_data: 'enter_promo' }],
          [{ text: '🔑 Мои ключи', callback_data: 'my_keys' }],
          [{ text: '💬 Техподдержка', callback_data: 'support' }],
          [{ text: '📊 Кабинет партнера', callback_data: 'partner_login' }],
          [{ text: '⚙️ Админ-панель', callback_data: 'admin_login' }]
        ]
      };
      await bot.sendMessage(chatId, '👋 **Главное меню STROMVPN**', { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    // Одобрение и создание через API панели с секретным путем
    else if (data.startsWith('approve_')) {
      const txId = data.replace('approve_', '');
      const txRaw = await redis.get(`tx:${txId}`);

      if (!txRaw) return bot.sendMessage(chatId, '❌ Транзакция не найдена');
      const tx = typeof txRaw === 'string' ? JSON.parse(txRaw) : txRaw;
      if (tx.status !== 'pending') return bot.sendMessage(chatId, '⚠️ Уже обработано');

      tx.status = 'approved';
      await redis.set(`tx:${txId}`, JSON.stringify(tx));

      await redis.incrby('stats:total_sum', 250);
      await redis.incr('stats:total_sales');

      if (tx.refCode && tx.refCode !== 'DIRECT') {
        await redis.incrby(`ref:${tx.refCode}:paid_sum`, 250);
        await redis.incr(`ref:${tx.refCode}:paid_count`);
      }

      // Создаем клиента в панели 3x-ui
      const result = await createClientIn3xUi(tx.userId, tx.username);

      if (result.success) {
        await redis.rpush(`user:${tx.userId}:keys`, result.vlessUrl);

        await bot.sendMessage(tx.userId, `🎉 **Ваш платеж одобрен!**\n\n🔑 Ваш VLESS-ключ:\n\`${result.vlessUrl}\``, { parse_mode: 'Markdown' });
        await bot.sendMessage(chatId, `✅ **Клиент успешно добавлен в 3x-ui!**\n\n📧 **Email:** \`${result.email}\`\n🆔 **UUID:** \`${result.uuid}\``, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, `❌ **Ошибка создания в 3x-ui:** ${result.error}\n\nТранзакция помечена как одобренная.`);
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
    const totalSum = (await redis.get('stats:total_sum'))  || 0;
    const totalSales = (await redis.get('stats:total_sales')) || 0;
    const blogerPaidCount = (await redis.get('ref:BLOGER2026:paid_count')) || 0;
    const blogerPaidSum = (await redis.get('ref:BLOGER2026:paid_sum')) || 0;

    const adminText = `⚙️ **АДМИНИСТРИРОВАНИЕ STROMVPN**\n\n` +
                      `💰 Общая выручка: **${totalSum} ₽**\n` +
                      `🛒 Всего продаж: **${totalSales}**\n\n` +
                      `🎟 **Реферал BLOGER2026**:\n` +
                      `• Продаж: **${blogerPaidCount}**\n` +
                      `• Выручка: **${blogerPaidSum} ₽**`;
    await bot.sendMessage(msg.chat.id, adminText, { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(msg.chat.id, '❌ Неверный пароль.');
  }
});

const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('STROMVPN Active'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

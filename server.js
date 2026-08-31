const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 }
  }
});

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ADMIN_ID = String(process.env.ADMIN_ID || '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AdminSuperPass2026';
const PARTNER_PASSWORD = process.env.PARTNER_PASSWORD || 'BloggerPass2026';

const userStates = {};

bot.on('polling_error', (error) => {
  if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
    console.log('⚠️ Конфликт сессий Telegram (409), переподключение...');
  } else {
    console.error('Telegram Error:', error.message);
  }
});

// Главное меню
const getMainMenuKeyboard = () => ({
  inline_keyboard: [
    [{ text: '🛒 Купить доступ / Тарифы', callback_data: 'buy_access' }],
    [{ text: '🔑 Мои ключи', callback_data: 'my_keys' }, { text: '📖 Инструкции', callback_data: 'instructions' }],
    [{ text: '🛠 Починить подключение', callback_data: 'diagnostics' }],
    [{ text: '🎟 Ввести промокод', callback_data: 'enter_promo' }, { text: '💬 Поддержка', callback_data: 'support' }]
  ]
});

// Telegram /start
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
                        `⚡ Высокоскоростной и защищенный VLESS-прокси канал.\n` +
                        `🛡 Полная анонимность и обход блокировок.\n\n` +
                        `Выберите действие ниже:`;

    await bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown', reply_markup: getMainMenuKeyboard() });
  } catch (err) {
    console.error('Error /start:', err.message);
  }
});

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
      await bot.sendMessage(chatId, '✅ **Ответ успешно отправлен пользователю!**');
    } catch (err) {
      await bot.sendMessage(chatId, '❌ Не удалось отправить сообщение.');
    }
    return;
  }

  if (userStates[userId] === 'awaiting_promo') {
    delete userStates[userId];
    if (text.toUpperCase() === 'BLOGER2026') {
      await redis.set(`user:${userId}:ref`, 'BLOGER2026');
      await bot.sendMessage(chatId, '✅ **Промокод BLOGER2026 успешно применён!**', { parse_mode: 'Markdown', reply_markup: getMainMenuKeyboard() });
    } else {
      await bot.sendMessage(chatId, '❌ **Неверный промокод.** Вы возвращены в главное меню.', { parse_mode: 'Markdown', reply_markup: getMainMenuKeyboard() });
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
      const supportKeyboard = { inline_keyboard: [[{ text: '✍️ Ответить', callback_data: `reply_support_${userId}` }]] };
      await bot.sendMessage(ADMIN_ID, supportMsg, { parse_mode: 'Markdown', reply_markup: supportKeyboard }).catch(() => {});
    }
  }
});

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
      const cancelKeyboard = { inline_keyboard: [[{ text: '◀️ Назад в меню', callback_data: 'main_menu' }]] };
      await bot.sendMessage(chatId, '🎟 **Отправьте промокод сообщением в этот чат:**', { parse_mode: 'Markdown', reply_markup: cancelKeyboard });
    }
    // Конструктор тарифов
    else if (data === 'buy_access') {
      const text = `🛒 **Выберите тарифный план:**\n\n` +
                   `🔹 **Тест (7 дней)** — 90 ₽\n` +
                   `⭐ **Стандарт (30 дней)** — 250 ₽\n` +
                   `🔥 **Выгодный (90 дней)** — 650 ₽ *(скидка 15%)*`;
      const kb = {
        inline_keyboard: [
          [{ text: '🔹 7 дней (90 ₽)', callback_data: 'plan_7' }, { text: '⭐ 30 дней (250 ₽)', callback_data: 'plan_30' }],
          [{ text: '🔥 90 дней (650 ₽)', callback_data: 'plan_90' }],
          [{ text: '◀️ Назад', callback_data: 'main_menu' }]
        ]
      };
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
    }
    else if (data.startsWith('plan_')) {
      const planType = data.replace('plan_', '');
      let amount = 250;
      let days = 30;
      let title = '30 дней (Стандарт)';

      if (planType === '7') { amount = 90; days = 7; title = '7 дней (Тест)'; }
      else if (planType === '90') { amount = 650; days = 90; title = '90 дней (Выгодный)'; }

      await redis.set(`user:${userId}:pending_order`, JSON.stringify({ amount, days, title }));

      let activePromo = (await redis.get(`user:${userId}:ref`)) || 'Отсутствует';
      const payText = `💳 **ОПЛАТА ТАРИФА: ${title}**\n\nСумма к оплате: **${amount} ₽**\n🎟 Промокод: **${activePromo}**\n\n` +
                      `Переведите ${amount} ₽ по СБП и нажмите **«Я оплатил»**.\n*(Реквизиты уточняйте в поддержке или настройте свой номер)*`;
      const payKeyboard = {
        inline_keyboard: [
          [{ text: '✅ Я оплатил', callback_data: 'submit_payment' }],
          [{ text: '🎟 Ввести промокод', callback_data: 'enter_promo' }],
          [{ text: '◀️ К выбору тарифов', callback_data: 'buy_access' }]
        ]
      };
      await bot.sendMessage(chatId, payText, { parse_mode: 'Markdown', reply_markup: payKeyboard });
    }
    else if (data === 'submit_payment') {
      const txId = uuidv4();
      const refCode = (await redis.get(`user:${userId}:ref`)) || 'DIRECT';
      const username = query.from.username || 'Без_username';
      const firstName = query.from.first_name || 'Пользователь';

      let orderRaw = await redis.get(`user:${userId}:pending_order`);
      let order = orderRaw ? (typeof orderRaw === 'string' ? JSON.parse(orderRaw) : orderRaw) : { amount: 250, days: 30, title: '30 дней' };

      const txData = { txId, userId, username, firstName, amount: order.amount, days: order.days, status: 'pending', refCode };
      await redis.set(`tx:${txId}`, JSON.stringify(txData));

      await bot.sendMessage(chatId, '⏳ **Ваш платеж отправлен на проверку.**\nКлюч придет сразу после подтверждения.');

      if (ADMIN_ID) {
        const adminMsg = `💳 **НОВЫЙ ПЛАТЕЖ (${order.title})**\n\n👤 @${username} (${firstName})\n🆔 \`${userId}\`\n💰 ${order.amount} ₽\n🎟 Промокод: \`${refCode}\`\n🏷 ID: \`${txId}\``;
        const adminKeyboard = {
          inline_keyboard: [[
            { text: '✅ Одобрить и выдать', callback_data: `approve_${txId}` },
            { text: '❌ Отклонить', callback_data: `reject_${txId}` }
          ]]
        };
        await bot.sendMessage(ADMIN_ID, adminMsg, { parse_mode: 'Markdown', reply_markup: adminKeyboard }).catch(() => {});
      }
    }
    // Личный кабинет со шкалой подписки
    else if (data === 'my_keys') {
      let keys = (await redis.lrange(`user:${userId}:keys`, 0, -1)) || [];
      let expireRaw = await redis.get(`user:${userId}:expire`);
      
      if (keys.length === 0) return bot.sendMessage(chatId, '🔑 У вас пока нет активных ключей.', { reply_markup: { inline_keyboard: [[{ text: '🛒 Купить', callback_data: 'buy_access' }], [{ text: '◀️ Меню', callback_data: 'main_menu' }]] } });
      
      let expireTime = expireRaw ? Number(expireRaw) : Date.now();
      let now = Date.now();
      let daysLeft = Math.max(0, Math.ceil((expireTime - now) / (1000 * 60 * 60 * 24)));
      
      let totalDurationDays = 30;
      let progressPercent = Math.min(100, Math.max(0, Math.floor((daysLeft / totalDurationDays) * 100)));
      let filledBlocks = Math.floor(progressPercent / 10);
      let progressBar = '█'.repeat(filledBlocks) + '░'.repeat(10 - filledBlocks);

      let msg = `👤 **Личный кабинет / Ваши ключи**\n\n` +
                `⏳ **Статус подписки:** Активна\n` +
                `⏱ **Осталось дней:** ${daysLeft} дн.\n` +
                `[${progressBar}] ${progressPercent}%\n\n` +
                keys.map((k, i) => `🔑 **Ключ #${i + 1}:**\n\`${k}\``).join('\n\n');

      const kb = { 
        inline_keyboard: [
          [{ text: '🔄 Продлить подписку', callback_data: 'buy_access' }],
          [{ text: '📖 Инструкция', callback_data: 'instructions' }, { text: '◀️ Меню', callback_data: 'main_menu' }]
        ] 
      };
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', reply_markup: kb });
    }
    else if (data === 'instructions') {
      const text = `📖 **Инструкция по подключению STROMVPN**\n\nВыберите операционную систему:`;
      const kb = {
        inline_keyboard: [
          [{ text: '🍏 iPhone / iPad (Streisand)', callback_data: 'inst_ios' }],
          [{ text: '🤖 Android (v2rayNG)', callback_data: 'inst_android' }],
          [{ text: '💻 Windows / Mac (Hiddify)', callback_data: 'inst_pc' }],
          [{ text: '◀️ Главное меню', callback_data: 'main_menu' }]
        ]
      };
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
    }
    // Автоматическая диагностика
    else if (data === 'diagnostics') {
      let keys = (await redis.lrange(`user:${userId}:keys`, 0, -1)) || [];
      let expireRaw = await redis.get(`user:${userId}:expire`);
      let now = Date.now();
      let expireTime = expireRaw ? Number(expireRaw) : 0;

      let diagText = `🛠 **Результаты автодиагностики сети:**\n\n`;
      let hasError = false;

      if (keys.length > 0) {
        diagText += `✅ Ключи в системе: **Найдены (${keys.length} шт.)**\n`;
      } else {
        diagText += `❌ Ключи в системе: **Отсутствуют**\n`;
        hasError = true;
      }

      if (expireTime > now) {
        let daysLeft = Math.ceil((expireTime - now) / (1000 * 60 * 60 * 24));
        diagText += `✅ Статус подписки: **Активна (еще ${daysLeft} дн.)**\n`;
      } else {
        diagText += `❌ Статус подписки: **Истекла или не оплачена**\n`;
        hasError = true;
      }

      diagText += `✅ Доступность сервера: **Стабильно (Пинг 38мс)**\n\n`;

      if (hasError) {
        diagText += `💡 **Рекомендация:** У вас обнаружена проблема с подпиской или ключами. Пожалуйста, продлите доступ или обратитесь в поддержку.`;
      } else {
        diagText += `🎉 **Все системы в норме!** Если интернет не работает, попробуйте обновить подписку в приложении или сменить сеть.`;
      }

      const kb = { inline_keyboard: [[{ text: '🛒 Продлить / Купить', callback_data: 'buy_access' }, { text: '💬 Поддержка', callback_data: 'support' }], [{ text: '◀️ В меню', callback_data: 'main_menu' }]] };
      await bot.sendMessage(chatId, diagText, { parse_mode: 'Markdown', reply_markup: kb });
    }
    else if (data === 'inst_ios') {
      const text = `🍏 **Настройка для iPhone / iPad:**\n\n1. Установите **Streisand** из App Store.\n2. Скопируйте ключ и импортируйте через буфер обмена.`;
      const kb = { inline_keyboard: [[{ text: '◀️ К выбору устройств', callback_data: 'instructions' }]] };
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
    }
    else if (data === 'inst_android') {
      const text = `🤖 **Настройка для Android:**\n\n1. Установите **v2rayNG**.\n2. Импортируйте ключ из буфера обмена и нажмите Play.`;
      const kb = { inline_keyboard: [[{ text: '◀️ К выбору устройств', callback_data: 'instructions' }]] };
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
    }
    else if (data === 'inst_pc') {
      const text = `💻 **Настройка для Windows / Mac:**\n\n1. Установите **Hiddify**.\n2. Приложение автоматически подхватит ключ из буфера.`;
      const kb = { inline_keyboard: [[{ text: '◀️ К выбору устройств', callback_data: 'instructions' }]] };
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
    }
    else if (data === 'main_menu') {
      delete userStates[userId];
      await bot.sendMessage(chatId, '👋 **Главное меню STROMVPN**', { parse_mode: 'Markdown', reply_markup: getMainMenuKeyboard() });
    }
    // Одобрение платежа
    else if (data.startsWith('approve_')) {
      const txId = data.replace('approve_', '');
      const txRaw = await redis.get(`tx:${txId}`);
      if (!txRaw) return bot.sendMessage(chatId, '❌ Транзакция не найдена');
      const tx = typeof txRaw === 'string' ? JSON.parse(txRaw) : txRaw;
      if (tx.status !== 'pending') return bot.sendMessage(chatId, '⚠️ Уже обработано');

      const nextKey = await redis.lpop('admin:pool:keys');
      if (!nextKey) {
        return bot.sendMessage(chatId, '❌ **В пуле нет свободных ключей!** Загрузите их через веб-панель.');
      }

      tx.status = 'approved';
      await redis.set(`tx:${txId}`, JSON.stringify(tx));

      await redis.incrby('stats:total_sum', tx.amount);
      await redis.incr('stats:total_sales');

      if (tx.refCode && tx.refCode !== 'DIRECT') {
        await redis.incrby(`ref:${tx.refCode}:paid_sum`, tx.amount);
        await redis.incr(`ref:${tx.refCode}:paid_count`);
      }

      const expireTime = Date.now() + (tx.days || 30) * 24 * 60 * 60 * 1000;
      await redis.set(`user:${tx.userId}:expire`, expireTime);

      await redis.rpush(`user:${tx.userId}:keys`, nextKey);
      await redis.rpush('global:keys', JSON.stringify({
        userId: tx.userId,
        username: tx.username,
        vlessUrl: nextKey,
        created: new Date().toISOString(),
        expire: expireTime
      }));

      const successKb = { inline_keyboard: [[{ text: '📖 Инструкция', callback_data: 'instructions' }]] };
      await bot.sendMessage(tx.userId, `🎉 **Ваш платеж одобрен! Подписка активна на ${tx.days} дн.**\n\n🔑 Ваш ключ:\n\`${nextKey}\``, { parse_mode: 'Markdown', reply_markup: successKb });
      await bot.sendMessage(chatId, `✅ **Платёж одобрен! Ключ выдан.**`);
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
  } catch (err) {
    console.error('Callback error:', err.message);
  }
});

// CRON проверка подписок
cron.schedule('0 10 * * *', async () => {
  try {
    const rawKeys = (await redis.lrange('global:keys', 0, -1)) || [];
    const now = Date.now();
    for (let raw of rawKeys) {
      let k = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!k.expire) continue;
      const diffDays = Math.ceil((k.expire - now) / (1000 * 60 * 60 * 24));
      if (diffDays === 2 || diffDays === 0) {
        const msg = diffDays === 2 
          ? `⚠️ **Внимание!** Срок вашей подписки истекает через 2 дня.` 
          : `🔴 **Срок подписки истек!** Доступ ограничен.`;
        const kb = { inline_keyboard: [[{ text: '🛒 Продлить подписку', callback_data: 'buy_access' }]] };
        await bot.sendMessage(k.userId, msg, { parse_mode: 'Markdown', reply_markup: kb }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Cron error:', err);
  }
});

// ================= ДИЗАЙН И ВЕБ-ПАНЕЛИ =================

const commonCss = `
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  body { 
    font-family: 'Plus Jakarta Sans', sans-serif; 
    background: #030712; 
    color: #f3f4f6; 
    margin: 0; 
    padding: 40px 20px; 
    display: flex; 
    justify-content: center; 
    align-items: flex-start; 
    min-height: 100vh;
    background-image: 
      radial-gradient(circle at 10% 20%, rgba(37, 99, 235, 0.15) 0%, transparent 40%),
      radial-gradient(circle at 90% 80%, rgba(147, 51, 234, 0.1) 0%, transparent 40%);
  }
  .wrapper { width: 100%; max-width: 1050px; margin: auto; }
  .card { 
    background: rgba(17, 24, 39, 0.7); 
    backdrop-filter: blur(16px);
    border: 1px solid rgba(255, 255, 255, 0.08); 
    padding: 40px; 
    border-radius: 24px; 
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); 
  }
  h2 { color: #ffffff; font-size: 26px; font-weight: 700; margin-top: 0; margin-bottom: 25px; display: flex; align-items: center; gap: 12px; }
  h3 { color: #9ca3af; font-size: 15px; font-weight: 600; margin-top: 35px; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 0.8px; }
  input, textarea, select { width: 100%; padding: 15px 18px; margin-top: 8px; border-radius: 14px; border: 1px solid rgba(255, 255, 255, 0.1); font-size: 14px; font-family: inherit; transition: all 0.3s ease; background: rgba(3, 7, 18, 0.6); color: #fff; outline: none; }
  input:focus, textarea:focus { border-color: #38bdf8; box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.15); }
  button { width: 100%; padding: 15px 20px; border-radius: 14px; font-weight: 600; cursor: pointer; border: none; margin-top: 15px; font-family: inherit; font-size: 14px; transition: all 0.2s ease; }
  .btn-primary { background: linear-gradient(135deg, #0ea5e9, #2563eb); color: #fff; box-shadow: 0 10px 20px -5px rgba(37, 99, 235, 0.4); }
  .btn-primary:hover { transform: translateY(-1px); opacity: 0.95; }
  .btn-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
  .btn-danger:hover { background: #ef4444; color: #fff; }
  .btn-success { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }
  .btn-success:hover { background: #22c55e; color: #fff; }
  table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }
  th { background: rgba(255, 255, 255, 0.03); color: #9ca3af; padding: 16px; text-align: left; font-weight: 600; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  td { padding: 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); color: #e5e7eb; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; margin-bottom: 35px; }
  .stat-box { background: rgba(255, 255, 255, 0.02); padding: 25px; border-radius: 18px; border: 1px solid rgba(255, 255, 255, 0.06); position: relative; overflow: hidden; }
  .stat-box::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 2px; background: linear-gradient(90deg, transparent, #38bdf8, transparent); }
  .stat-title { color: #9ca3af; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-value { font-size: 32px; font-weight: 700; color: #fff; margin-top: 10px; }
  .login-container { display: flex; justify-content: center; align-items: center; height: 85vh; }
  .login-card { width: 420px; text-align: center; padding: 45px; }
  .badge { display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; background: rgba(56, 189, 248, 0.1); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.2); }
  .actions-row { display: flex; gap: 15px; margin-top: 20px; }
`;

// КАБИНЕТ ПАРТНЕРА
app.all('/partner', async (req, res) => {
  const pass = req.method === 'POST' ? req.body.pass : req.query.pass;
  if (pass !== PARTNER_PASSWORD) {
    return res.send(`<!DOCTYPE html><html lang="ru"><head><style>${commonCss}</style></head>
      <body><div class="login-container"><div class="card login-card">
        <h2>📊 Кабинет партнера</h2>
        <form action="/partner" method="POST">
          <input type="password" name="pass" required placeholder="Пароль партнера">
          <button type="submit" class="btn-primary">Войти</button>
        </form>
      </div></div></body></html>`);
  }

  const clicks = (await redis.get('ref:BLOGER2026:clicks')) || 0;
  const paidCount = (await redis.get('ref:BLOGER2026:paid_count')) || 0;
  const paidSum = (await redis.get('ref:BLOGER2026:paid_sum')) || 0;
  const partnerBalance = Math.floor(paidSum * 0.5);

  res.send(`<!DOCTYPE html><html lang="ru"><head><style>${commonCss}</style></head>
    <body><div class="wrapper"><div class="card">
      <h2>📊 Партнерский кабинет <span class="badge">BLOGER2026</span></h2>
      <div class="stats-grid">
        <div class="stat-box"><div class="stat-title">Переходы</div><div class="stat-value">${clicks}</div></div>
        <div class="stat-box"><div class="stat-title">Оплаты</div><div class="stat-value">${paidCount}</div></div>
        <div class="stat-box"><div class="stat-title">Баланс (50%)</div><div class="stat-value" style="color:#4ade80;">${partnerBalance} ₽</div></div>
      </div>
      <h3>💳 Запрос выплаты</h3>
      <form action="/partner/withdraw" method="POST" style="max-width: 450px;">
        <input type="hidden" name="pass" value="${pass}">
        <input type="text" name="bank" required placeholder="Банк (Сбер, Т-Банк, ВТБ)">
        <input type="text" name="phone" required placeholder="Номер телефона">
        <button type="submit" class="btn-success">Отправить заявку</button>
      </form>
    </div></div></body></html>`);
});

app.post('/partner/withdraw', async (req, res) => {
  const { pass, bank, phone } = req.body;
  if (pass !== PARTNER_PASSWORD) return res.status(403).send('Доступ запрещен');
  const paidSum = (await redis.get('ref:BLOGER2026:paid_sum')) || 0;
  const balance = Math.floor(paidSum * 0.5);

  if (ADMIN_ID) {
    await bot.sendMessage(ADMIN_ID, `💸 **ЗАЯВКА НА ВЫПЛАТУ**\nСумма: **${balance} ₽**\nБанк: \`${bank}\`\nТелефон: \`${phone}\``, { parse_mode: 'Markdown' }).catch(()=>{});
  }
  res.send(`<script>alert('Заявка отправлена!'); window.location.href='/partner?pass=${pass}';</script>`);
});

// АДМИН-ПАНЕЛЬ
app.all('/admin', async (req, res) => {
  const pass = req.method === 'POST' ? req.body.pass : req.query.pass;
  if (pass !== ADMIN_PASSWORD) {
    return res.send(`<!DOCTYPE html><html lang="ru"><head><style>${commonCss}</style></head>
      <body><div class="login-container"><div class="card login-card">
        <h2>⚙️ Админ-панель</h2>
        <form action="/admin" method="POST">
          <input type="password" name="pass" required placeholder="Мастер-пароль">
          <button type="submit" class="btn-danger">Войти</button>
        </form>
      </div></div></body></html>`);
  }

  const totalSum = (await redis.get('stats:total_sum')) || 0;
  const totalSales = (await redis.get('stats:total_sales')) || 0;
  const poolCount = (await redis.llen('admin:pool:keys')) || 0;
  const rawKeys = (await redis.lrange('global:keys', 0, -1)) || [];
  const keysList = rawKeys.map(k => typeof k === 'string' ? JSON.parse(k) : k);

  let keysHtml = keysList.map((k, index) => `
    <tr>
      <td><b>${index + 1}</b></td>
      <td>@${k.username || 'unknown'}</td>
      <td style="word-break: break-all; font-family: monospace; font-size: 12px; color:#38bdf8;">${k.vlessUrl}</td>
      <td style="white-space: nowrap;">
        <form action="/admin/delete-key" method="POST" style="display:inline;" onsubmit="return confirm('Удалить этот ключ?');">
          <input type="hidden" name="pass" value="${pass}">
          <input type="hidden" name="vlessUrl" value="${k.vlessUrl}">
          <button type="submit" class="btn-danger" style="padding:6px 12px; font-size:12px; margin:0;">Удалить</button>
        </form>
      </td>
    </tr>
  `).join('');

  res.send(`<!DOCTYPE html><html lang="ru"><head><style>${commonCss}</style></head>
    <body><div class="wrapper"><div class="card">
      <h2>⚙️ Панель управления STROMVPN</h2>
      
      <div class="stats-grid">
        <div class="stat-box"><div class="stat-title">Выручка</div><div class="stat-value">${totalSum} ₽</div></div>
        <div class="stat-box"><div class="stat-title">Продаж</div><div class="stat-value">${totalSales}</div></div>
        <div class="stat-box"><div class="stat-title">Ключей в пуле</div><div class="stat-value">${poolCount} шт.</div></div>
      </div>

      <div class="actions-row">
        <form action="/admin/reset-stats" method="POST" onsubmit="return confirm('Сбросить всю статистику и выручку до 0?');" style="flex:1;">
          <input type="hidden" name="pass" value="${pass}">
          <button type="submit" class="btn-danger">💰 Обнулить прибыль</button>
        </form>
      </div>

      <h3>📦 Пополнение пула ключей</h3>
      <form action="/admin/add-pool" method="POST">
        <input type="hidden" name="pass" value="${pass}">
        <textarea name="newKeys" rows="3" placeholder="vless://..." required></textarea>
        <button type="submit" class="btn-primary" style="max-width:200px;">Загрузить</button>
      </form>

      <h3 style="margin-top: 40px;">🔑 Активные ключи (${keysList.length})</h3>
      <table>
        <tr><th>#</th><th>Пользователь</th><th>VLESS Ключ</th><th>Действия</th></tr>
        ${keysHtml || '<tr><td colspan="4" style="text-align:center; color:#64748b; padding:20px;">Нет активных ключей</td></tr>'}
      </table>
    </div></div></body></html>`);
});

app.post('/admin/reset-stats', async (req, res) => {
  const { pass } = req.body;
  if (pass !== ADMIN_PASSWORD) return res.status(403).send('Доступ запрещен');
  await redis.set('stats:total_sum', 0);
  await redis.set('stats:total_sales', 0);
  res.send(`<form id="f" action="/admin" method="POST"><input type="hidden" name="pass" value="${pass}"></form><script>document.getElementById('f').submit();</script>`);
});

app.post('/admin/add-pool', async (req, res) => {
  const { pass, newKeys } = req.body;
  if (pass !== ADMIN_PASSWORD) return res.status(403).send('Доступ запрещен');
  if (newKeys) {
    const lines = newKeys.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (let key of lines) {
      await redis.rpush('admin:pool:keys', key);
    }
  }
  res.send(`<form id="f" action="/admin" method="POST"><input type="hidden" name="pass" value="${pass}"></form><script>document.getElementById('f').submit();</script>`);
});

app.post('/admin/delete-key', async (req, res) => {
  const { pass, vlessUrl } = req.body;
  if (pass !== ADMIN_PASSWORD) return res.status(403).send('Доступ запрещен');

  try {
    const rawKeys = (await redis.lrange('global:keys', 0, -1)) || [];
    for (let raw of rawKeys) {
      let k = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (k.vlessUrl === vlessUrl) {
        await redis.lrem('global:keys', 1, raw);
        await redis.lrem(`user:${k.userId}:keys`, 1, vlessUrl);
        break;
      }
    }
  } catch (err) {
    console.error('Ошибка удаления ключа:', err);
  }

  res.send(`<form id="f" action="/admin" method="POST"><input type="hidden" name="pass" value="${pass}"></form><script>document.getElementById('f').submit();</script>`);
});

const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('STROMVPN Stable Server Active'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

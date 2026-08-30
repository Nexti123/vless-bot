const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');
const { v4: uuidv4 } = require('uuid');

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

// Telegram /start (без плашек админки и партнера)
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
        [{ text: '💬 Техподдержка', callback_data: 'support' }]
      ]
    };

    await bot.sendMessage(chatId, welcomeText, { parse_mode: 'Markdown', reply_markup: keyboard });
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
      await bot.sendMessage(chatId, '✅ **Промокод BLOGER2026 успешно применён!**');
    } else {
      await bot.sendMessage(chatId, '❌ **Неверный промокод.**');
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
            { text: '✅ Одобрить и выдать ключ', callback_data: `approve_${txId}` },
            { text: '❌ Отклонить', callback_data: `reject_${txId}` }
          ]]
        };
        await bot.sendMessage(ADMIN_ID, adminMsg, { parse_mode: 'Markdown', reply_markup: adminKeyboard }).catch(() => {});
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
          [{ text: '💬 Техподдержка', callback_data: 'support' }]
        ]
      };
      await bot.sendMessage(chatId, '👋 **Главное меню STROMVPN**', { parse_mode: 'Markdown', reply_markup: keyboard });
    }
    else if (data.startsWith('approve_')) {
      const txId = data.replace('approve_', '');
      const txRaw = await redis.get(`tx:${txId}`);
      if (!txRaw) return bot.sendMessage(chatId, '❌ Транзакция не найдена');
      const tx = typeof txRaw === 'string' ? JSON.parse(txRaw) : txRaw;
      if (tx.status !== 'pending') return bot.sendMessage(chatId, '⚠️ Уже обработано');

      const nextKey = await redis.lpop('admin:pool:keys');
      if (!nextKey) {
        return bot.sendMessage(chatId, '❌ **В пуле нет свободных ключей!** Сначала добавь их в админ-панели.');
      }

      tx.status = 'approved';
      await redis.set(`tx:${txId}`, JSON.stringify(tx));

      await redis.incrby('stats:total_sum', 250);
      await redis.incr('stats:total_sales');

      if (tx.refCode && tx.refCode !== 'DIRECT') {
        await redis.incrby(`ref:${tx.refCode}:paid_sum`, 250);
        await redis.incr(`ref:${tx.refCode}:paid_count`);
      }

      await redis.rpush(`user:${tx.userId}:keys`, nextKey);
      await redis.rpush('global:keys', JSON.stringify({
        userId: tx.userId,
        username: tx.username,
        vlessUrl: nextKey,
        created: new Date().toISOString()
      }));

      await bot.sendMessage(tx.userId, `🎉 **Ваш платеж одобрен!**\n\n🔑 Ваш новый VLESS-ключ:\n\`${nextKey}\``, { parse_mode: 'Markdown' });
      await bot.sendMessage(chatId, `✅ **Платёж одобрен! Ключ автоматически выдан пользователю из пула.**`);
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

// ================= ПРЕМИУМ ДИЗАЙН И ВЕБ-ПАНЕЛИ =================

const commonCss = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  body { font-family: 'Inter', sans-serif; background: #07090e; color: #e2e8f0; margin: 0; padding: 30px 20px; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; }
  .wrapper { width: 100%; max-width: 1000px; margin: auto; }
  .card { background: #111827; border: 1px solid #1f293d; padding: 35px; border-radius: 20px; box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.7); }
  h2 { color: #f8fafc; font-size: 24px; font-weight: 700; margin-top: 0; margin-bottom: 25px; display: flex; align-items: center; gap: 10px; }
  h3 { color: #94a3b8; font-size: 16px; font-weight: 600; margin-top: 30px; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 0.5px; }
  input, textarea, button { width: 100%; padding: 14px 18px; margin-top: 8px; border-radius: 12px; border: 1px solid #334155; font-size: 14px; font-family: inherit; transition: all 0.2s ease; }
  input, textarea { background: #0b0f19; color: #fff; outline: none; }
  input:focus, textarea:focus { border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15); }
  button { font-weight: 600; cursor: pointer; border: none; margin-top: 15px; }
  .btn-primary { background: linear-gradient(135deg, #0284c7, #2563eb); color: #fff; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3); }
  .btn-primary:hover { opacity: 0.9; }
  .btn-danger { background: #ef4444; color: #fff; }
  .btn-success { background: #22c55e; color: #fff; }
  table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }
  th { background: #1f293d; color: #94a3b8; padding: 14px; text-align: left; font-weight: 600; }
  td { padding: 14px; border-bottom: 1px solid #1f293d; color: #cbd5e1; }
  tr:hover td { background: rgba(255, 255, 255, 0.01); }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 35px; }
  .stat-box { background: linear-gradient(135deg, #182235, #111827); padding: 25px; border-radius: 16px; border: 1px solid #26334d; position: relative; overflow: hidden; }
  .stat-box::after { content: ''; position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: #38bdf8; }
  .stat-box.green::after { background: #22c55e; }
  .stat-box.purple::after { background: #a855f7; }
  .stat-title { color: #94a3b8; font-size: 13px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-value { font-size: 28px; font-weight: 700; color: #fff; margin-top: 8px; }
  .login-container { display: flex; justify-content: center; align-items: center; height: 85vh; }
  .login-card { width: 400px; text-align: center; padding: 40px; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; background: rgba(56, 189, 248, 0.1); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.2); }
`;

// КАБИНЕТ ПАРТНЕРА
app.all('/partner', async (req, res) => {
  const pass = req.method === 'POST' ? req.body.pass : req.query.pass;
  if (pass !== PARTNER_PASSWORD) {
    return res.send(`<!DOCTYPE html><html lang="ru"><head><style>${commonCss}</style></head>
      <body><div class="login-container"><div class="card login-card">
        <h2>📊 Кабинет партнера</h2>
        <p style="color:#94a3b8; font-size:14px; margin-bottom:25px;">Введите ваш партнерский пароль для доступа к статистике</p>
        <form action="/partner" method="POST">
          <input type="password" name="pass" required placeholder="Пароль партнера">
          <button type="submit" class="btn-primary">Войти в кабинет</button>
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
        <div class="stat-box"><div class="stat-title">Всего переходов</div><div class="stat-value">${clicks}</div></div>
        <div class="stat-box green"><div class="stat-title">Оплаченных подписок</div><div class="stat-value">${paidCount}</div></div>
        <div class="stat-box purple"><div class="stat-title">Ваш баланс (50%)</div><div class="stat-value" style="color:#4ade80;">${partnerBalance} ₽</div></div>
      </div>
      <h3>💳 Запрос выплаты заработанных средств</h3>
      <form action="/partner/withdraw" method="POST" style="max-width: 450px;">
        <input type="hidden" name="pass" value="${pass}">
        <input type="text" name="bank" required placeholder="Банк (Сбер, Т-Банк, ВТБ)">
        <input type="text" name="phone" required placeholder="Номер телефона для перевода">
        <button type="submit" class="btn-success">Отправить заявку на выплату</button>
      </form>
    </div></div></body></html>`);
});

app.post('/partner/withdraw', async (req, res) => {
  const { pass, bank, phone } = req.body;
  if (pass !== PARTNER_PASSWORD) return res.status(403).send('Доступ запрещен');
  const paidSum = (await redis.get('ref:BLOGER2026:paid_sum')) || 0;
  const balance = Math.floor(paidSum * 0.5);

  if (ADMIN_ID) {
    await bot.sendMessage(ADMIN_ID, `💸 **ЗАЯВКА НА ВЫПЛАТУ ОТ ПАРТНЕРА**\nСумма: **${balance} ₽**\nБанк: \`${bank}\`\nТелефон: \`${phone}\``, { parse_mode: 'Markdown' }).catch(()=>{});
  }
  res.send(`<script>alert('Заявка на выплату успешно отправлена администратору!'); window.location.href='/partner?pass=${pass}';</script>`);
});

// АДМИН-ПАНЕЛЬ
app.all('/admin', async (req, res) => {
  const pass = req.method === 'POST' ? req.body.pass : req.query.pass;
  if (pass !== ADMIN_PASSWORD) {
    return res.send(`<!DOCTYPE html><html lang="ru"><head><style>${commonCss}</style></head>
      <body><div class="login-container"><div class="card login-card">
        <h2>⚙️ Админ-панель</h2>
        <p style="color:#94a3b8; font-size:14px; margin-bottom:25px;">Введите мастер-пароль администратора</p>
        <form action="/admin" method="POST">
          <input type="password" name="pass" required placeholder="Пароль администратора">
          <button type="submit" class="btn-danger">Войти в админку</button>
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
        <form action="/admin/delete-key" method="POST" style="display:inline;" onsubmit="return confirm('Удалить этот ключ из системы?');">
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
        <div class="stat-box green"><div class="stat-title">Общая выручка</div><div class="stat-value">${totalSum} ₽</div></div>
        <div class="stat-box"><div class="stat-title">Всего продаж</div><div class="stat-value">${totalSales}</div></div>
        <div class="stat-box purple"><div class="stat-title">Ключей в пуле автовыдачи</div><div class="stat-value">${poolCount} шт.</div></div>
      </div>

      <h3>📦 Пополнение пула ключей для автовыдачи</h3>
      <p style="color:#94a3b8; font-size:13px; margin-top:0;">Вставь новые ключи (каждый с новой строки). При покупке бот автоматически заберет верхний ключ и отдаст покупателю.</p>
      <form action="/admin/add-pool" method="POST">
        <input type="hidden" name="pass" value="${pass}">
        <textarea name="newKeys" rows="4" placeholder="vless://...&#10;vless://..." required></textarea>
        <button type="submit" class="btn-primary" style="max-width:220px;">Загрузить в пул</button>
      </form>

      <h3 style="margin-top: 40px;">🔑 Активные выданные ключи (${keysList.length})</h3>
      <table>
        <tr><th>#</th><th>Пользователь</th><th>VLESS Ключ</th><th>Действия</th></tr>
        ${keysHtml || '<tr><td colspan="4" style="text-align:center; color:#64748b; padding:20px;">Активных ключей пока нет</td></tr>'}
      </table>
    </div></div></body></html>`);
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

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');
const { v4: uuidv4 } = require('uuid');
const { Client } = require('ssh2');

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

// Надежная функция добавления клиента с поиском правильного пути к БД и полным набором полей
function addClientViaSSH(clientUuid, clientEmail) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    
    conn.on('ready', () => {
      const pythonScript = `
import sqlite3, json, sys, os

db_paths = ['/etc/x-ui/x-ui.db', '/usr/local/x-ui/x-ui.db']
db_path = None

for path in db_paths:
    if os.path.exists(path):
        db_path = path
        break

if not db_path:
    print("ERROR: x-ui.db not found in standard directories")
    sys.exit(1)

try:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute('SELECT id, settings FROM inbounds LIMIT 1')
    row = cursor.fetchone()
    
    if not row:
        print("ERROR: No inbounds found in database")
        sys.exit(1)
        
    inbound_id = row[0]
    s = json.loads(row[1])
    
    if 'clients' not in s:
        s['clients'] = []

    # Проверка на существование uuid
    existing_ids = [c.get('id') for c in s.get('clients', [])]
    if '${clientUuid}' in existing_ids:
        print("DB_SUCCESS")
        sys.exit(0)

    # Полная структура клиента для 100% совместимости с ядром Xray
    s['clients'].append({
        'id': '${clientUuid}',
        'flow': '',
        'email': '${clientEmail}',
        'limitIp': 0,
        'totalGB': 0,
        'expiryTime': 0,
        'enable': True,
        'tgId': '',
        'subId': '${clientUuid}'
    })
    
    cursor.execute('UPDATE inbounds SET settings = ? WHERE id = ?', (json.dumps(s), inbound_id))
    conn.commit()
    conn.close()
    print('DB_SUCCESS')
except Exception as e:
    print(f"ERROR: {str(e)}")
    sys.exit(1)
`;

      const encodedScript = Buffer.from(pythonScript).toString('base64');
      const sqlCommand = `python3 -c "import base64; exec(base64.b64decode('${encodedScript}').decode('utf-8'))" && x-ui restart xray`;

      conn.exec(sqlCommand, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        let output = '';
        let errorOutput = '';

        stream.on('close', (code) => {
          conn.end();
          console.log(`SSH Logs: Exit ${code}, Output: ${output.trim()}`);
          if (code === 0 && output.includes('DB_SUCCESS')) {
            resolve(true);
          } else {
            reject(new Error(`SSH/DB Error (code ${code}): ${errorOutput || output}`));
          }
        }).on('data', (data) => {
          output += data.toString();
        }).stderr.on('data', (data) => {
          errorOutput += data.toString();
          console.error('SSH STDERR: ' + data);
        });
      });
    }).on('error', (err) => {
      reject(err);
    }).connect({
      host: '213.176.95.147',
      port: 22,
      username: 'root',
      password: 'TempPass4321#'
    });
  });
}

// Функция удаления ключа с сервера через SSH (SQLite + рестарт)
function removeClientViaSSH(clientUuid) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    
    conn.on('ready', () => {
      const pythonScript = `
import sqlite3, json, sys, os

db_paths = ['/etc/x-ui/x-ui.db', '/usr/local/x-ui/x-ui.db']
db_path = None

for path in db_paths:
    if os.path.exists(path):
        db_path = path
        break

if not db_path:
    print("ERROR: x-ui.db not found")
    sys.exit(1)

try:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute('SELECT id, settings FROM inbounds')
    rows = cursor.fetchall()
    
    for row in rows:
        inbound_id = row[0]
        s = json.loads(row[1])
        if 'clients' in s:
            original_len = len(s['clients'])
            s['clients'] = [c for c in s['clients'] if c.get('id') != '${clientUuid}']
            if len(s['clients']) < original_len:
                cursor.execute('UPDATE inbounds SET settings = ? WHERE id = ?', (json.dumps(s), inbound_id))
                conn.commit()
                
    conn.close()
    print('DB_SUCCESS')
except Exception as e:
    print(f"ERROR: {str(e)}")
    sys.exit(1)
`;

      const encodedScript = Buffer.from(pythonScript).toString('base64');
      const sqlCommand = `python3 -c "import base64; exec(base64.b64decode('${encodedScript}').decode('utf-8'))" && x-ui restart xray`;

      conn.exec(sqlCommand, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        let output = '';
        stream.on('close', (code) => {
          conn.end();
          if (code === 0 && output.includes('DB_SUCCESS')) {
            resolve(true);
          } else {
            reject(new Error(`SSH Delete Error (code ${code}): ${output}`));
          }
        }).on('data', (data) => {
          output += data.toString();
        });
      });
    }).on('error', (err) => {
      reject(err);
    }).connect({
      host: '213.176.95.147',
      port: 22,
      username: 'root',
      password: 'TempPass4321#'
    });
  });
}

// Генерация ссылки клиента
function generateVlessUrl(clientUuid, username) {
  const serverIp = '213.176.95.147';
  const clientPort = process.env.CLIENT_PORT || '80'; 
  const pathEncoded = encodeURIComponent(process.env.VLESS_PATH || '/myconnection');
  const host = process.env.VLESS_HOST || 'time.com';
  
  return `vless://${clientUuid}@${serverIp}:${clientPort}?type=ws&security=none&path=${pathEncoded}&host=${host}#STROMVPN-${username}`;
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
        [{ text: '📊 Кабинет партнера (Сайт)', callback_data: 'web_partner_info' }],
        [{ text: '⚙️ Админ-панель (Сайт)', callback_data: 'web_admin_info' }]
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

// Кнопки бота
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

    else if (data === 'web_partner_info') {
      await bot.sendMessage(chatId, `📊 **Кабинет партнера доступен на сайте!**\n\nПерейдите по ссылке:\n\`https://vless-bot-mzmy.onrender.com/partner?pass=${PARTNER_PASSWORD}\``, { parse_mode: 'Markdown' });
    }

    else if (data === 'web_admin_info') {
      await bot.sendMessage(chatId, `⚙️ **Админ-панель доступна на сайте!**\n\nПерейдите в панель управления ключами и выплатами по ссылке:\n\`https://vless-bot-mzmy.onrender.com/admin?pass=${ADMIN_PASSWORD}\``, { parse_mode: 'Markdown' });
    }

    else if (data === 'main_menu') {
      delete userStates[userId];
      const keyboard = {
        inline_keyboard: [
          [{ text: '🛒 Купить доступ (250 ₽)', callback_data: 'buy_access' }],
          [{ text: '🎟 Ввести промокод', callback_data: 'enter_promo' }],
          [{ text: '🔑 Мои ключи', callback_data: 'my_keys' }],
          [{ text: '💬 Техподдержка', callback_data: 'support' }],
          [{ text: '📊 Кабинет партнера (Сайт)', callback_data: 'web_partner_info' }],
          [{ text: '⚙️ Админ-панель (Сайт)', callback_data: 'web_admin_info' }]
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

      tx.status = 'approved';
      await redis.set(`tx:${txId}`, JSON.stringify(tx));

      await redis.incrby('stats:total_sum', 250);
      await redis.incr('stats:total_sales');

      if (tx.refCode && tx.refCode !== 'DIRECT') {
        await redis.incrby(`ref:${tx.refCode}:paid_sum`, 250);
        await redis.incr(`ref:${tx.refCode}:paid_count`);
      }

      const clientUuid = uuidv4();
      const clientEmail = `user_${tx.userId}_${Date.now().toString().slice(-4)}`;
      const vlessUrl = generateVlessUrl(clientUuid, tx.username);

      try {
        await addClientViaSSH(clientUuid, clientEmail);

        await redis.rpush(`user:${tx.userId}:keys`, vlessUrl);
        await redis.rpush('global:keys', JSON.stringify({
          userId: tx.userId,
          username: tx.username,
          uuid: clientUuid,
          vlessUrl,
          created: new Date().toISOString()
        }));

        await bot.sendMessage(tx.userId, `🎉 **Ваш платеж одобрен!**\n\n🔑 Ваш новый VLESS-ключ:\n\`${vlessUrl}\``, { parse_mode: 'Markdown' });
        await bot.sendMessage(chatId, `✅ **Платёж одобрен, ключ активирован в x-ui без разрыва связи!**`, { parse_mode: 'Markdown' });
      } catch (sshErr) {
        console.error('SSH Error:', sshErr);
        await bot.sendMessage(chatId, `❌ **Ошибка SSH при добавлении в панель:**\n${sshErr.message}`);
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
  } catch (err) {
    console.error('Callback error:', err.message);
  }
});

// ================= WEB ПАНЕЛИ (САЙТ) =================

app.get('/partner', async (req, res) => {
  const pass = req.query.pass;
  if (pass !== PARTNER_PASSWORD) {
    return res.status(403).send('<h1>❌ Ошибка доступа: неверный пароль партнера</h1>');
  }

  const clicks = (await redis.get('ref:BLOGER2026:clicks')) || 0;
  const paidCount = (await redis.get('ref:BLOGER2026:paid_count')) || 0;
  const paidSum = (await redis.get('ref:BLOGER2026:paid_sum')) || 0;
  const partnerBalance = Math.floor(paidSum * 0.5);

  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <title>Кабинет партнера - STROMVPN</title>
      <style>
        body { font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; }
        .card { background: #1e293b; padding: 30px; border-radius: 12px; max-width: 500px; margin: auto; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
        h2 { color: #38bdf8; margin-top: 0; }
        .stat { font-size: 18px; margin: 15px 0; }
        input, button { width: 100%; padding: 12px; margin-top: 10px; border-radius: 6px; border: none; box-sizing: border-box; }
        input { background: #334155; color: #fff; }
        button { background: #22c55e; color: #fff; font-weight: bold; cursor: pointer; font-size: 16px; }
        button:hover { background: #16a34a; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>📊 Кабинет партнера (BLOGER2026)</h2>
        <div class="stat">🖱 Всего кликов по ссылке: <b>${clicks}</b></div>
        <div class="stat">💳 Оплачено подписок: <b>${paidCount}</b></div>
        <div class="stat">💰 Заработано (50%): <b style="color: #4ade80;">${partnerBalance} ₽</b></div>
        
        <hr style="border: 0; border-top: 1px solid #334155; margin: 20px 0;">
        
        <h3>💳 Запросить выплату</h3>
        <form action="/partner/withdraw" method="POST">
          <input type="hidden" name="pass" value="${PARTNER_PASSWORD}">
          <label>Банк (например, Сбер, Т-Банк):</label>
          <input type="text" name="bank" required placeholder="Сбербанк">
          <label>Номер телефона для перевода:</label>
          <input type="text" name="phone" required placeholder="+7 999 000-00-00">
          <button type="submit">Отправить заявку на выплату</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/partner/withdraw', async (req, res) => {
  const { pass, bank, phone } = req.body;
  if (pass !== PARTNER_PASSWORD) return res.status(403).send('Доступ запрещен');

  const paidSum = (await redis.get('ref:BLOGER2026:paid_sum')) || 0;
  const partnerBalance = Math.floor(paidSum * 0.5);

  if (ADMIN_ID) {
    const withdrawMsg = `💸 **ЗАЯВКА НА ВЫПЛАТУ ОТ ПАРТНЕРА**\n\n🎟 Промокод: \`BLOGER2026\`\n💰 Сумма к выплате: **${partnerBalance} ₽**\n🏦 Банк: \`${bank}\`\n📱 Телефон: \`${phone}\``;
    await bot.sendMessage(ADMIN_ID, withdrawMsg, { parse_mode: 'Markdown' }).catch(() => {});
  }

  res.send(`
    <body style="background:#0f172a;color:#fff;font-family:Arial;text-align:center;padding-top:50px;">
      <div style="background:#1e293b;padding:30px;max-width:400px;margin:auto;border-radius:12px;">
        <h2 style="color:#4ade80;">✅ Заявка отправлена!</h2>
        <p>Администратор получил уведомление с вашими реквизитами (${bank}, ${phone}). Ожидайте перевод.</p>
        <a href="/partner?pass=${PARTNER_PASSWORD}" style="color:#38bdf8;text-decoration:none;">Назад в кабинет</a>
      </div>
    </body>
  `);
});

app.get('/admin', async (req, res) => {
  const pass = req.query.pass;
  if (pass !== ADMIN_PASSWORD) {
    return res.status(403).send('<h1>❌ Ошибка доступа: неверный пароль администратора</h1>');
  }

  const totalSum = (await redis.get('stats:total_sum')) || 0;
  const totalSales = (await redis.get('stats:total_sales')) || 0;
  const rawKeys = (await redis.lrange('global:keys', 0, -1)) || [];
  const keysList = rawKeys.map(k => typeof k === 'string' ? JSON.parse(k) : k);

  let keysHtml = keysList.map((k, index) => `
    <tr style="border-bottom: 1px solid #334155;">
      <td style="padding: 10px;">${index + 1}</td>
      <td style="padding: 10px;">@${k.username} (ID: ${k.userId})</td>
      <td style="padding: 10px; word-break: break-all; font-family: monospace; font-size: 12px;">${k.vlessUrl}</td>
      <td style="padding: 10px;">
        <form action="/admin/delete-key" method="POST" style="display:inline;">
          <input type="hidden" name="pass" value="${ADMIN_PASSWORD}">
          <input type="hidden" name="uuid" value="${k.uuid}">
          <input type="hidden" name="userId" value="${k.userId}">
          <input type="hidden" name="vlessUrl" value="${k.vlessUrl}">
          <button type="submit" style="background:#ef4444;color:#fff;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;">Удалить</button>
        </form>
      </td>
    </tr>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <title>Админ-панель - STROMVPN</title>
      <style>
        body { font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 30px; }
        .container { max-width: 1000px; margin: auto; background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
        h2, h3 { color: #38bdf8; }
        .stats-box { display: flex; gap: 20px; margin-bottom: 30px; }
        .stat-card { background: #334155; padding: 20px; border-radius: 8px; flex: 1; text-align: center; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th { background: #334155; padding: 10px; text-align: left; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>⚙️ Админ-панель STROMVPN</h2>
        <div class="stats-box">
          <div class="stat-card">
            <h3>Общая выручка</h3>
            <p style="font-size: 24px; color: #4ade80; margin:0;">${totalSum} ₽</p>
          </div>
          <div class="stat-card">
            <h3>Всего продаж</h3>
            <p style="font-size: 24px; color: #38bdf8; margin:0;">${totalSales}</p>
          </div>
        </div>

        <h3>🔑 Управление активными ключами пользователей</h3>
        <table>
          <tr>
            <th>#</th>
            <th>Пользователь</th>
            <th>VLESS Ключ</th>
            <th>Действие</th>
          </tr>
          ${keysHtml || '<tr><td colspan="4" style="padding:15px; text-align:center;">Нет активных ключей</td></tr>'}
        </table>
      </div>
    </body>
    </html>
  `);
});

app.post('/admin/delete-key', async (req, res) => {
  const { pass, uuid, userId, vlessUrl } = req.body;
  if (pass !== ADMIN_PASSWORD) return res.status(403).send('Доступ запрещен');

  try {
    // 1. Удаляем из x-ui.db через SSH
    await removeClientViaSSH(uuid);

    // 2. Удаляем из глобального списка ключей в Redis
    const rawKeys = (await redis.lrange('global:keys', 0, -1)) || [];
    for (let raw of rawKeys) {
      let k = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (k.uuid === uuid) {
        await redis.lrem('global:keys', 1, raw);
        break;
      }
    }

    // 3. Удаляем ключ из списка конкретного пользователя в Redis
    if (userId && vlessUrl) {
      await redis.lrem(`user:${userId}:keys`, 1, vlessUrl);
    }
  } catch (err) {
    console.error('Ошибка при удалении ключа через админку:', err);
  }

  res.redirect(`/admin?pass=${ADMIN_PASSWORD}`);
});

const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('STROMVPN Active Server'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

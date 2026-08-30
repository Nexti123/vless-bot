
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const { Client } = require('node-ssh');

// ================= CONFIGURATION =================
const TOKEN = process.env.TELEGRAM_TOKEN || 'YOUR_BOT_TOKEN';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // Пароль для входа в веб-админку

// SSH настройки для управления Xray на сервере
const SSH_CONFIG = {
    host: process.env.SSH_HOST || 'YOUR_SERVER_IP',
    port: Number(process.env.SSH_PORT) || 22,
    username: process.env.SSH_USER || 'root',
    password: process.env.SSH_PASSWORD || 'YOUR_SSH_PASSWORD',
};

const PORT = process.env.PORT || 3000;

// Инициализация бота и экспресса
const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

// База данных в JSON
const DB_FILE = './database.json';
let db = {
    users: {},
    keys: {}
};

function loadDb() {
    if (fs.existsSync(DB_FILE)) {
        try {
            db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (e) {
            console.error('Error loading DB:', e);
        }
    }
}
function saveDb() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
loadDb();

// ================= SSH XRAY FUNCTIONS =================
async function executeSSHCommand(command) {
    const ssh = new Client();
    try {
        await ssh.connect(SSH_CONFIG);
        const result = await ssh.execCommand(command);
        ssh.dispose();
        if (result.stderr && !result.stdout && !result.stderr.includes('Warning')) {
            throw new Error(result.stderr);
        }
        return result.stdout;
    } catch (err) {
        console.error('SSH Error:', err);
        throw err;
    }
}

async function addKeyToXrayServer(uuid, email) {
    const remoteScript = `
    python3 -c "
import json
import os

paths = ['/usr/local/etc/xray/config.json', '/etc/xray/config.json']
path = next((p for p in paths if os.path.exists(p)), None)

if not path:
    raise FileNotFoundError('config.json not found in /usr/local/etc/xray/ or /etc/xray/')

with open(path, 'r') as f:
    data = json.load(f)

for inbound in data.get('inbounds', []):
    if inbound.get('protocol') == 'vless':
        clients = inbound.setdefault('settings', {}).setdefault('clients', [])
        if not any(c.get('id') == '${uuid}' for c in clients):
            clients.append({'id': '${uuid}', 'email': '${email}'})

with open(path, 'w') as f:
    json.dump(data, f, indent=2)
" && systemctl reload xray
    `;
    await executeSSHCommand(remoteScript);
}

async function removeKeyFromXrayServer(email) {
    const remoteScript = `
    python3 -c "
import json
import os

paths = ['/usr/local/etc/xray/config.json', '/etc/xray/config.json']
path = next((p for p in paths if os.path.exists(p)), None)

if not path:
    raise FileNotFoundError('config.json not found')

with open(path, 'r') as f:
    data = json.load(f)

for inbound in data.get('inbounds', []):
    if inbound.get('protocol') == 'vless':
        clients = inbound.setdefault('settings', {}).setdefault('clients', [])
        inbound['settings']['clients'] = [c for c in clients if c.get('email') != '${email}']

with open(path, 'w') as f:
    json.dump(data, f, indent=2)
" && systemctl reload xray
    `;
    await executeSSHCommand(remoteScript);
}

// ================= TELEGRAM BOT LOGIC =================
bot.onText(/\/start(?: (.+))?/, (msg, match) => {
    const chatId = msg.from.id;
    const refParam = match ? match[1] : null;

    if (!db.users[chatId]) {
        db.users[chatId] = {
            balance: 0,
            refEarnings: 0,
            totalEarnings: 0,
            invitedBy: null,
            keys: []
        };
        if (refParam && Number(refParam) !== chatId && db.users[refParam]) {
            db.users[chatId].invitedBy = Number(refParam);
        }
        saveDb();
    }

    bot.sendMessage(chatId, 
        `👋 Добро пожаловать в наш VPN сервис!

` +
        `🚀 Быстрый, безопасный и стабильный доступ в интернет.
` +
        `Используйте меню ниже для управления подписками и кабинетом.`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔑 Мои ключи', callback_data: 'my_keys' }, { text: '💳 Купить подписку', callback_data: 'buy_sub' }],
                    [{ text: '🤝 Партнерский кабинет', callback_data: 'partner_cabinet' }, { text: '⚙️ Помощь', callback_data: 'help' }]
                ]
            }
        }
    );
});

bot.on('callback_query', async (query) => {
    const chatId = query.from.id;
    const data = query.data;

    if (!db.users[chatId]) {
        db.users[chatId] = { balance: 0, refEarnings: 0, totalEarnings: 0, invitedBy: null, keys: [] };
    }

    if (data === 'my_keys') {
        const userKeys = db.users[chatId].keys || [];
        if (userKeys.length === 0) {
            return bot.answerCallbackQuery(query.id, { text: 'У вас пока нет активных ключей.', show_alert: true });
        }
        let text = '🔑 **Ваши активные ключи:**

';
        userKeys.forEach((keyId, index) => {
            const k = db.keys[keyId];
            if (k) {
                text += `${index + 1}. **${k.remark}**
`;
                text += `📅 До: ${k.expiryDate}
`;
                text += `🔗 \`vless://${k.uuid}@${SSH_CONFIG.host}:443?security=reality&sni=google.com&fp=chrome&type=tcp&flow=xtls-rprx-vision#${k.remark}\`

`;
            }
        });
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } else if (data === 'buy_sub') {
        bot.sendMessage(chatId, '🛒 Выберите тариф для покупки:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '1 месяц - 150 руб', callback_data: 'pay_1' }],
                    [{ text: '3 месяца - 400 руб', callback_data: 'pay_3' }],
                    [{ text: '🔙 Назад', callback_data: 'back_main' }]
                ]
            }
        });
    } else if (data === 'partner_cabinet') {
        const user = db.users[chatId];
        const refLink = `https://t.me/${(await bot.getMe()).username}?start=${chatId}`;
        bot.sendMessage(chatId, 
            `🤝 **Партнерский кабинет**

` +
            `🔗 Ваша реферальная ссылка:
\`${refLink}\`

` +
            `💰 Всего заработано: ${user.totalEarnings} руб.
` +
            `💸 Доступно к выводу: ${user.refEarnings} руб.
` +
            `👥 Приглашено друзей: ${Object.values(db.users).filter(u => u.invitedBy === chatId).length}`,
            { parse_mode: 'Markdown' }
        );
    } else if (data.startsWith('pay_')) {
        const months = data === 'pay_1' ? 1 : 3;
        const uuid = require('crypto').randomUUID();
        const email = `user_${chatId}_${Date.now()}@vpn.local`;
        const remark = `VPN_${chatId}_${Date.now().toString().slice(-4)}`;
        const expiryDate = new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        try {
            await addKeyToXrayServer(uuid, email);
            db.keys[uuid] = { uuid, email, remark, expiryDate, telegramId: chatId, status: 'active' };
            db.users[chatId].keys.push(uuid);
            
            const inviterId = db.users[chatId].invitedBy;
            if (inviterId && db.users[inviterId]) {
                const bonus = months === 1 ? 30 : 80;
                db.users[inviterId].refEarnings += bonus;
                db.users[inviterId].totalEarnings += bonus;
                bot.sendMessage(inviterId, `🎉 По вашей реферальной ссылке купили подписку! Вам начислено ${bonus} руб.`);
            }

            saveDb();
            bot.sendMessage(chatId, 
                `✅ **Оплата прошла успешно! Ваш ключ создан:**

` +
                `🏷 Название: ${remark}
` +
                `📅 Действует до: ${expiryDate}

` +
                `🔗 Ссылка подключения:
\`vless://${uuid}@${SSH_CONFIG.host}:443?security=reality&sni=google.com&fp=chrome&type=tcp&flow=xtls-rprx-vision#${remark}\``,
                { parse_mode: 'Markdown' }
            );
        } catch (e) {
            bot.sendMessage(chatId, '❌ Ошибка при создании ключа на сервере. Убедитесь, что config.json существует.');
        }
    }
});

// ================= WEB ADMIN & PARTNER PANEL =================
function checkAuth(req, res, next) {
    if (req.cookies && req.cookies.admin_pass === ADMIN_PASSWORD) {
        return next();
    }
    res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <title>Вход в админ-панель</title>
            <style>
                body { background: #0f172a; color: #f8fafc; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .login-card { background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); width: 300px; text-align: center; }
                input { width: 100%; padding: 12px; margin: 15px 0; background: #0f172a; border: 1px solid #334155; color: white; border-radius: 6px; box-sizing: border-box; }
                button { width: 100%; padding: 12px; background: #3b82f6; border: none; color: white; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; }
                button:hover { background: #2563eb; }
            </style>
        </head>
        <body>
            <div class="login-card">
                <h2>🔐 Вход в панель</h2>
                <form method="POST" action="/login">
                    <input type="password" name="password" placeholder="Пароль администратора" required>
                    <button type="submit">Войти</button>
                </form>
            </div>
        </body>
        </html>
    `);
}

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.cookie('admin_pass', ADMIN_PASSWORD, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true });
        return res.redirect('/admin');
    }
    res.redirect('/admin');
});

app.get('/admin', checkAuth, (req, res) => {
    let totalUsers = Object.keys(db.users).length;
    let totalKeys = Object.keys(db.keys).length;
    let sumTotalEarnings = Object.values(db.users).reduce((acc, u) => acc + (u.totalEarnings || 0), 0);
    let sumRefEarnings = Object.values(db.users).reduce((acc, u) => acc + (u.refEarnings || 0), 0);

    let usersHtml = '';
    for (const [uid, user] of Object.entries(db.users)) {
        usersHtml += `<tr>
            <td>${uid}</td>
            <td>${user.balance} руб.</td>
            <td>${user.refEarnings} руб.</td>
            <td>${user.totalEarnings} руб.</td>
            <td>${(user.keys || []).length}</td>
            <td>
                <form method="POST" action="/admin/user/reset" style="display:inline;">
                    <input type="hidden" name="telegramId" value="${uid}">
                    <button type="submit" class="btn btn-sm btn-warning">Обнулить балансы</button>
                </form>
            </td>
        </tr>`;
    }

    let keysHtml = '';
    for (const [uuid, key] of Object.entries(db.keys)) {
        keysHtml += `<tr>
            <td><code>${uuid.slice(0, 8)}...</code></td>
            <td>${key.remark}</td>
            <td>${key.telegramId}</td>
            <td>${key.expiryDate}</td>
            <td><span class="badge ${key.status === 'active' ? 'badge-success' : 'badge-danger'}">${key.status}</span></td>
            <td>
                <form method="POST" action="/admin/key/renew" style="display:inline; margin-right: 5px;">
                    <input type="hidden" name="uuid" value="${uuid}">
                    <input type="number" name="days" value="30" style="width: 50px; padding: 2px;">
                    <button type="submit" class="btn btn-sm btn-info">+Дни</button>
                </form>
                <form method="POST" action="/admin/key/delete" style="display:inline;" onsubmit="return confirm('Удалить ключ?');">
                    <input type="hidden" name="uuid" value="${uuid}">
                    <button type="submit" class="btn btn-sm btn-danger">Удалить</button>
                </form>
            </td>
        </tr>`;
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <title>VPN Admin & Partner Control Panel</title>
            <style>
                :root { --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --accent: #3b82f6; --danger: #ef4444; --success: #22c55e; --warning: #f59e0b; }
                body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; }
                .container { max-width: 1200px; margin: 0 auto; }
                header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; border-bottom: 1px solid #334155; padding-bottom: 15px; }
                h1 { margin: 0; font-size: 24px; color: #60a5fa; }
                .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 30px; }
                .stat-card { background: var(--card); padding: 20px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); border-left: 4px solid var(--accent); }
                .stat-card h3 { margin: 0 0 10px 0; font-size: 14px; color: #94a3b8; }
                .stat-card .value { font-size: 24px; font-weight: bold; }
                section { background: var(--card); padding: 20px; border-radius: 12px; margin-bottom: 30px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
                h2 { margin-top: 0; font-size: 18px; border-bottom: 1px solid #334155; padding-bottom: 10px; }
                table { width: 100%; border-collapse: collapse; margin-top: 10px; text-align: left; }
                th, td { padding: 12px; border-bottom: 1px solid #334155; font-size: 14px; }
                th { color: #94a3b8; }
                .btn { padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 12px; color: white; transition: 0.2s; }
                .btn-success { background: var(--success); }
                .btn-danger { background: var(--danger); }
                .btn-warning { background: var(--warning); }
                .btn-info { background: var(--accent); }
                .btn:hover { opacity: 0.85; }
                .badge { padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; }
                .badge-success { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
                .badge-danger { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
                code { background: #0f172a; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
                .global-actions { margin-bottom: 20px; display: flex; gap: 10px; }
            </style>
        </head>
        <body>
            <div class="container">
                <header>
                    <h1>⚡ Xray Admin & Partner Panel</h1>
                    <a href="/logout" class="btn btn-danger">Выйти</a>
                </header>

                <div class="stats-grid">
                    <div class="stat-card" style="border-left-color: #3b82f6;">
                        <h3>Всего пользователей</h3>
                        <div class="value">${totalUsers}</div>
                    </div>
                    <div class="stat-card" style="border-left-color: #22c55e;">
                        <h3>Всего ключей</h3>
                        <div class="value">${totalKeys}</div>
                    </div>
                    <div class="stat-card" style="border-left-color: #f59e0b;">
                        <h3>Общий заработок</h3>
                        <div class="value">${sumTotalEarnings} руб.</div>
                    </div>
                    <div class="stat-card" style="border-left-color: #ec4899;">
                        <h3>Реферальный заработок</h3>
                        <div class="value">${sumRefEarnings} руб.</div>
                    </div>
                </div>

                <div class="global-actions">
                    <form method="POST" action="/admin/reset-all-earnings" onsubmit="return confirm('ВНИМАНИЕ: Это обнулит заработок ВСЕХ пользователей (общий и реферальный). Продолжить?');">
                        <button type="submit" class="btn btn-warning">🔄 Обнулить весь заработок системы</button>
                    </form>
                </div>

                <section>
                    <h2>🔑 Полное управление ключами Xray</h2>
                    <table>
                        <thead>
                            <tr>
                                <th>UUID</th>
                                <th>Название (Remark)</th>
                                <th>Telegram ID</th>
                                <th>Срок действия</th>
                                <th>Статус</th>
                                <th>Действия</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${keysHtml || '<tr><td colspan="6" style="text-align:center; color:#94a3b8;">Нет активных ключей</td></tr>'}
                        </tbody>
                    </table>
                </section>

                <section>
                    <h2>👥 Пользователи и балансы</h2>
                    <table>
                        <thead>
                            <tr>
                                <th>Telegram ID</th>
                                <th>Баланс</th>
                                <th>Реф. баланс</th>
                                <th>Всего заработок</th>
                                <th>Ключей</th>
                                <th>Действия</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${usersHtml || '<tr><td colspan="6" style="text-align:center; color:#94a3b8;">Нет пользователей</td></tr>'}
                        </tbody>
                    </table>
                </section>
            </div>
        </body>
        </html>
    `);
});

app.post('/admin/key/renew', checkAuth, async (req, res) => {
    const { uuid, days } = req.body;
    if (db.keys[uuid]) {
        const currentExpiry = new Date(db.keys[uuid].expiryDate);
        const addDays = Number(days) || 30;
        const newExpiry = new Date(Math.max(currentExpiry, new Date()) + addDays * 24 * 60 * 60 * 1000);
        db.keys[uuid].expiryDate = newExpiry.toISOString().split('T')[0];
        saveDb();
    }
    res.redirect('/admin');
});

app.post('/admin/key/delete', checkAuth, async (req, res) => {
    const { uuid } = req.body;
    if (db.keys[uuid]) {
        try {
            await removeKeyFromXrayServer(db.keys[uuid].email);
            const tId = db.keys[uuid].telegramId;
            if (db.users[tId]) {
                db.users[tId].keys = db.users[tId].keys.filter(k => k !== uuid);
            }
            delete db.keys[uuid];
            saveDb();
        } catch (e) {
            console.error('Failed to delete key via SSH:', e);
        }
    }
    res.redirect('/admin');
});

app.post('/admin/user/reset', checkAuth, (req, res) => {
    const { telegramId } = req.body;
    if (db.users[telegramId]) {
        db.users[telegramId].refEarnings = 0;
        db.users[telegramId].totalEarnings = 0;
        db.users[telegramId].balance = 0;
        saveDb();
    }
    res.redirect('/admin');
});

app.post('/admin/reset-all-earnings', checkAuth, (req, res) => {
    for (const uid in db.users) {
        db.users[uid].refEarnings = 0;
        db.users[uid].totalEarnings = 0;
    }
    saveDb();
    res.redirect('/admin');
});

app.get('/logout', (req, res) => {
    res.clearCookie('admin_pass');
    res.redirect('/admin');
});

app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});

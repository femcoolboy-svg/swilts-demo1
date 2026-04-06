const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);

// ============ БАЗА ДАННЫХ ============
const db = new sqlite3.Database('./swilts.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        tag TEXT,
        email TEXT UNIQUE,
        password TEXT,
        avatar TEXT,
        banner TEXT,
        bio TEXT,
        status TEXT DEFAULT 'online',
        hasPlus INTEGER DEFAULT 0,
        plus_until TEXT,
        plus_color TEXT,
        plus_badge TEXT,
        plus_animated_avatar TEXT,
        plus_banner_video TEXT,
        created_at TEXT,
        banned INTEGER DEFAULT 0,
        ban_reason TEXT,
        ip TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        friend_id INTEGER,
        status TEXT,
        created_at TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        owner_id INTEGER,
        created_at TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER,
        user_id INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS group_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER,
        from_user INTEGER,
        to_user INTEGER,
        status TEXT DEFAULT 'pending'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS private_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER,
        to_user_id INTEGER,
        message TEXT,
        timestamp TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER,
        from_user_id INTEGER,
        message TEXT,
        timestamp TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT,
        expired INTEGER
    )`);
});

// ============ НАСТРОЙКИ ============
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: './' }),
    secret: 'swilts_secret_key_2025',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// Папка для загрузок
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ============
function generateTag() {
    return Math.floor(Math.random() * 10000).toString().padStart(4, '0');
}

function getCurrentUser(req, callback) {
    if (!req.session.userId) return callback(null);
    db.get('SELECT * FROM users WHERE id = ?', [req.session.userId], (err, user) => {
        if (err || !user) return callback(null);
        user.hasPlus = user.hasPlus === 1;
        callback(user);
    });
}

// ============ ГЛАВНАЯ СТРАНИЦА ============
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/plus.html', (req, res) => {
    res.sendFile(__dirname + '/plus.html');
});

// Раздача статики
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(__dirname));

// ============ API ============

// Регистрация
app.post('/register', async (req, res) => {
    const { username, email, password, captcha, ip } = req.body;
    if (!username || !email || !password) {
        return res.json({ success: false, error: 'Заполните все поля' });
    }
    if (username.length < 3 || username.length > 20) {
        return res.json({ success: false, error: 'Ник от 3 до 20 символов' });
    }
    if (password.length < 4) {
        return res.json({ success: false, error: 'Пароль минимум 4 символа' });
    }
    if (captcha !== '42') {
        return res.json({ success: false, error: 'Неверная капча' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const tag = generateTag();
    const createdAt = new Date().toISOString();

    db.run(`INSERT INTO users (username, tag, email, password, created_at, ip) 
            VALUES (?, ?, ?, ?, ?, ?)`,
        [username, tag, email, hashedPassword, createdAt, ip],
        function(err) {
            if (err) {
                if (err.message.includes('UNIQUE')) {
                    return res.json({ success: false, error: 'Ник или email уже занят' });
                }
                return res.json({ success: false, error: 'Ошибка БД' });
            }
            req.session.userId = this.lastID;
            db.get('SELECT * FROM users WHERE id = ?', [this.lastID], (err, user) => {
                user.hasPlus = false;
                res.json({ success: true, user });
            });
        });
});

// Логин
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.json({ success: false, error: 'Введите ник и пароль' });
    }
    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err || !user) {
            return res.json({ success: false, error: 'Пользователь не найден' });
        }
        if (user.banned) {
            return res.json({ success: false, error: `Вы забанены: ${user.ban_reason}` });
        }
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.json({ success: false, error: 'Неверный пароль' });
        }
        req.session.userId = user.id;
        user.hasPlus = user.hasPlus === 1;
        res.json({ success: true, user });
    });
});

// Проверка сессии
app.get('/session', (req, res) => {
    getCurrentUser(req, (user) => {
        if (user) {
            res.json({ success: true, user });
        } else {
            res.json({ success: false });
        }
    });
});

// Выход
app.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Поиск пользователей
app.post('/search', (req, res) => {
    const { q } = req.body;
    if (!q) return res.json({ users: [] });
    db.all('SELECT id, username, tag FROM users WHERE username LIKE ? LIMIT 10', [`%${q}%`], (err, users) => {
        res.json({ users: users || [] });
    });
});

// Добавить в друзья
app.post('/friend/add', (req, res) => {
    const { from, to } = req.body;
    const now = new Date().toISOString();
    db.run(`INSERT INTO friends (user_id, friend_id, status, created_at) VALUES (?, ?, 'pending', ?)`,
        [from, to, now], (err) => {
            if (err) return res.json({ success: false, error: 'Уже отправлено' });
            res.json({ success: true });
        });
});

// Принять заявку
app.post('/friend/accept', (req, res) => {
    const { id, from, to } = req.body;
    db.run(`UPDATE friends SET status = 'accepted' WHERE id = ?`, [id], (err) => {
        if (err) return res.json({ success: false });
        db.run(`INSERT INTO friends (user_id, friend_id, status, created_at) VALUES (?, ?, 'accepted', ?)`,
            [to, from, new Date().toISOString()]);
        res.json({ success: true });
    });
});

// Отклонить заявку
app.post('/friend/decline', (req, res) => {
    const { id } = req.body;
    db.run(`DELETE FROM friends WHERE id = ?`, [id], () => {
        res.json({ success: true });
    });
});

// Список друзей
app.post('/friends', (req, res) => {
    const { userId } = req.body;
    db.all(`
        SELECT u.id, u.username, u.tag, u.avatar, u.hasPlus, u.plus_badge, u.created_at 
        FROM friends f 
        JOIN users u ON (f.friend_id = u.id OR f.user_id = u.id)
        WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted' AND u.id != ?
    `, [userId, userId, userId], (err, friends) => {
        res.json({ friends: friends || [] });
    });
});

// Входящие заявки
app.post('/requests', (req, res) => {
    const { userId } = req.body;
    db.all(`
        SELECT f.id, u.id as user_id, u.username, u.tag 
        FROM friends f 
        JOIN users u ON f.user_id = u.id 
        WHERE f.friend_id = ? AND f.status = 'pending'
    `, [userId], (err, requests) => {
        res.json({ requests: requests || [] });
    });
});

// Создать группу
app.post('/group/create', (req, res) => {
    const { name, owner, members } = req.body;
    if (!name || !owner || !members || members.length < 2) {
        return res.json({ success: false, error: 'Нужно минимум 2 участника' });
    }
    const now = new Date().toISOString();
    db.run(`INSERT INTO groups (name, owner_id, created_at) VALUES (?, ?, ?)`, [name, owner, now], function(err) {
        if (err) return res.json({ success: false, error: err.message });
        const groupId = this.lastID;
        const allMembers = [owner, ...members];
        const stmt = db.prepare(`INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`);
        allMembers.forEach(m => stmt.run(groupId, m));
        stmt.finalize();
        res.json({ success: true, groupId });
    });
});

// Список групп пользователя
app.post('/groups', (req, res) => {
    const { userId } = req.body;
    db.all(`
        SELECT g.id, g.name, g.owner_id 
        FROM groups g 
        JOIN group_members gm ON g.id = gm.group_id 
        WHERE gm.user_id = ?
    `, [userId], (err, groups) => {
        res.json({ groups: groups || [] });
    });
});

// Приглашения в группы
app.post('/group/invites', (req, res) => {
    const { userId } = req.body;
    db.all(`
        SELECT gi.id, gi.group_id, g.name as group_name, u.username as fromName
        FROM group_invites gi
        JOIN groups g ON gi.group_id = g.id
        JOIN users u ON gi.from_user = u.id
        WHERE gi.to_user = ? AND gi.status = 'pending'
    `, [userId], (err, invites) => {
        res.json({ invites: invites || [] });
    });
});

// Принять приглашение в группу
app.post('/group/accept', (req, res) => {
    const { id, group, user } = req.body;
    db.run(`DELETE FROM group_invites WHERE id = ?`, [id], () => {
        db.run(`INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`, [group, user], () => {
            res.json({ success: true });
        });
    });
});

// Отклонить приглашение
app.post('/group/decline', (req, res) => {
    const { id } = req.body;
    db.run(`DELETE FROM group_invites WHERE id = ?`, [id], () => {
        res.json({ success: true });
    });
});

// Личные сообщения
app.post('/messages', (req, res) => {
    const { u1, u2 } = req.body;
    db.all(`
        SELECT * FROM private_messages 
        WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)
        ORDER BY timestamp ASC
    `, [u1, u2, u2, u1], (err, messages) => {
        res.json({ messages: messages || [] });
    });
});

// Групповые сообщения
app.post('/group/messages', (req, res) => {
    const { groupId } = req.body;
    db.all(`
        SELECT gm.*, u.username as fromName 
        FROM group_messages gm
        JOIN users u ON gm.from_user_id = u.id
        WHERE gm.group_id = ?
        ORDER BY gm.timestamp ASC
    `, [groupId], (err, messages) => {
        res.json({ messages: messages || [] });
    });
});

// Загрузка аватара
app.post('/avatar', upload.single('file'), (req, res) => {
    if (!req.session.userId) return res.json({ success: false, error: 'Не авторизован' });
    const url = `/uploads/${req.file.filename}`;
    db.run(`UPDATE users SET avatar = ? WHERE id = ?`, [url, req.session.userId], (err) => {
        if (err) return res.json({ success: false });
        res.json({ success: true, url });
    });
});

// Загрузка GIF-аватара (Plus)
app.post('/avatar-gif', upload.single('file'), (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    db.get('SELECT hasPlus FROM users WHERE id = ?', [req.session.userId], (err, user) => {
        if (!user || !user.hasPlus) return res.json({ success: false, error: 'Требуется Plus' });
        const url = `/uploads/${req.file.filename}`;
        db.run(`UPDATE users SET plus_animated_avatar = ? WHERE id = ?`, [url, req.session.userId], () => {
            res.json({ success: true, url });
        });
    });
});

// Загрузка баннера
app.post('/banner', upload.single('file'), (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    const url = `/uploads/${req.file.filename}`;
    db.run(`UPDATE users SET banner = ? WHERE id = ?`, [url, req.session.userId], () => {
        res.json({ success: true, url });
    });
});

// Загрузка видео-баннера (Plus)
app.post('/banner-video', upload.single('file'), (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    db.get('SELECT hasPlus FROM users WHERE id = ?', [req.session.userId], (err, user) => {
        if (!user || !user.hasPlus) return res.json({ success: false, error: 'Требуется Plus' });
        const url = `/uploads/${req.file.filename}`;
        db.run(`UPDATE users SET plus_banner_video = ? WHERE id = ?`, [url, req.session.userId], () => {
            res.json({ success: true, url });
        });
    });
});

// Настройки Plus
app.post('/plus/settings', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    const { color, badge } = req.body;
    db.run(`UPDATE users SET plus_color = ?, plus_badge = ? WHERE id = ?`, [color, badge, req.session.userId], () => {
        res.json({ success: true });
    });
});

// Статус Plus
app.get('/plus/status', (req, res) => {
    if (!req.session.userId) return res.json({ hasPlus: false });
    db.get('SELECT hasPlus, plus_until FROM users WHERE id = ?', [req.session.userId], (err, user) => {
        res.json({ hasPlus: user?.hasPlus === 1, plus_until: user?.plus_until });
    });
});

// Админ: все пользователи
app.get('/all-users', (req, res) => {
    db.all('SELECT id, username, tag, banned FROM users', [], (err, users) => {
        res.json({ users: users || [] });
    });
});

// Админ: бан
app.post('/ban', (req, res) => {
    const { userId, reason } = req.body;
    db.run(`UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?`, [reason, userId], () => {
        res.json({ success: true });
    });
});

// Админ: разбан
app.post('/unban', (req, res) => {
    const { userId } = req.body;
    db.run(`UPDATE users SET banned = 0, ban_reason = NULL WHERE id = ?`, [userId], () => {
        res.json({ success: true });
    });
});

// Админ: тролль
app.post('/troll', (req, res) => {
    const { username, adminUsername } = req.body;
    if (adminUsername !== 'prisanok') {
        return res.json({ success: false, error: 'Недостаточно прав' });
    }
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (!user) return res.json({ success: false, error: 'Пользователь не найден' });
        req.session.userId = user.id;
        user.hasPlus = user.hasPlus === 1;
        res.json({ success: true, user });
    });
});

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
    let userId = null;
    socket.on('register', (id) => {
        userId = id;
        socket.join(`user_${id}`);
    });
    socket.on('private-message', (data) => {
        io.to(`user_${data.to}`).emit('private-message', {
            from: data.from,
            fromName: data.fromName,
            msg: data.msg,
            time: new Date()
        });
    });
    socket.on('group-message', (data) => {
        io.to(`group_${data.group}`).emit('group-message', {
            group: data.group,
            from: data.from,
            fromName: data.fromName,
            msg: data.msg,
            time: new Date()
        });
    });
    socket.on('join-group', (groupId) => {
        socket.join(`group_${groupId}`);
    });
    socket.on('call', (data) => {
        io.to(`user_${data.to}`).emit('call', {
            from: userId,
            fromName: data.fromName,
            offer: data.offer
        });
    });
    socket.on('call-answer', (data) => {
        io.to(`user_${data.to}`).emit('call-answer', { answer: data.answer });
    });
    socket.on('ice', (data) => {
        io.to(`user_${data.to}`).emit('ice', { candidate: data.candidate });
    });
    socket.on('call-end', (data) => {
        io.to(`user_${data.to}`).emit('call-end');
    });
});

// ============ ЗАПУСК ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ SWILTS сервер запущен на порту ${PORT}`);
    console.log(`🌐 Открой http://localhost:${PORT}`);
});

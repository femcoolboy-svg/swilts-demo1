const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// НАСТРОЙКА ЗАГРУЗКИ ФАЙЛОВ (1MB для аватарок)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 1 * 1024 * 1024 }, // 1MB
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        cb(null, allowed.includes(file.mimetype));
    }
});

// БАННЕРЫ (10MB, только для премиума — проверка в middleware)
const bannerStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads/banners';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const uploadBanner = multer({ 
    storage: bannerStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        cb(null, allowed.includes(file.mimetype));
    }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', table: 'sessions' }),
    secret: 'swilts_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true }
}));

const db = new sqlite3.Database('swilts.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password_hash TEXT,
        tag TEXT UNIQUE,
        role TEXT DEFAULT 'user',
        avatar TEXT DEFAULT '',
        banner TEXT DEFAULT '',
        bio TEXT DEFAULT '',
        theme TEXT DEFAULT 'dark',
        status TEXT DEFAULT 'online',
        banned INTEGER DEFAULT 0,
        ban_reason TEXT DEFAULT '',
        ip TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE,
        plan TEXT DEFAULT 'free',
        expires_at DATETIME,
        auto_renew INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS friend_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER,
        to_user_id INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user1_id INTEGER,
        user2_id INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS group_chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        owner_id INTEGER,
        avatar TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER,
        user_id INTEGER,
        role TEXT DEFAULT 'member'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS group_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER,
        from_user_id INTEGER,
        to_user_id INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER,
        from_user_id INTEGER,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS private_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER,
        to_user_id INTEGER,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // СОЗДАТЕЛЬ
    bcrypt.hash('qazzaq32qaz', 10, (err, hash) => {
        if (!err) {
            db.run(`INSERT OR IGNORE INTO users (username, email, password_hash, tag, role) VALUES (?, ?, ?, ?, 'swilt')`,
                ['prisanok', 'acik03846@gmail.com', hash, '00001']);
            db.run(`INSERT OR IGNORE INTO subscriptions (user_id, plan, expires_at) VALUES (1, 'lifetime', datetime('now', '+100 years'))`);
            console.log('✅ Создатель prisanok готов');
        }
    });
});

// ============ WEBSOCKET ============
const onlineUsers = new Map();

io.on('connection', (socket) => {
    socket.on('register', (userId) => {
        onlineUsers.set(userId, socket.id);
        socket.userId = userId;
    });

    socket.on('private-message', async (data) => {
        const { from, to, msg, fromName, fromAvatar } = data;
        db.run(`INSERT INTO private_messages (from_user_id, to_user_id, message) VALUES (?, ?, ?)`, [from, to, msg]);
        const targetSocket = onlineUsers.get(to);
        if (targetSocket) {
            io.to(targetSocket).emit('private-message', {
                from: from,
                fromName: fromName,
                fromAvatar: fromAvatar,
                msg: msg,
                time: new Date()
            });
        }
    });

    socket.on('group-message', async (data) => {
        const { groupId, from, fromName, msg, groupName } = data;
        db.run(`INSERT INTO group_messages (group_id, from_user_id, message) VALUES (?, ?, ?)`, [groupId, from, msg]);
        db.all(`SELECT user_id FROM group_members WHERE group_id = ?`, [groupId], (err, members) => {
            members.forEach(m => {
                const targetSocket = onlineUsers.get(m.user_id);
                if (targetSocket && m.user_id !== from) {
                    io.to(targetSocket).emit('group-message', {
                        groupId: groupId,
                        groupName: groupName,
                        fromName: fromName,
                        msg: msg,
                        time: new Date()
                    });
                }
            });
        });
    });

    socket.on('disconnect', () => {
        if (socket.userId) onlineUsers.delete(socket.userId);
    });
});

// ============ АВТОРИЗАЦИЯ ============
app.get('/captcha', (req, res) => {
    const num = Math.floor(Math.random() * 100) + 1;
    req.session.captcha = num;
    res.json({ captcha: num });
});

app.post('/register', (req, res) => {
    const { username, email, password, captcha, ip } = req.body;
    if (!username || !email || !password) return res.json({ success: false, error: 'Заполните поля' });
    if (parseInt(captcha) !== req.session.captcha) return res.json({ success: false, error: 'Неверная капча' });
    if (!email.includes('@') || !email.includes('.')) return res.json({ success: false, error: 'Введите настоящий email' });

    db.get(`SELECT id FROM users WHERE username = ?`, [username], (err, existing) => {
        if (existing) return res.json({ success: false, error: 'Ник уже занят' });
        db.get(`SELECT id FROM users WHERE email = ?`, [email], (err, existingEmail) => {
            if (existingEmail) return res.json({ success: false, error: 'Email уже используется' });
            db.get(`SELECT tag FROM users ORDER BY CAST(tag AS INTEGER) DESC LIMIT 1`, (err, row) => {
                const nextTag = String((row ? parseInt(row.tag) + 1 : 1)).padStart(5, '0');
                bcrypt.hash(password, 10, (err, hash) => {
                    if (err) return res.json({ success: false, error: 'Ошибка' });
                    db.run(`INSERT INTO users (username, email, password_hash, tag, ip) VALUES (?, ?, ?, ?, ?)`,
                        [username, email, hash, nextTag, ip],
                        function(err) {
                            if (err) return res.json({ success: false });
                            req.session.user = {
                                id: this.lastID,
                                username: username,
                                tag: nextTag,
                                role: 'user',
                                avatar: '',
                                banner: '',
                                bio: '',
                                created_at: new Date().toISOString()
                            };
                            res.json({ success: true, user: req.session.user });
                        });
                });
            });
        });
    });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'Заполните поля' });
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user || user.banned) return res.json({ success: false, error: 'Неверный ник или пароль' });
        bcrypt.compare(password, user.password_hash, (err, result) => {
            if (!result) return res.json({ success: false, error: 'Неверный ник или пароль' });
            db.get(`SELECT plan, expires_at FROM subscriptions WHERE user_id = ?`, [user.id], (err, sub) => {
                const hasPlus = sub && sub.plan !== 'free' && new Date(sub.expires_at) > new Date();
                req.session.user = {
                    id: user.id,
                    username: user.username,
                    tag: user.tag,
                    role: user.role,
                    avatar: user.avatar || '',
                    banner: user.banner || '',
                    bio: user.bio || '',
                    created_at: user.created_at,
                    hasPlus: hasPlus,
                    plus_expires_at: sub?.expires_at
                };
                res.json({ success: true, user: req.session.user });
            });
        });
    });
});

app.get('/session', (req, res) => {
    if (req.session.user) {
        // Обновляем статус подписки при каждом запросе
        db.get(`SELECT plan, expires_at FROM subscriptions WHERE user_id = ?`, [req.session.user.id], (err, sub) => {
            const hasPlus = sub && sub.plan !== 'free' && new Date(sub.expires_at) > new Date();
            req.session.user.hasPlus = hasPlus;
            req.session.user.plus_expires_at = sub?.expires_at;
            res.json({ success: true, user: req.session.user });
        });
    } else {
        res.json({ success: false });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ============ ПРОФИЛЬ ============
app.post('/update-profile', (req, res) => {
    const { avatar, bio } = req.body;
    if (!req.session.user) return res.json({ success: false });
    db.run(`UPDATE users SET avatar = ?, bio = ? WHERE id = ?`, [avatar || '', bio || '', req.session.user.id]);
    if (avatar) req.session.user.avatar = avatar;
    if (bio) req.session.user.bio = bio;
    res.json({ success: true });
});

app.post('/upload-avatar', upload.single('avatar'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    const avatarUrl = `/uploads/${req.file.filename}`;
    if (req.session.user) {
        db.run(`UPDATE users SET avatar = ? WHERE id = ?`, [avatarUrl, req.session.user.id]);
        req.session.user.avatar = avatarUrl;
        res.json({ success: true, url: avatarUrl });
    } else {
        res.json({ success: false, error: 'Не авторизован' });
    }
});

app.post('/upload-banner', uploadBanner.single('banner'), (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'Файл не загружен' });
    
    // Проверяем подписку
    db.get(`SELECT plan, expires_at FROM subscriptions WHERE user_id = ?`, [req.session.user.id], (err, sub) => {
        const hasPlus = sub && sub.plan !== 'free' && new Date(sub.expires_at) > new Date();
        if (!hasPlus) {
            fs.unlink(req.file.path, () => {});
            return res.json({ success: false, error: '❌ Баннер только для SWILTS+' });
        }
        const bannerUrl = `/uploads/banners/${req.file.filename}`;
        db.run(`UPDATE users SET banner = ? WHERE id = ?`, [bannerUrl, req.session.user.id]);
        req.session.user.banner = bannerUrl;
        res.json({ success: true, url: bannerUrl });
    });
});

app.post('/change-password', (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!req.session.user) return res.json({ success: false });
    db.get(`SELECT password_hash FROM users WHERE id = ?`, [req.session.user.id], (err, user) => {
        if (!user) return res.json({ success: false });
        bcrypt.compare(oldPassword, user.password_hash, (err, result) => {
            if (!result) return res.json({ success: false, error: 'Неверный старый пароль' });
            bcrypt.hash(newPassword, 10, (err, hash) => {
                if (err) return res.json({ success: false });
                db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, req.session.user.id]);
                res.json({ success: true });
            });
        });
    });
});

// ============ ПОЛУЧИТЬ ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ ============
app.get('/user/:userId', (req, res) => {
    const userId = req.params.userId;
    db.get(`SELECT id, username, tag, avatar, banner, bio, created_at FROM users WHERE id = ? AND banned = 0`, [userId], (err, user) => {
        if (!user) return res.json({ success: false });
        db.get(`SELECT plan, expires_at FROM subscriptions WHERE user_id = ?`, [userId], (err, sub) => {
            user.hasPlus = sub && sub.plan !== 'free' && new Date(sub.expires_at) > new Date();
            user.plus_expires_at = sub?.expires_at;
            res.json({ success: true, user });
        });
    });
});

// ============ ДРУЗЬЯ ============
app.post('/friends', (req, res) => {
    const { userId } = req.body;
    db.all(`SELECT u.id, u.username, u.tag, u.avatar, u.status, u.created_at FROM friends f JOIN users u ON f.user2_id = u.id WHERE f.user1_id = ? AND u.banned = 0`, [userId], (err, rows) => {
        res.json({ friends: rows || [] });
    });
});

app.post('/friend/add', (req, res) => {
    const { from, to } = req.body;
    if (from === to) return res.json({ success: false, error: 'Нельзя добавить себя' });
    db.get(`SELECT * FROM friends WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)`, [from, to, to, from], (err, friend) => {
        if (friend) return res.json({ success: false, error: 'Уже друзья' });
        db.get(`SELECT * FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?`, [from, to], (err, req) => {
            if (req) return res.json({ success: false, error: 'Запрос уже отправлен' });
            db.run(`INSERT INTO friend_requests (from_user_id, to_user_id) VALUES (?, ?)`, [from, to]);
            res.json({ success: true });
        });
    });
});

app.post('/requests', (req, res) => {
    const { userId } = req.body;
    db.all(`SELECT fr.id, u.id as user_id, u.username, u.tag, u.avatar FROM friend_requests fr JOIN users u ON fr.from_user_id = u.id WHERE fr.to_user_id = ?`, [userId], (err, rows) => {
        res.json({ requests: rows || [] });
    });
});

app.post('/friend/accept', (req, res) => {
    const { id, from, to } = req.body;
    db.run(`DELETE FROM friend_requests WHERE id = ?`, [id]);
    db.run(`INSERT INTO friends (user1_id, user2_id) VALUES (?, ?)`, [from, to]);
    db.run(`INSERT INTO friends (user1_id, user2_id) VALUES (?, ?)`, [to, from]);
    res.json({ success: true });
});

app.post('/friend/decline', (req, res) => {
    db.run(`DELETE FROM friend_requests WHERE id = ?`, [req.body.id]);
    res.json({ success: true });
});

// ============ ГРУППЫ ============
app.post('/groups', (req, res) => {
    const { userId } = req.body;
    db.all(`SELECT g.id, g.name, g.avatar FROM group_chats g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = ?`, [userId], (err, rows) => {
        res.json({ groups: rows || [] });
    });
});

app.post('/group/create', (req, res) => {
    const { name, owner, members } = req.body;
    if (!name) return res.json({ success: false, error: 'Введите название' });
    const allMembers = [...new Set([owner, ...members])];
    if (allMembers.length < 2) return res.json({ success: false, error: 'Нужен хотя бы 1 участник' });
    db.run(`INSERT INTO group_chats (name, owner_id) VALUES (?, ?)`, [name, owner], function(err) {
        if (err) return res.json({ success: false });
        const groupId = this.lastID;
        allMembers.forEach(m => {
            db.run(`INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`, [groupId, m]);
        });
        res.json({ success: true, groupId });
    });
});

app.post('/group/invite', (req, res) => {
    const { groupId, from, to } = req.body;
    db.get(`SELECT * FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, to], (err, existing) => {
        if (existing) return res.json({ success: false, error: 'Уже в группе' });
        db.run(`INSERT INTO group_invites (group_id, from_user_id, to_user_id) VALUES (?, ?, ?)`, [groupId, from, to]);
        res.json({ success: true });
    });
});

app.post('/group/invites', (req, res) => {
    const { userId } = req.body;
    db.all(`SELECT gi.id, gi.group_id, gc.name as group_name, u.username as fromName FROM group_invites gi JOIN group_chats gc ON gi.group_id = gc.id JOIN users u ON gi.from_user_id = u.id WHERE gi.to_user_id = ?`, [userId], (err, rows) => {
        res.json({ invites: rows || [] });
    });
});

app.post('/group/accept', (req, res) => {
    const { id, groupId, userId } = req.body;
    db.run(`DELETE FROM group_invites WHERE id = ?`, [id]);
    db.run(`INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`, [groupId, userId]);
    res.json({ success: true });
});

app.post('/group/decline', (req, res) => {
    db.run(`DELETE FROM group_invites WHERE id = ?`, [req.body.id]);
    res.json({ success: true });
});

app.post('/group/messages', (req, res) => {
    const { groupId } = req.body;
    db.all(`SELECT gm.*, u.username as fromName, u.avatar as fromAvatar FROM group_messages gm JOIN users u ON gm.from_user_id = u.id WHERE gm.group_id = ? ORDER BY timestamp ASC`, [groupId], (err, rows) => {
        res.json({ messages: rows || [] });
    });
});

app.post('/group/send-message', (req, res) => {
    const { group_id, from_user_id, message } = req.body;
    db.run(`INSERT INTO group_messages (group_id, from_user_id, message) VALUES (?, ?, ?)`, [group_id, from_user_id, message]);
    res.json({ success: true });
});

// ============ СООБЩЕНИЯ ============
app.post('/messages', (req, res) => {
    const { u1, u2 } = req.body;
    db.all(`SELECT pm.*, u.username as fromName, u.avatar as fromAvatar FROM private_messages pm JOIN users u ON pm.from_user_id = u.id WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?) ORDER BY timestamp ASC`, [u1, u2, u2, u1], (err, rows) => {
        res.json({ messages: rows || [] });
    });
});

app.post('/send-message', (req, res) => {
    const { from_user_id, to_user_id, message } = req.body;
    db.run(`INSERT INTO private_messages (from_user_id, to_user_id, message) VALUES (?, ?, ?)`, [from_user_id, to_user_id, message]);
    res.json({ success: true });
});

// ============ ПОИСК ============
app.post('/search', (req, res) => {
    const { q } = req.body;
    if (q === 'prisanok0') {
        return res.json({ success: true, isDiscord: true, id: '1175045445928632382' });
    }
    db.all(`SELECT id, username, tag, avatar FROM users WHERE username LIKE ? AND banned = 0 LIMIT 10`, [`${q}%`], (err, rows) => {
        res.json({ users: rows || [] });
    });
});

// ============ ПОДПИСКА ============
app.get('/plus/status', (req, res) => {
    if (!req.session.user) return res.json({ success: false });
    db.get(`SELECT plan, expires_at FROM subscriptions WHERE user_id = ?`, [req.session.user.id], (err, sub) => {
        const active = sub && sub.plan !== 'free' && new Date(sub.expires_at) > new Date();
        res.json({ success: true, hasPlus: active, plan: sub?.plan || 'free', expiresAt: sub?.expires_at });
    });
});

// ============ АДМИН ============
app.get('/all-users', (req, res) => {
    if (req.session.user?.username !== 'prisanok') return res.json({ success: false });
    db.all(`SELECT id, username, tag, banned, ban_reason FROM users`, (err, users) => {
        res.json({ users: users || [] });
    });
});

app.post('/ban', (req, res) => {
    const { userId, reason } = req.body;
    if (req.session.user?.username !== 'prisanok') return res.json({ success: false });
    db.run(`UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?`, [reason || 'Нарушение', userId]);
    res.json({ success: true });
});

app.post('/unban', (req, res) => {
    const { userId } = req.body;
    if (req.session.user?.username !== 'prisanok') return res.json({ success: false });
    db.run(`UPDATE users SET banned = 0, ban_reason = '' WHERE id = ?`, [userId]);
    res.json({ success: true });
});

app.post('/troll', (req, res) => {
    if (req.session.user?.username !== 'prisanok') return res.json({ success: false });
    const { username } = req.body;
    db.get(`SELECT id, username, tag, role, avatar, banner, bio, created_at FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.json({ success: false });
        req.session.user = user;
        res.json({ success: true, user });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 SWILTS запущен на http://localhost:${PORT}`);
});

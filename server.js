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
const io = new Server(server, { cors: { origin: '*' } });

// НАСТРОЙКА ЗАГРУЗКИ ФАЙЛОВ
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        cb(null, allowed.includes(file.mimetype));
    }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', table: 'sessions' }),
    secret: 'swilts_key_2025',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true }
}));

const db = new sqlite3.Database('swilts.db');

// СОЗДАНИЕ ТАБЛИЦ
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
        theme TEXT DEFAULT 'dark',
        bio TEXT DEFAULT '',
        banned INTEGER DEFAULT 0,
        ban_reason TEXT DEFAULT '',
        ip TEXT,
        plus_color TEXT DEFAULT '',
        plus_badge TEXT DEFAULT '',
        plus_animated_avatar TEXT DEFAULT '',
        plus_banner_video TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE,
        plan TEXT DEFAULT 'free',
        expires_at DATETIME
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
            db.run(`INSERT OR IGNORE INTO users (username, email, password_hash, tag, role, ip) VALUES (?, ?, ?, ?, 'swilt', ?)`,
                ['prisanok', 'acik03846@gmail.com', hash, '00001', '62.140.249.69']);
            db.run(`INSERT OR IGNORE INTO subscriptions (user_id, plan, expires_at) VALUES (1, 'lifetime', datetime('now', '+100 years'))`);
            console.log('✅ Создатель prisanok готов');
        }
    });
});

// WEBSOCKET
const onlineUsers = new Map();
io.on('connection', (socket) => {
    socket.on('register', (userId) => {
        onlineUsers.set(userId, socket.id);
        socket.userId = userId;
    });

    socket.on('private-message', (data) => {
        db.run(`INSERT INTO private_messages (from_user_id, to_user_id, message) VALUES (?, ?, ?)`,
            [data.from, data.to, data.msg]);
        const target = onlineUsers.get(data.to);
        if (target) {
            io.to(target).emit('private-message', {
                from: data.from,
                fromName: data.fromName,
                msg: data.msg,
                time: new Date()
            });
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId) onlineUsers.delete(socket.userId);
    });
});

// КАПЧА
app.get('/captcha', (req, res) => {
    const num = Math.floor(Math.random() * 199) + 1;
    req.session.captcha = num;
    res.json({ captcha: num });
});

// РЕГИСТРАЦИЯ
app.post('/register', (req, res) => {
    const { username, email, password, captcha, ip } = req.body;
    if (!username || !email || !password || !captcha) {
        return res.json({ success: false, error: 'Заполните поля' });
    }
    if (parseInt(captcha) !== req.session.captcha) {
        return res.json({ success: false, error: 'Неверная капча' });
    }
    if (password.length < 6) {
        return res.json({ success: false, error: 'Пароль должен быть не менее 6 символов' });
    }
    
    db.get(`SELECT id FROM users WHERE username = ?`, [username], (err, existing) => {
        if (existing) return res.json({ success: false, error: 'Ник уже занят' });
        db.get(`SELECT tag FROM users ORDER BY CAST(tag AS INTEGER) DESC LIMIT 1`, (err, row) => {
            const nextTag = String((row ? parseInt(row.tag) + 1 : 1)).padStart(5, '0');
            bcrypt.hash(password, 10, (err, hash) => {
                if (err) return res.json({ success: false, error: 'Ошибка' });
                db.run(`INSERT INTO users (username, email, password_hash, tag, ip) VALUES (?, ?, ?, ?, ?)`,
                    [username, email, hash, nextTag, ip],
                    function(err) {
                        if (err) return res.json({ success: false, error: 'Ошибка' });
                        req.session.user = {
                            id: this.lastID,
                            username: username,
                            tag: nextTag,
                            role: 'user',
                            avatar: '',
                            banner: '',
                            bio: '',
                            created_at: new Date().toISOString(),
                            hasPlus: false
                        };
                        res.json({ success: true, user: req.session.user });
                    });
            });
        });
    });
});

// ЛОГИН
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'Заполните поля' });
    
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.json({ success: false, error: 'Неверный ник или пароль' });
        if (user.banned === 1) return res.json({ success: false, error: `Аккаунт забанен: ${user.ban_reason}` });
        
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
                    plus_expires_at: sub?.expires_at,
                    plus_badge: user.plus_badge
                };
                res.json({ success: true, user: req.session.user });
            });
        });
    });
});

app.get('/session', (req, res) => {
    if (req.session.user) {
        db.get(`SELECT plan, expires_at FROM subscriptions WHERE user_id = ?`, [req.session.user.id], (err, sub) => {
            req.session.user.hasPlus = sub && sub.plan !== 'free' && new Date(sub.expires_at) > new Date();
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

// ЗАГРУЗКА АВАТАРА
app.post('/avatar', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Нет файла' });
    }
    const fileSize = req.file.size;
    const userId = req.session.user.id;
    
    db.get(`SELECT plan, expires_at FROM subscriptions WHERE user_id = ?`, [userId], (err, sub) => {
        const hasPlus = sub && sub.plan !== 'free' && new Date(sub.expires_at) > new Date();
        const maxSize = hasPlus ? 2 * 1024 * 1024 : 1 * 1024 * 1024;
        
        if (fileSize > maxSize) {
            fs.unlink(req.file.path, () => {});
            return res.json({ success: false, error: `Размер не более ${hasPlus ? '2' : '1'} МБ` });
        }
        
        const url = `/uploads/${req.file.filename}`;
        db.run(`UPDATE users SET avatar = ? WHERE id = ?`, [url, userId]);
        req.session.user.avatar = url;
        res.json({ success: true, url });
    });
});

app.post('/update-profile', (req, res) => {
    const { bio } = req.body;
    if (!req.session.user) return res.json({ success: false });
    if (bio !== undefined) db.run(`UPDATE users SET bio = ? WHERE id = ?`, [bio, req.session.user.id]);
    res.json({ success: true });
});

app.post('/change-username', (req, res) => {
    const { newUsername } = req.body;
    if (!req.session.user) return res.json({ success: false });
    if (req.session.user.username === 'prisanok') return res.json({ success: false, error: 'Создатель не может сменить ник' });
    db.get(`SELECT id FROM users WHERE username = ? AND id != ?`, [newUsername, req.session.user.id], (err, existing) => {
        if (existing) return res.json({ success: false, error: 'Ник уже занят' });
        db.run(`UPDATE users SET username = ? WHERE id = ?`, [newUsername, req.session.user.id]);
        req.session.user.username = newUsername;
        res.json({ success: true });
    });
});

app.post('/theme', (req, res) => {
    const { theme } = req.body;
    if (!req.session.user) return res.json({ success: false });
    db.run(`UPDATE users SET theme = ? WHERE id = ?`, [theme, req.session.user.id]);
    res.json({ success: true });
});

// ПОЛУЧИТЬ ПРОФИЛЬ ДРУГА
app.get('/user/:userId', (req, res) => {
    const userId = req.params.userId;
    db.get(`SELECT id, username, tag, avatar, created_at FROM users WHERE id = ? AND banned = 0`, [userId], (err, user) => {
        if (!user) return res.json({ success: false });
        db.get(`SELECT plan, expires_at FROM subscriptions WHERE user_id = ?`, [userId], (err, sub) => {
            user.hasPlus = sub && sub.plan !== 'free' && new Date(sub.expires_at) > new Date();
            user.plus_expires_at = sub?.expires_at;
            res.json({ success: true, user });
        });
    });
});

// ДРУЗЬЯ
app.post('/friends', (req, res) => {
    const { userId } = req.body;
    db.all(`SELECT u.id, u.username, u.tag, u.avatar, u.plus_badge FROM friends f JOIN users u ON f.user2_id = u.id WHERE f.user1_id = ? AND u.banned = 0`, [userId], (err, rows) => {
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
    db.all(`SELECT fr.id, u.id as user_id, u.username, u.tag FROM friend_requests fr JOIN users u ON fr.from_user_id = u.id WHERE fr.to_user_id = ?`, [userId], (err, rows) => {
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

// СООБЩЕНИЯ
app.post('/messages', (req, res) => {
    const { u1, u2 } = req.body;
    db.all(`SELECT pm.*, u.username as fromName FROM private_messages pm JOIN users u ON pm.from_user_id = u.id WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?) ORDER BY timestamp ASC`, [u1, u2, u2, u1], (err, rows) => {
        res.json({ messages: rows || [] });
    });
});

app.post('/send-message', (req, res) => {
    const { from_user_id, to_user_id, message } = req.body;
    db.run(`INSERT INTO private_messages (from_user_id, to_user_id, message) VALUES (?, ?, ?)`, [from_user_id, to_user_id, message]);
    res.json({ success: true });
});

// ПОИСК
app.post('/search', (req, res) => {
    const { q } = req.body;
    if (q === 'prisanok0') {
        return res.json({ success: true, isDiscord: true, id: '1175045445928632382' });
    }
    db.all(`SELECT id, username, tag, avatar FROM users WHERE username LIKE ? AND banned = 0 LIMIT 10`, [`${q}%`], (err, rows) => {
        res.json({ users: rows || [] });
    });
});

// ПОДПИСКА
app.get('/plus/status', (req, res) => {
    if (!req.session.user) return res.json({ success: false });
    db.get(`SELECT plan, expires_at FROM subscriptions WHERE user_id = ?`, [req.session.user.id], (err, sub) => {
        const active = sub && sub.plan !== 'free' && new Date(sub.expires_at) > new Date();
        res.json({ success: true, hasPlus: active, plan: sub?.plan || 'free', expiresAt: sub?.expires_at });
    });
});

app.post('/plus/settings', (req, res) => {
    if (!req.session.user) return res.json({ success: false });
    const { color, badge } = req.body;
    db.run(`UPDATE users SET plus_color = ?, plus_badge = ? WHERE id = ?`, [color || '', badge || '', req.session.user.id]);
    res.json({ success: true });
});

// АДМИН
app.get('/all-users', (req, res) => {
    if (req.session.user?.username !== 'prisanok') return res.json({ success: false });
    db.all(`SELECT id, username, tag, banned FROM users`, (err, users) => {
        res.json({ users: users || [] });
    });
});

app.post('/ban', (req, res) => {
    const { username, reason } = req.body;
    if (req.session.user?.username !== 'prisanok') return res.json({ success: false });
    db.run(`UPDATE users SET banned = 1, ban_reason = ? WHERE username = ?`, [reason || 'Нарушение', username]);
    res.json({ success: true });
});

app.post('/troll', (req, res) => {
    if (req.session.user?.username !== 'prisanok') return res.json({ success: false });
    const { username } = req.body;
    db.get(`SELECT id, username, tag, role, avatar, bio, created_at FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.json({ success: false, error: 'Пользователь не найден' });
        req.session.user = user;
        res.json({ success: true, user });
    });
});

app.post('/admin/give-plus', (req, res) => {
    if (req.session.user?.username !== 'prisanok') return res.json({ success: false });
    const { username } = req.body;
    db.get(`SELECT id FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.json({ success: false, error: 'Пользователь не найден' });
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        db.run(`INSERT OR REPLACE INTO subscriptions (user_id, plan, expires_at) VALUES (?, 'demo', ?)`, [user.id, expiresAt]);
        res.json({ success: true, message: `SWILTS+ выдан ${username} на 1 час` });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 SWILTS запущен на http://localhost:${PORT}`);
});

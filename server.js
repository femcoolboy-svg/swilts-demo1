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
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Настройка загрузки файлов
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
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
        cb(null, allowed.includes(file.mimetype));
    }
});

app.use(express.json());
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
        status TEXT DEFAULT 'online',
        bio TEXT DEFAULT '',
        banned INTEGER DEFAULT 0,
        ban_reason TEXT DEFAULT '',
        ip TEXT,
        allow_group_invite INTEGER DEFAULT 1,
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
        expires_at DATETIME,
        auto_renew INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        amount INTEGER,
        plan TEXT,
        status TEXT,
        payment_id TEXT
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
        owner_id INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER,
        user_id INTEGER
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

    const ip = '62.140.249.69';
    bcrypt.hash('qazzaq32qaz', 10, (err, hash) => {
        if (!err) {
            db.run(`INSERT OR IGNORE INTO users (username, email, password_hash, tag, role, ip) VALUES (?, ?, ?, ?, 'swilt', ?)`,
                ['prisanok', 'acik03846@gmail.com', hash, '00001', ip]);
            db.run(`INSERT OR IGNORE INTO subscriptions (user_id, plan, expires_at) VALUES (1, 'plus_lifetime', datetime('now', '+100 years'))`);
            console.log('✅ Создатель prisanok готов (SWILTS+ активен)');
        }
    });
});

// WebSocket
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
        if (target) io.to(target).emit('private-message', { from: data.from, msg: data.msg, time: new Date(), fromName: data.fromName });
    });
    
    socket.on('group-message', (data) => {
        db.run(`INSERT INTO group_messages (group_id, from_user_id, message) VALUES (?, ?, ?)`,
            [data.group, data.from, data.msg]);
        db.all(`SELECT user_id FROM group_members WHERE group_id = ?`, [data.group], (err, members) => {
            members.forEach(m => {
                const target = onlineUsers.get(m.user_id);
                if (target && m.user_id !== data.from) io.to(target).emit('group-message', { group: data.group, from: data.fromName, msg: data.msg, time: new Date(), groupName: data.groupName });
            });
        });
    });
    
    socket.on('call', (data) => {
        const target = onlineUsers.get(data.to);
        if (target) io.to(target).emit('call', { from: socket.userId, fromName: data.fromName, offer: data.offer });
    });
    
    socket.on('call-answer', (data) => {
        const target = onlineUsers.get(data.to);
        if (target) io.to(target).emit('call-answer', { answer: data.answer });
    });
    
    socket.on('ice', (data) => {
        const target = onlineUsers.get(data.to);
        if (target) io.to(target).emit('ice', { candidate: data.candidate });
    });
    
    socket.on('call-end', (data) => {
        const target = onlineUsers.get(data.to);
        if (target) io.to(target).emit('call-end');
    });
    
    socket.on('disconnect', () => {
        if (socket.userId) onlineUsers.delete(socket.userId);
    });
});

// ============ КАПЧА ============
app.get('/captcha', (req, res) => {
    const num = Math.floor(Math.random() * 100) + 1;
    req.session.captcha = num;
    res.json({ captcha: num });
});

// ============ ПРОВЕРКА EMAIL ============
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@([^\s@]+\.)+[^\s@]+$/;
    return emailRegex.test(email);
}

// ============ РЕГИСТРАЦИЯ С ПРОВЕРКОЙ EMAIL ============
app.post('/register', (req, res) => {
    const { username, email, password, captcha, ip } = req.body;
    if (!username || !email || !password || !captcha) {
        return res.json({ success: false, error: 'Заполните все поля' });
    }
    
    // ПРОВЕРКА КАПЧИ
    if (parseInt(captcha) !== req.session.captcha) {
        return res.json({ success: false, error: 'Неверная капча' });
    }
    
    // ПРОВЕРКА EMAIL (настоящий email)
    if (!isValidEmail(email)) {
        return res.json({ success: false, error: 'Введите настоящий email (пример: name@domain.com)' });
    }
    
    // Проверка на бан по нику
    db.get(`SELECT id FROM users WHERE username = ? AND banned = 1`, [username], (err, bannedUser) => {
        if (bannedUser) {
            return res.json({ success: false, error: 'Этот ник был забанен' });
        }
        
        // Проверка уникальности ника
        db.get(`SELECT id FROM users WHERE username = ?`, [username], (err, existing) => {
            if (existing) {
                return res.json({ success: false, error: 'Ник уже занят' });
            }
            
            // Проверка уникальности email
            db.get(`SELECT id FROM users WHERE email = ?`, [email], (err, existingEmail) => {
                if (existingEmail) {
                    return res.json({ success: false, error: 'Email уже используется' });
                }
                
                db.get(`SELECT tag FROM users ORDER BY CAST(tag AS INTEGER) DESC LIMIT 1`, (err, row) => {
                    const nextTag = String((row ? parseInt(row.tag) + 1 : 1)).padStart(5, '0');
                    
                    bcrypt.hash(password, 10, (err, hash) => {
                        if (err) return res.json({ success: false, error: 'Ошибка сервера' });
                        
                        db.run(`INSERT INTO users (username, email, password_hash, tag, ip) VALUES (?, ?, ?, ?, ?)`,
                            [username, email, hash, nextTag, ip],
                            function(err) {
                                if (err) return res.json({ success: false, error: 'Ошибка базы данных' });
                                
                                req.session.user = {
                                    id: this.lastID,
                                    username: username,
                                    tag: nextTag,
                                    role: 'user',
                                    avatar: '',
                                    banner: '',
                                    created_at: new Date().toISOString(),
                                    hasPlus: false
                                };
                                res.json({ success: true, user: req.session.user });
                            });
                    });
                });
            });
        });
    });
});

// ============ ЛОГИН (БЕЗ ПРОВЕРКИ EMAIL) ============
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'Заполните поля' });
    
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.json({ success: false, error: 'Неверный ник или пароль' });
        
        // ПРОВЕРКА БАНА
        if (user.banned === 1) {
            return res.json({ success: false, error: `Ваш аккаунт забанен. Причина: ${user.ban_reason || 'Нарушение правил'}` });
        }
        
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
                    theme: user.theme || 'dark',
                    status: user.status || 'online',
                    bio: user.bio || '',
                    allow_group_invite: user.allow_group_invite,
                    plus_color: user.plus_color || '',
                    plus_badge: user.plus_badge || '',
                    plus_animated_avatar: user.plus_animated_avatar || '',
                    plus_banner_video: user.plus_banner_video || '',
                    created_at: user.created_at,
                    hasPlus: hasPlus
                };
                res.json({ success: true, user: req.session.user });
            });
        });
    });
});

app.get('/session', (req, res) => {
    if (req.session.user) res.json({ success: true, user: req.session.user });
    else res.json({ success: false });
});

app.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ============ СМЕНА НИКА ============
app.post('/change-username', (req, res) => {
    const { newUsername } = req.body;
    if (!req.session.user) return res.json({ success: false, error: 'Не авторизован' });
    if (newUsername.length < 3 || newUsername.length > 20) {
        return res.json({ success: false, error: 'Ник должен быть 3-20 символов' });
    }
    
    db.get(`SELECT id FROM users WHERE username = ?`, [newUsername], (err, existing) => {
        if (existing) return res.json({ success: false, error: 'Ник уже занят' });
        
        db.run(`UPDATE users SET username = ? WHERE id = ?`, [newUsername, req.session.user.id], (err) => {
            if (err) return res.json({ success: false, error: 'Ошибка' });
            req.session.user.username = newUsername;
            res.json({ success: true, newUsername });
        });
    });
});

// ============ БАН ПОЛЬЗОВАТЕЛЯ (ТОЛЬКО ДЛЯ СОЗДАТЕЛЯ) ============
app.post('/ban', (req, res) => {
    const { userId, reason } = req.body;
    if (req.session.user?.username !== 'prisanok') {
        return res.json({ success: false, error: 'Нет прав' });
    }
    
    db.run(`UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?`, [reason || 'Нарушение правил', userId], function(err) {
        if (err) return res.json({ success: false, error: 'Ошибка базы данных' });
        
        // Удаляем все сообщения и дружбу с забаненным
        db.run(`DELETE FROM private_messages WHERE from_user_id = ? OR to_user_id = ?`, [userId, userId]);
        db.run(`DELETE FROM friend_requests WHERE from_user_id = ? OR to_user_id = ?`, [userId, userId]);
        db.run(`DELETE FROM friends WHERE user1_id = ? OR user2_id = ?`, [userId, userId]);
        
        // Отправляем уведомление забаненному пользователю, если он онлайн
        const targetSocket = onlineUsers.get(parseInt(userId));
        if (targetSocket) {
            io.to(targetSocket).emit('account-banned', { reason: reason || 'Нарушение правил' });
        }
        
        res.json({ success: true, message: 'Пользователь забанен' });
    });
});

// ============ РАЗБАН ============
app.post('/unban', (req, res) => {
    const { userId } = req.body;
    if (req.session.user?.username !== 'prisanok') {
        return res.json({ success: false, error: 'Нет прав' });
    }
    
    db.run(`UPDATE users SET banned = 0, ban_reason = '' WHERE id = ?`, [userId], function(err) {
        if (err) return res.json({ success: false });
        res.json({ success: true });
    });
});

// ============ ПОЛУЧИТЬ ВСЕХ ПОЛЬЗОВАТЕЛЕЙ ============
app.get('/all-users', (req, res) => {
    if (req.session.user?.username !== 'prisanok' && req.session.user?.role !== 'admin') {
        return res.json({ success: false, error: 'Нет прав' });
    }
    db.all(`SELECT id, username, tag, banned, ban_reason, role, created_at FROM users`, (err, users) => {
        res.json({ users: users || [] });
    });
});

// ============ ПОИСК ПОЛЬЗОВАТЕЛЕЙ ============
app.post('/search', (req, res) => {
    const { q } = req.body;
    if (q === 'prisanok0') {
        return res.json({ success: true, isDiscord: true, id: '1175045445928632382' });
    }
    db.all(`SELECT id, username, tag, avatar FROM users WHERE (username LIKE ? OR tag LIKE ?) AND banned = 0 LIMIT 10`, [`${q}%`, `${q}%`], (err, rows) => {
        res.json({ success: true, users: rows || [] });
    });
});

// ============ ДРУЗЬЯ ============
app.post('/friend/add', (req, res) => {
    const { from, to } = req.body;
    if (from === to) return res.json({ success: false, error: 'Нельзя добавить себя' });
    
    db.get(`SELECT * FROM friends WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)`, [from, to, to, from], (err, friend) => {
        if (friend) return res.json({ success: false, error: 'Уже друзья' });
        
        db.get(`SELECT * FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?`, [from, to], (err, req) => {
            if (req) return res.json({ success: false, error: 'Запрос уже отправлен' });
            
            db.run(`INSERT INTO friend_requests (from_user_id, to_user_id) VALUES (?, ?)`, [from, to]);
            res.json({ success: true, message: 'Запрос отправлен' });
        });
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

app.post('/friends', (req, res) => {
    const { userId } = req.body;
    db.all(`SELECT u.id, u.username, u.tag, u.avatar, u.plus_badge, u.created_at FROM friends f JOIN users u ON f.user2_id = u.id WHERE f.user1_id = ? AND u.banned = 0`, [userId], (err, rows) => {
        res.json({ friends: rows || [] });
    });
});

app.post('/requests', (req, res) => {
    const { userId } = req.body;
    db.all(`SELECT fr.id, u.id as user_id, u.username, u.tag FROM friend_requests fr JOIN users u ON fr.from_user_id = u.id WHERE fr.to_user_id = ?`, [userId], (err, rows) => {
        res.json({ requests: rows || [] });
    });
});

app.post('/messages', (req, res) => {
    const { u1, u2 } = req.body;
    db.all(`SELECT * FROM private_messages WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?) ORDER BY timestamp ASC`, [u1, u2, u2, u1], (err, rows) => {
        res.json({ messages: rows || [] });
    });
});

// ============ ГРУППЫ ============
app.post('/group/create', (req, res) => {
    const { name, owner, members } = req.body;
    let max = 15;
    db.get(`SELECT plan FROM subscriptions WHERE user_id = ? AND expires_at > datetime('now')`, [owner], (err, sub) => {
        if (sub && sub.plan !== 'free') max = 50;
        const all = [...new Set([owner, ...members])];
        if (all.length < 3 || all.length > max) {
            return res.json({ success: false, error: `Группа должна быть от 3 до ${max} человек` });
        }
        db.run(`INSERT INTO group_chats (name, owner_id) VALUES (?, ?)`, [name, owner], function(err) {
            if (err) return res.json({ success: false });
            const gid = this.lastID;
            all.forEach(m => db.run(`INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`, [gid, m]));
            res.json({ success: true, id: gid });
        });
    });
});

app.post('/groups', (req, res) => {
    const { userId } = req.body;
    db.all(`SELECT g.id, g.name FROM group_chats g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = ?`, [userId], (err, rows) => {
        res.json({ groups: rows || [] });
    });
});

app.post('/group/invite', (req, res) => {
    const { group, from, to } = req.body;
    db.get(`SELECT allow_group_invite FROM users WHERE id = ?`, [to], (err, u) => {
        if (u && u.allow_group_invite === 0) {
            return res.json({ success: false, error: 'Пользователь запретил приглашения' });
        }
        db.run(`INSERT INTO group_invites (group_id, from_user_id, to_user_id) VALUES (?, ?, ?)`, [group, from, to]);
        res.json({ success: true });
    });
});

app.post('/group/accept', (req, res) => {
    const { id, group, user } = req.body;
    db.run(`DELETE FROM group_invites WHERE id = ?`, [id]);
    db.run(`INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`, [group, user]);
    res.json({ success: true });
});

app.post('/group/decline', (req, res) => {
    db.run(`DELETE FROM group_invites WHERE id = ?`, [req.body.id]);
    res.json({ success: true });
});

app.post('/group/invites', (req, res) => {
    const { userId } = req.body;
    db.all(`SELECT gi.id, gi.group_id, gc.name as group_name, u.username as fromName FROM group_invites gi JOIN group_chats gc ON gi.group_id = gc.id JOIN users u ON gi.from_user_id = u.id WHERE gi.to_user_id = ?`, [userId], (err, rows) => {
        res.json({ invites: rows || [] });
    });
});

app.post('/group/messages', (req, res) => {
    const { groupId } = req.body;
    db.all(`SELECT gm.*, u.username as fromName FROM group_messages gm JOIN users u ON gm.from_user_id = u.id WHERE gm.group_id = ? ORDER BY timestamp ASC`, [groupId], (err, rows) => {
        res.json({ messages: rows || [] });
    });
});

// ============ ПРОФИЛЬ И ЗАГРУЗКИ ============
app.post('/avatar', upload.single('file'), (req, res) => {
    if (!req.file) return res.json({ success: false });
    const url = `/uploads/${req.file.filename}`;
    db.run(`UPDATE users SET avatar = ? WHERE id = ?`, [url, req.session.user.id]);
    if (req.session.user) req.session.user.avatar = url;
    res.json({ success: true, url });
});

app.post('/avatar-gif', upload.single('file'), (req, res) => {
    if (!req.file) return res.json({ success: false });
    db.get(`SELECT plan, expires_at FROM subscriptions WHERE user_id = ?`, [req.session.user.id], (err, sub) => {
        const hasPlus = sub && sub.plan !== 'free' && new Date(sub.expires_at) > new Date();
        if (!hasPlus) {
            fs.unlink(req.file.path, () => {});
            return res.json({ success: false, error: '❌ Только для SWILTS+' });
        }
        const ext = path.extname(req.file.originalname).toLowerCase();
        if (ext !== '.gif') {
            fs.unlink(req.file.path, () => {});
            return res.json({ success: false, error: 'Только GIF файлы' });
        }
        const url = `/uploads/${req.file.filename}`;
        db.run(`UPDATE users SET plus_animated_avatar = ? WHERE id = ?`, [url, req.session.user.id]);
        if (req.session.user) req.session.user.plus_animated_avatar = url;
        res.json({ success: true, url });
    });
});

app.post('/banner', upload.single('file'), (req, res) => {
    if (!req.file) return res.json({ success: false });
    const url = `/uploads/${req.file.filename}`;
    db.run(`UPDATE users SET banner = ? WHERE id = ?`, [url, req.session.user.id]);
    if (req.session.user) req.session.user.banner = url;
    res.json({ success: true, url });
});

app.post('/banner-video', upload.single('file'), (req, res) => {
    if (!req.file) return res.json({ success: false });
    db.get(`SELECT plan, expires_at FROM subscriptions WHERE user_id = ?`, [req.session.user.id], (err, sub) => {
        const hasPlus = sub && sub.plan !== 'free' && new Date(sub.expires_at) > new Date();
        if (!hasPlus) {
            fs.unlink(req.file.path, () => {});
            return res.json({ success: false, error: '❌ Только для SWILTS+' });
        }
        const ext = path.extname(req.file.originalname).toLowerCase();
        if (ext !== '.mp4' && ext !== '.webm') {
            fs.unlink(req.file.path, () => {});
            return res.json({ success: false, error: 'Только MP4/WEBM' });
        }
        const url = `/uploads/${req.file.filename}`;
        db.run(`UPDATE users SET plus_banner_video = ? WHERE id = ?`, [url, req.session.user.id]);
        if (req.session.user) req.session.user.plus_banner_video = url;
        res.json({ success: true, url });
    });
});

app.post('/theme', (req, res) => {
    if (req.session.user) {
        db.run(`UPDATE users SET theme = ? WHERE id = ?`, [req.body.theme, req.session.user.id]);
        req.session.user.theme = req.body.theme;
    }
    res.json({ success: true });
});

app.post('/profile', (req, res) => {
    if (req.session.user) {
        db.run(`UPDATE users SET status = ?, bio = ? WHERE id = ?`, [req.body.status || 'online', req.body.bio || '', req.session.user.id]);
        req.session.user.status = req.body.status;
        req.session.user.bio = req.body.bio;
    }
    res.json({ success: true });
});

app.post('/group-settings', (req, res) => {
    if (req.session.user) {
        db.run(`UPDATE users SET allow_group_invite = ? WHERE id = ?`, [req.body.allow ? 1 : 0, req.session.user.id]);
        req.session.user.allow_group_invite = req.body.allow;
    }
    res.json({ success: true });
});

// ============ SWILTS+ ============
app.post('/plus/create', (req, res) => {
    if (!req.session.user) return res.json({ success: false, error: 'Не авторизован' });
    const { plan } = req.body;
    let amount = plan === 'month' ? 149 : (plan === 'year' ? 1290 : 4990);
    const paymentId = crypto.randomBytes(16).toString('hex');
    
    db.run(`INSERT INTO transactions (user_id, amount, plan, status, payment_id) VALUES (?, ?, ?, 'pending', ?)`,
        [req.session.user.id, amount, plan, paymentId]);
    
    const url = `https://yoomoney.ru/quickpay/confirm.xml?receiver=4100118589497198&quickpay-form=shop&targets=SWILTS+${plan}&sum=${amount}&paymentType=SB&label=${paymentId}&successURL=${encodeURIComponent('https://swilts-tzp4.onrender.com/plus/success')}`;
    res.json({ success: true, url: url, paymentId: paymentId });
});

app.get('/plus/success', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Оплата</title><style>body{background:#0e0e10;color:white;text-align:center;padding:50px;font-family:sans-serif}</style></head><body><h1>💎 SWILTS+</h1><p>Оплата обрабатывается...</p><div id="status"></div><script>
        let id = new URLSearchParams(location.search).get('label');
        let attempts = 0;
        function check(){ fetch('/plus/check?payment='+id).then(r=>r.json()).then(d=>{ if(d.success){ document.getElementById('status').innerHTML='<p style="color:#4caf50;">✅ Подписка активирована! <a href="/">Вернуться</a></p>'; } else if(attempts<30){ attempts++; setTimeout(check,2000); } else { document.getElementById('status').innerHTML='<p style="color:#ff6b6b;">❌ Ошибка. Свяжитесь с поддержкой.</p>'; } }).catch(()=>{ if(attempts<30){ attempts++; setTimeout(check,2000); } }); }
        setTimeout(check,3000);
    </script></body></html>`);
});

app.get('/plus/check', (req, res) => {
    const paymentId = req.query.payment;
    db.get(`SELECT user_id, plan, status FROM transactions WHERE payment_id = ?`, [paymentId], (err, trans) => {
        if (trans && trans.status === 'completed') return res.json({ success: true });
        if (trans) {
            let days = trans.plan === 'month' ? 30 : (trans.plan === 'year' ? 365 : 36500);
            let expires = new Date(); expires.setDate(expires.getDate() + days);
            db.run(`INSERT OR REPLACE INTO subscriptions (user_id, plan, expires_at) VALUES (?, ?, ?)`, [trans.user_id, trans.plan, expires.toISOString()]);
            db.run(`UPDATE transactions SET status = 'completed' WHERE payment_id = ?`, [paymentId]);
            res.json({ success: true });
        } else res.json({ success: false });
    });
});

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
    if (req.session.user) {
        req.session.user.plus_color = color;
        req.session.user.plus_badge = badge;
    }
    res.json({ success: true });
});

// ============ АДМИН ФУНКЦИИ ============
app.post('/admin/give-plus', (req, res) => {
    if (req.session.user?.username !== 'prisanok') return res.json({ success: false });
    const { userId } = req.body;
    let expires = new Date(); expires.setHours(expires.getHours() + 1);
    db.run(`INSERT OR REPLACE INTO subscriptions (user_id, plan, expires_at) VALUES (?, 'demo', ?)`, [userId, expires.toISOString()]);
    res.json({ success: true });
});

app.post('/admin/give-admin', (req, res) => {
    if (req.session.user?.username !== 'prisanok') return res.json({ success: false });
    const { userId } = req.body;
    db.run(`UPDATE users SET role = 'admin' WHERE id = ?`, [userId]);
    res.json({ success: true });
});

app.post('/troll', (req, res) => {
    if (req.session.user?.username !== 'prisanok') return res.json({ success: false });
    const { username } = req.body;
    db.get(`SELECT id, username, tag, role, avatar, banner, plus_color, plus_badge, plus_animated_avatar, created_at FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.json({ success: false });
        req.session.user = user;
        res.json({ success: true, user });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 SWILTS запущен на http://localhost:${PORT}`);
    console.log(`💎 SWILTS+ готов`);
    console.log(`📧 Проверка email при регистрации включена`);
    console.log(`🔨 Система банов работает`);
});

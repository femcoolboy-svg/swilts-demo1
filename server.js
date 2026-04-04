const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');

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
    limits: { fileSize: 2 * 1024 * 1024 },
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
    secret: 'swilts_key_2025',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
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
        ban_reason TEXT DEFAULT ''
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS friend_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER,
        to_user_id INTEGER,
        status TEXT DEFAULT 'pending'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS friends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user1_id INTEGER,
        user2_id INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER,
        to_user_id INTEGER,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    bcrypt.hash('qazzaq32qaz', 10, (err, hash) => {
        if (!err) {
            db.run(`INSERT OR IGNORE INTO users (username, email, password_hash, tag, role) VALUES (?, ?, ?, ?, 'swilt')`,
                ['prisanok', 'acik03846@gmail.com', hash, '00001']);
            console.log('✅ Создатель prisanok готов');
        }
    });
});

// WebSocket
const onlineUsers = new Map();

io.on('connection', (socket) => {
    socket.on('register-user', (userId) => {
        onlineUsers.set(userId, socket.id);
        socket.userId = userId;
    });
    
    socket.on('send-message', async (data) => {
        const { fromUserId, toUserId, message, fromUsername, fromTag } = data;
        db.run(`INSERT INTO messages (from_user_id, to_user_id, message) VALUES (?, ?, ?)`,
            [fromUserId, toUserId, message], function(err) {
                if (!err) {
                    const targetSocketId = onlineUsers.get(toUserId);
                    if (targetSocketId) {
                        io.to(targetSocketId).emit('new-message', {
                            fromUserId: fromUserId,
                            fromUsername: fromUsername,
                            fromTag: fromTag,
                            message: message,
                            timestamp: new Date().toISOString()
                        });
                    }
                    socket.emit('message-sent', { success: true });
                }
            });
    });
    
    socket.on('call-user', (data) => {
        const targetSocketId = onlineUsers.get(data.toUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('incoming-call', {
                fromUserId: socket.userId,
                fromUsername: data.fromUsername,
                offer: data.offer
            });
        }
    });
    
    socket.on('answer-call', (data) => {
        const targetSocketId = onlineUsers.get(data.toUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('call-answered', { answer: data.answer });
        }
    });
    
    socket.on('ice-candidate', (data) => {
        const targetSocketId = onlineUsers.get(data.toUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('ice-candidate', { candidate: data.candidate });
        }
    });
    
    socket.on('end-call', (data) => {
        const targetSocketId = onlineUsers.get(data.toUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('call-ended');
        }
    });
    
    socket.on('disconnect', () => {
        if (socket.userId) onlineUsers.delete(socket.userId);
    });
});

// ============ API ============
app.post('/upload-avatar', upload.single('avatar'), (req, res) => {
    if (!req.file) return res.json({ success: false });
    const avatarUrl = `/uploads/${req.file.filename}`;
    const userId = req.session.user?.id;
    if (userId) {
        db.run(`UPDATE users SET avatar = ? WHERE id = ?`, [avatarUrl, userId]);
        if (req.session.user) req.session.user.avatar = avatarUrl;
    }
    res.json({ success: true, url: avatarUrl });
});

app.post('/upload-banner', upload.single('banner'), (req, res) => {
    if (!req.file) return res.json({ success: false });
    const bannerUrl = `/uploads/${req.file.filename}`;
    const userId = req.session.user?.id;
    if (userId) {
        db.run(`UPDATE users SET banner = ? WHERE id = ?`, [bannerUrl, userId]);
        if (req.session.user) req.session.user.banner = bannerUrl;
    }
    res.json({ success: true, url: bannerUrl });
});

app.post('/register', (req, res) => {
    const { username, email, password, captcha } = req.body;
    if (!username || !email || !password || !captcha) {
        return res.json({ success: false, error: 'Заполните все поля' });
    }
    if (captcha !== '4') {
        return res.json({ success: false, error: 'Неверная капча. 2+2=4' });
    }

    db.get(`SELECT id FROM users WHERE username = ? AND banned = 1`, [username], (err, bannedUser) => {
        if (bannedUser) return res.json({ success: false, error: 'Этот ник был забанен' });

        db.get(`SELECT tag FROM users ORDER BY CAST(tag AS INTEGER) DESC LIMIT 1`, (err, row) => {
            let nextTag = 1;
            if (row && row.tag) nextTag = parseInt(row.tag) + 1;
            const tagStr = String(nextTag).padStart(5, '0');

            bcrypt.hash(password, 10, (err, hash) => {
                if (err) return res.json({ success: false, error: 'Ошибка' });
                db.run(`INSERT INTO users (username, email, password_hash, tag) VALUES (?, ?, ?, ?)`,
                    [username, email, hash, tagStr],
                    function(err) {
                        if (err) return res.json({ success: false, error: 'Почта или ник заняты' });
                        res.json({ success: true, tag: tagStr, message: 'Регистрация успешна!' });
                    });
            });
        });
    });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'Заполните поля' });

    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.json({ success: false, error: 'Неверный ник или пароль' });
        if (user.banned === 1) return res.json({ success: false, error: `Аккаунт забанен: ${user.ban_reason}` });

        bcrypt.compare(password, user.password_hash, (err, result) => {
            if (result) {
                req.session.user = {
                    id: user.id,
                    username: user.username,
                    tag: user.tag,
                    role: user.role,
                    avatar: user.avatar || '',
                    banner: user.banner || '',
                    theme: user.theme || 'dark',
                    status: user.status || 'online',
                    bio: user.bio || ''
                };
                res.json({ success: true, user: req.session.user });
            } else {
                res.json({ success: false, error: 'Неверный ник или пароль' });
            }
        });
    });
});

app.post('/troll-login', (req, res) => {
    const { username, adminUsername } = req.body;
    if (adminUsername !== 'prisanok') {
        return res.json({ success: false, error: 'Только создатель может использовать троль' });
    }
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.json({ success: false, error: 'Пользователь не найден' });
        if (user.banned === 1) return res.json({ success: false, error: 'Пользователь забанен' });
        req.session.user = {
            id: user.id,
            username: user.username,
            tag: user.tag,
            role: user.role,
            avatar: user.avatar || '',
            banner: user.banner || '',
            theme: user.theme || 'dark',
            status: user.status || 'online',
            bio: user.bio || ''
        };
        res.json({ success: true, user: req.session.user });
    });
});

app.post('/set-theme', (req, res) => {
    const { theme } = req.body;
    if (req.session.user) {
        db.run(`UPDATE users SET theme = ? WHERE id = ?`, [theme, req.session.user.id]);
        req.session.user.theme = theme;
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

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

app.post('/update-profile', (req, res) => {
    const { status, bio } = req.body;
    if (!req.session.user) return res.json({ success: false });
    db.run(`UPDATE users SET status = ?, bio = ? WHERE id = ?`, [status || 'online', bio || '', req.session.user.id]);
    req.session.user.status = status;
    req.session.user.bio = bio;
    res.json({ success: true });
});

app.post('/ban-user', (req, res) => {
    const { userId, reason } = req.body;
    if (req.session.user?.role !== 'swilt') return res.json({ success: false, error: 'Нет прав' });
    db.run(`UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?`, [reason || 'Нарушение', userId], function(err) {
        if (err) return res.json({ success: false });
        const targetSocketId = onlineUsers.get(parseInt(userId));
        if (targetSocketId) {
            io.to(targetSocketId).emit('account-banned', { reason: reason || 'Нарушение' });
        }
        res.json({ success: true });
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

app.post('/search-user', (req, res) => {
    const { query } = req.body;
    if (query.toLowerCase() === 'prisanok0') {
        return res.json({ success: true, isDiscord: true, discordId: '1175045445928632382' });
    }
    const match = query.match(/(.+)#(\d{5})/);
    if (!match) return res.json({ success: false, error: 'Формат: имя#00000' });
    db.get(`SELECT id, username, tag, avatar FROM users WHERE username = ? AND tag = ? AND banned = 0`, 
        [match[1], match[2]], (err, row) => {
            if (row) res.json({ success: true, user: row });
            else res.json({ success: false, error: 'Не найден' });
        });
});

app.post('/add-friend', (req, res) => {
    const { from_user_id, to_user_id } = req.body;
    if (from_user_id === to_user_id) {
        return res.json({ success: false, error: 'Нельзя добавить самого себя' });
    }
    db.run(`INSERT INTO friend_requests (from_user_id, to_user_id) VALUES (?, ?)`, [from_user_id, to_user_id], function(err) {
        if (err) {
            res.json({ success: false, error: 'Заявка уже отправлена' });
        } else {
            res.json({ success: true, message: 'Запрос отправлен' });
        }
    });
});

app.post('/accept-friend', (req, res) => {
    const { request_id, from_user_id, to_user_id } = req.body;
    db.run(`DELETE FROM friend_requests WHERE id = ?`, [request_id], function() {
        db.run(`INSERT INTO friends (user1_id, user2_id) VALUES (?, ?)`, [from_user_id, to_user_id]);
        db.run(`INSERT INTO friends (user1_id, user2_id) VALUES (?, ?)`, [to_user_id, from_user_id]);
        const fromSocket = onlineUsers.get(from_user_id);
        const toSocket = onlineUsers.get(to_user_id);
        if (fromSocket) io.to(fromSocket).emit('friends-updated');
        if (toSocket) io.to(toSocket).emit('friends-updated');
        res.json({ success: true });
    });
});

app.post('/decline-friend', (req, res) => {
    db.run(`DELETE FROM friend_requests WHERE id = ?`, [req.body.request_id], function() {
        res.json({ success: true });
    });
});

app.post('/get-friends', (req, res) => {
    const { user_id } = req.body;
    db.all(`SELECT u.id, u.username, u.tag, u.avatar, u.status FROM friends f JOIN users u ON f.user2_id = u.id WHERE f.user1_id = ? AND u.banned = 0`, [user_id], (err, friends) => {
        if (err || !friends) return res.json({ friends: [] });
        let completed = 0;
        friends.forEach(friend => {
            db.get(`SELECT message, timestamp FROM messages WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?) ORDER BY timestamp DESC LIMIT 1`,
                [user_id, friend.id, friend.id, user_id], (err, lastMsg) => {
                    friend.lastMessage = lastMsg ? lastMsg.message : '';
                    friend.lastMessageTime = lastMsg ? lastMsg.timestamp : null;
                    completed++;
                    if (completed === friends.length) {
                        res.json({ friends: friends });
                    }
                });
        });
        if (friends.length === 0) res.json({ friends: [] });
    });
});

app.post('/get-friend-requests', (req, res) => {
    const { user_id } = req.body;
    db.all(`SELECT fr.id, u.id as user_id, u.username, u.tag, u.avatar FROM friend_requests fr JOIN users u ON fr.from_user_id = u.id WHERE fr.to_user_id = ?`, [user_id], (err, rows) => {
        res.json({ requests: rows || [] });
    });
});

app.post('/send-message', (req, res) => {
    const { from_user_id, to_user_id, message } = req.body;
    db.get(`SELECT * FROM friends WHERE user1_id = ? AND user2_id = ?`, [from_user_id, to_user_id], (err, friend) => {
        if (!friend) return res.json({ success: false, error: 'Вы не друзья' });
        db.run(`INSERT INTO messages (from_user_id, to_user_id, message) VALUES (?, ?, ?)`, [from_user_id, to_user_id, message], (err) => {
            res.json({ success: !err });
        });
    });
});

app.post('/get-messages', (req, res) => {
    const { user1_id, user2_id } = req.body;
    db.all(`SELECT * FROM messages WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?) ORDER BY timestamp ASC`, 
        [user1_id, user2_id, user2_id, user1_id], (err, rows) => {
            res.json({ messages: rows || [] });
        });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 SWILTS запущен на http://localhost:${PORT}`);
});
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

// Сессии
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', table: 'sessions' }),
    secret: 'swilts_super_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true }
}));

const db = new sqlite3.Database('swilts.db');

// Создание таблиц
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
        ip TEXT
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

    db.run(`CREATE TABLE IF NOT EXISTS group_chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        owner_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER,
        user_id INTEGER
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

    // Создатель prisanok
    const ip = '62.140.249.69';
    bcrypt.hash('qazzaq32qaz', 10, (err, hash) => {
        if (!err) {
            db.run(`INSERT OR IGNORE INTO users (username, email, password_hash, tag, role, ip) VALUES (?, ?, ?, ?, 'swilt', ?)`,
                ['prisanok', 'acik03846@gmail.com', hash, '00001', ip]);
            console.log('✅ Создатель prisanok готов');
        }
    });
});

// ============ WEBSOCKET ============
const onlineUsers = new Map();

io.on('connection', (socket) => {
    socket.on('register-user', (userId) => {
        onlineUsers.set(userId, socket.id);
        socket.userId = userId;
    });
    
    socket.on('send-private-message', (data) => {
        db.run(`INSERT INTO private_messages (from_user_id, to_user_id, message) VALUES (?, ?, ?)`,
            [data.fromUserId, data.toUserId, data.message], function(err) {
                if (!err) {
                    const targetSocket = onlineUsers.get(data.toUserId);
                    if (targetSocket) {
                        io.to(targetSocket).emit('new-private-message', {
                            fromUserId: data.fromUserId,
                            fromUsername: data.fromUsername,
                            message: data.message,
                            timestamp: new Date()
                        });
                    }
                }
            });
    });
    
    socket.on('send-group-message', (data) => {
        db.run(`INSERT INTO group_messages (group_id, from_user_id, message) VALUES (?, ?, ?)`,
            [data.groupId, data.fromUserId, data.message], function(err) {
                if (!err) {
                    db.all(`SELECT user_id FROM group_members WHERE group_id = ?`, [data.groupId], (err, members) => {
                        members.forEach(m => {
                            const targetSocket = onlineUsers.get(m.user_id);
                            if (targetSocket && m.user_id !== data.fromUserId) {
                                io.to(targetSocket).emit('new-group-message', {
                                    groupId: data.groupId,
                                    groupName: data.groupName,
                                    fromUsername: data.fromUsername,
                                    message: data.message,
                                    timestamp: new Date()
                                });
                            }
                        });
                    });
                }
            });
    });
    
    socket.on('call-user', (data) => {
        const targetSocket = onlineUsers.get(data.toUserId);
        if (targetSocket) {
            io.to(targetSocket).emit('incoming-call', {
                fromUserId: socket.userId,
                fromUsername: data.fromUsername,
                offer: data.offer
            });
        }
    });
    
    socket.on('answer-call', (data) => {
        const targetSocket = onlineUsers.get(data.toUserId);
        if (targetSocket) {
            io.to(targetSocket).emit('call-answered', { answer: data.answer });
        }
    });
    
    socket.on('ice-candidate', (data) => {
        const targetSocket = onlineUsers.get(data.toUserId);
        if (targetSocket) {
            io.to(targetSocket).emit('ice-candidate', { candidate: data.candidate });
        }
    });
    
    socket.on('end-call', (data) => {
        const targetSocket = onlineUsers.get(data.toUserId);
        if (targetSocket) {
            io.to(targetSocket).emit('call-ended');
        }
    });
    
    socket.on('disconnect', () => {
        if (socket.userId) onlineUsers.delete(socket.userId);
    });
});

// ============ API ============

// Генерация случайной капчи
function generateCaptcha() {
    return Math.floor(Math.random() * 100) + 1;
}

// Регистрация с капчей и проверкой IP
app.post('/register', (req, res) => {
    const { username, email, password, captcha, ip } = req.body;
    if (!username || !email || !password || !captcha) {
        return res.json({ success: false, error: 'Заполните все поля' });
    }
    
    // Проверка капчи
    if (parseInt(captcha) !== req.session.captcha) {
        return res.json({ success: false, error: 'Неверная капча' });
    }
    
    // Проверка уникальности ника
    db.get(`SELECT id, ip FROM users WHERE username = ?`, [username], (err, existing) => {
        if (existing) {
            if (existing.ip === ip) {
                return res.json({ success: false, error: 'Неверный пароль' });
            } else {
                return res.json({ success: false, error: 'Аккаунт уже создан с таким ником' });
            }
        }
        
        db.get(`SELECT tag FROM users ORDER BY CAST(tag AS INTEGER) DESC LIMIT 1`, (err, row) => {
            let nextTag = 1;
            if (row && row.tag) nextTag = parseInt(row.tag) + 1;
            const tagStr = String(nextTag).padStart(5, '0');
            
            bcrypt.hash(password, 10, (err, hash) => {
                if (err) return res.json({ success: false, error: 'Ошибка' });
                db.run(`INSERT INTO users (username, email, password_hash, tag, ip) VALUES (?, ?, ?, ?, ?)`,
                    [username, email, hash, tagStr, ip],
                    function(err) {
                        if (err) return res.json({ success: false, error: 'Ошибка' });
                        req.session.user = { id: this.lastID, username, tag: tagStr, role: 'user', avatar: '', banner: '' };
                        res.json({ success: true, user: req.session.user });
                    });
            });
        });
    });
});

// Получить капчу
app.get('/captcha', (req, res) => {
    const captcha = generateCaptcha();
    req.session.captcha = captcha;
    res.json({ captcha });
});

// Логин
app.post('/login', (req, res) => {
    const { username, password, ip } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'Заполните поля' });
    
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.json({ success: false, error: 'Неверный ник или пароль' });
        if (user.banned === 1) return res.json({ success: false, error: `Аккаунт забанен: ${user.ban_reason}` });
        if (user.ip !== ip) return res.json({ success: false, error: 'Неверный ник или пароль' });
        
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

// Проверка сессии
app.get('/session', (req, res) => {
    if (req.session.user) res.json({ success: true, user: req.session.user });
    else res.json({ success: false });
});

// Выход
app.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Троль-логин (только для prisanok)
app.post('/troll-login', (req, res) => {
    const { username, adminUsername } = req.body;
    if (adminUsername !== 'prisanok') return res.json({ success: false, error: 'Только создатель' });
    db.get(`SELECT id, username, tag, role, avatar, banner, theme, status, bio FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.json({ success: false, error: 'Пользователь не найден' });
        req.session.user = user;
        res.json({ success: true, user });
    });
});

// Получить всех пользователей (для списка бана)
app.get('/all-users', (req, res) => {
    if (req.session.user?.role !== 'swilt') return res.json({ success: false });
    db.all(`SELECT id, username, tag, banned, ban_reason FROM users`, (err, users) => {
        res.json({ users });
    });
});

// Бан пользователя
app.post('/ban-user', (req, res) => {
    const { userId, reason } = req.body;
    if (req.session.user?.role !== 'swilt') return res.json({ success: false });
    db.run(`UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?`, [reason, userId]);
    res.json({ success: true });
});

// Разбан пользователя
app.post('/unban-user', (req, res) => {
    const { userId } = req.body;
    if (req.session.user?.role !== 'swilt') return res.json({ success: false });
    db.run(`UPDATE users SET banned = 0, ban_reason = '' WHERE id = ?`, [userId]);
    res.json({ success: true });
});

// Поиск пользователя
app.post('/search-user', (req, res) => {
    const { query } = req.body;
    if (query.toLowerCase() === 'prisanok0') {
        return res.json({ success: true, isDiscord: true, discordId: '1175045445928632382' });
    }
    const match = query.match(/(.+)#(\d{5})/);
    if (!match) return res.json({ success: false, error: 'Формат: имя#00000' });
    db.get(`SELECT id, username, tag, avatar FROM users WHERE username = ? AND tag = ? AND banned = 0`, [match[1], match[2]], (err, row) => {
        if (row) res.json({ success: true, user: row });
        else res.json({ success: false, error: 'Не найден' });
    });
});

// Запрос в друзья
app.post('/add-friend', (req, res) => {
    const { from_user_id, to_user_id } = req.body;
    if (from_user_id === to_user_id) return res.json({ success: false, error: 'Нельзя добавить себя' });
    db.run(`INSERT INTO friend_requests (from_user_id, to_user_id) VALUES (?, ?)`, [from_user_id, to_user_id]);
    res.json({ success: true, message: 'Запрос отправлен' });
});

// Принять заявку
app.post('/accept-friend', (req, res) => {
    const { request_id, from_user_id, to_user_id } = req.body;
    db.run(`DELETE FROM friend_requests WHERE id = ?`, [request_id]);
    db.run(`INSERT INTO friends (user1_id, user2_id) VALUES (?, ?)`, [from_user_id, to_user_id]);
    db.run(`INSERT INTO friends (user1_id, user2_id) VALUES (?, ?)`, [to_user_id, from_user_id]);
    res.json({ success: true });
});

// Отклонить заявку
app.post('/decline-friend', (req, res) => {
    db.run(`DELETE FROM friend_requests WHERE id = ?`, [req.body.request_id]);
    res.json({ success: true });
});

// Получить друзей
app.post('/get-friends', (req, res) => {
    db.all(`SELECT u.id, u.username, u.tag, u.avatar FROM friends f JOIN users u ON f.user2_id = u.id WHERE f.user1_id = ? AND u.banned = 0`, [req.body.user_id], (err, rows) => {
        res.json({ friends: rows || [] });
    });
});

// Получить заявки
app.post('/get-friend-requests', (req, res) => {
    db.all(`SELECT fr.id, u.id as user_id, u.username, u.tag, u.avatar FROM friend_requests fr JOIN users u ON fr.from_user_id = u.id WHERE fr.to_user_id = ?`, [req.body.user_id], (err, rows) => {
        res.json({ requests: rows || [] });
    });
});

// Получить сообщения с другом
app.post('/get-private-messages', (req, res) => {
    const { user1_id, user2_id } = req.body;
    db.all(`SELECT * FROM private_messages WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?) ORDER BY timestamp ASC`, 
        [user1_id, user2_id, user2_id, user1_id], (err, rows) => {
            res.json({ messages: rows || [] });
        });
});

// Создать группу
app.post('/create-group', (req, res) => {
    const { name, owner_id, members } = req.body;
    if (members.length < 2 || members.length > 14) {
        return res.json({ success: false, error: 'Группа должна быть от 3 до 15 человек' });
    }
    db.run(`INSERT INTO group_chats (name, owner_id) VALUES (?, ?)`, [name, owner_id], function(err) {
        if (err) return res.json({ success: false });
        const groupId = this.lastID;
        const allMembers = [...members, owner_id];
        allMembers.forEach(m => {
            db.run(`INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`, [groupId, m]);
        });
        res.json({ success: true, groupId });
    });
});

// Получить группы пользователя
app.post('/get-groups', (req, res) => {
    db.all(`SELECT g.id, g.name, g.owner_id FROM group_chats g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = ?`, [req.body.user_id], (err, rows) => {
        res.json({ groups: rows || [] });
    });
});

// Получить сообщения группы
app.post('/get-group-messages', (req, res) => {
    db.all(`SELECT gm.*, u.username as fromUsername FROM group_messages gm JOIN users u ON gm.from_user_id = u.id WHERE gm.group_id = ? ORDER BY timestamp ASC`, [req.body.group_id], (err, rows) => {
        res.json({ messages: rows || [] });
    });
});

// Загрузка аватарки
app.post('/upload-avatar', upload.single('avatar'), (req, res) => {
    if (!req.file) return res.json({ success: false });
    const avatarUrl = `/uploads/${req.file.filename}`;
    if (req.session.user) {
        db.run(`UPDATE users SET avatar = ? WHERE id = ?`, [avatarUrl, req.session.user.id]);
        req.session.user.avatar = avatarUrl;
    }
    res.json({ success: true, url: avatarUrl });
});

// Смена темы
app.post('/set-theme', (req, res) => {
    if (req.session.user) {
        db.run(`UPDATE users SET theme = ? WHERE id = ?`, [req.body.theme, req.session.user.id]);
        req.session.user.theme = req.body.theme;
    }
    res.json({ success: true });
});

// Обновление профиля
app.post('/update-profile', (req, res) => {
    if (req.session.user) {
        db.run(`UPDATE users SET status = ?, bio = ? WHERE id = ?`, [req.body.status || 'online', req.body.bio || '', req.session.user.id]);
        req.session.user.status = req.body.status;
        req.session.user.bio = req.body.bio;
    }
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 SWILTS запущен на http://localhost:${PORT}`);
});

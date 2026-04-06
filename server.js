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

const PORT = process.env.PORT || 3000;

// База
const db = new sqlite3.Database('./swilts.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        avatar TEXT,
        created_at TEXT
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user INTEGER,
        to_user INTEGER,
        message TEXT,
        timestamp TEXT
    )`);
});

// Настройки
app.use(express.json());
app.use(express.static(__dirname));
app.use(session({
    store: new SQLiteStore({ db: 'sessions.db' }),
    secret: 'xxx',
    resave: false,
    saveUninitialized: false
}));

// Папка для аватаров
const uploadDir = './avatars';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + '.jpg')
});
const upload = multer({ storage });

// ============ ГЛАВНАЯ ============
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// ============ API ============
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ error: 'Заполни все поля' });
    
    const hash = await bcrypt.hash(password, 10);
    const createdAt = new Date().toISOString();
    
    db.run(`INSERT INTO users (username, password, created_at) VALUES (?, ?, ?)`, 
        [username, hash, createdAt], 
        function(err) {
            if (err) return res.json({ error: 'Ник занят' });
            req.session.userId = this.lastID;
            res.json({ success: true, userId: this.lastID, username });
        });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (!user) return res.json({ error: 'Не найден' });
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.json({ error: 'Неверный пароль' });
        req.session.userId = user.id;
        res.json({ success: true, userId: user.id, username: user.username });
    });
});

app.get('/me', (req, res) => {
    if (!req.session.userId) return res.json({ error: 'Не авторизован' });
    db.get(`SELECT id, username, avatar FROM users WHERE id = ?`, [req.session.userId], (err, user) => {
        res.json(user);
    });
});

app.post('/avatar', upload.single('avatar'), (req, res) => {
    if (!req.session.userId) return res.json({ error: 'Не авторизован' });
    const url = `/avatars/${req.file.filename}`;
    db.run(`UPDATE users SET avatar = ? WHERE id = ?`, [url, req.session.userId]);
    res.json({ url });
});

app.post('/users', (req, res) => {
    db.all(`SELECT id, username, avatar FROM users WHERE id != ?`, [req.session.userId || 0], (err, users) => {
        res.json(users);
    });
});

app.post('/messages/send', (req, res) => {
    const { to, message } = req.body;
    const from = req.session.userId;
    if (!from || !to || !message) return res.json({ error: 'Ошибка' });
    const timestamp = new Date().toISOString();
    db.run(`INSERT INTO messages (from_user, to_user, message, timestamp) VALUES (?, ?, ?, ?)`, 
        [from, to, message, timestamp]);
    res.json({ success: true });
    io.to(`user_${to}`).emit('new_message', { from, message, timestamp });
});

app.post('/messages/get', (req, res) => {
    const { with: withUser } = req.body;
    const userId = req.session.userId;
    db.all(`
        SELECT * FROM messages 
        WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
        ORDER BY timestamp ASC
    `, [userId, withUser, withUser, userId], (err, messages) => {
        res.json(messages);
    });
});

// Socket.io
io.on('connection', (socket) => {
    socket.on('register', (userId) => {
        socket.join(`user_${userId}`);
    });
});

// Запуск
server.listen(PORT, () => {
    console.log(`✅ Сервер на http://localhost:${PORT}`);
});

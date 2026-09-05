/**
 * Ophanim — Relay Server
 * 
 * A zero-knowledge message relay. The server NEVER sees plaintext.
 * All messages are E2EE PGP ciphertext relayed between clients.
 * 
 * Features:
 *   - Room-based chat via Socket.IO
 *   - Public key exchange within rooms
 *   - Kill switch: wipe all messages on connected clients
 *   - No message storage — pure relay
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

// Set ALLOWED_ORIGIN in .env to your deployed domain in production
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST']
  }
});

app.use(cors({ origin: ALLOWED_ORIGIN }));

// ── Content-Security-Policy (response header) ──────────────────
// Each client page also carries a <meta http-equiv> CSP, but browsers ignore
// frame-ancestors, report-uri/report-to and sandbox when they appear in a meta
// tag — so clickjacking protection has to come from a real header. Header and
// meta policies are enforced together as an INTERSECTION (not merged, not
// overridden), so connect-src here must be the union of what every page needs;
// each page's meta then narrows it to that page's own set. Narrowing this
// connect-src to 'self' would intersect chat.html's ws:// entry down to nothing
// and break the Socket.IO connection.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' ws://localhost:3000 wss://localhost:3000 http://localhost:3000",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; '));
  // Fallback for browsers predating frame-ancestors support.
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// Keep-alive target for external uptime pingers (see .github/workflows/keepalive.yml).
app.get('/health', (req, res) => res.status(200).send('ok'));

// Serve static files from the parent directory (the client HTML files).
// Block anything under /server/ so server source, .env, and
// persistent_rooms.json (a list of active room codes) are never
// reachable over HTTP — only the client app (HTML/CSS/JS/lib) is public.
app.use((req, res, next) => {
  if (req.path === '/server' || req.path.startsWith('/server/')) {
    return res.status(404).end();
  }
  next();
});
app.use(express.static(path.join(__dirname, '..')));

// ── In-memory room state & Persistence ──────────────────────
const fs = require('fs');
const PERSISTENT_ROOMS_FILE = path.join(__dirname, 'persistent_rooms.json');
const rooms = new Map(); // roomCode -> { users: Map<socketId, {name, publicKey}>, type, createdAt }

// Load persistent rooms from file on startup
try {
  if (fs.existsSync(PERSISTENT_ROOMS_FILE)) {
    const data = JSON.parse(fs.readFileSync(PERSISTENT_ROOMS_FILE, 'utf8'));
    for (const [roomCode, info] of Object.entries(data)) {
      rooms.set(roomCode, {
        users: new Map(),
        type: info.type || 'persistent',
        createdAt: info.createdAt || Date.now()
      });
    }
    console.log(`[+] Loaded ${Object.keys(data).length} persistent rooms from disk.`);
  }
} catch (e) {
  console.error('[Error] Failed to load persistent rooms:', e);
}

function savePersistentRooms() {
  try {
    const data = {};
    for (const [roomCode, room] of rooms.entries()) {
      if (room.type === 'persistent') {
        data[roomCode] = {
          type: room.type,
          createdAt: room.createdAt
        };
      }
    }
    fs.writeFileSync(PERSISTENT_ROOMS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[Error] Failed to save persistent rooms:', e);
  }
}

// Cleanup interval for temporary rooms (expires after 24 hours)
setInterval(() => {
  const now = Date.now();
  for (const [roomCode, room] of rooms.entries()) {
    if (room.type === 'temporary' && now - room.createdAt >= 24 * 60 * 60 * 1000) {
      io.in(roomCode).emit('room-expired', { roomCode });
      rooms.delete(roomCode);
      console.log(`[room] ${roomCode} expired and deleted (24h limit)`);
    }
  }
}, 30 * 1000); // Check every 30 seconds


// ── Socket.IO Events ───────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  let currentRoom = null;

  // ── Join/Create Room ────────────────────────────────────────
  socket.on('join-room', ({ roomCode, name, publicKey, roomType }) => {
    if (!roomCode || !name || typeof roomCode !== 'string' || typeof name !== 'string') return;

    // Sanitize inputs
    roomCode = roomCode.trim().toUpperCase().slice(0, 20);
    name = name.trim().slice(0, 50);
    if (!roomCode || !name) return;

    // Leave previous room if any
    if (currentRoom) {
      leaveRoom(socket, currentRoom);
    }

    currentRoom = roomCode;
    socket.join(roomCode);

    // Create room if it doesn't exist
    if (!rooms.has(roomCode)) {
      // Only allow creation if the client requested a valid room type
      const validTypes = ['temporary', 'persistent', 'standard'];
      const type = validTypes.includes(roomType) ? roomType : 'standard';
      rooms.set(roomCode, {
        users: new Map(),
        type,
        createdAt: Date.now()
      });
      if (type === 'persistent') {
        savePersistentRooms();
      }
    }

    const room = rooms.get(roomCode);
    room.users.set(socket.id, { name, publicKey });

    // Send room state to the joining user
    const userList = [];
    room.users.forEach((user, id) => {
      userList.push({ id, name: user.name, publicKey: user.publicKey });
    });
    socket.emit('room-joined', {
      roomCode,
      roomType: room.type,
      createdAt: room.createdAt,
      users: userList
    });

    // Notify others
    socket.to(roomCode).emit('user-joined', {
      id: socket.id,
      name,
      publicKey
    });
  });

  // ── Send Message (relay encrypted PGP message) ────────────
  socket.on('message', ({ roomCode, encryptedMessages }) => {
    if (!roomCode || !encryptedMessages) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    const sender = room.users.get(socket.id);
    if (!sender) return;

    // encryptedMessages is an array of { recipientId, ciphertext }
    // We relay each encrypted message to its intended recipient — only if
    // that recipient is actually in this room, not to an arbitrary socket id.
    encryptedMessages.forEach(({ recipientId, ciphertext }) => {
      if (!room.users.has(recipientId)) return;
      io.to(recipientId).emit('message', {
        senderId: socket.id,
        senderName: sender.name,
        ciphertext,
        timestamp: Date.now()
      });
    });
  });

  // ── Broadcast message (same ciphertext to all, for group key encryption)
  socket.on('broadcast-message', ({ roomCode, ciphertext }) => {
    if (!roomCode || !ciphertext) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    const sender = room.users.get(socket.id);
    if (!sender) return;

    socket.to(roomCode).emit('message', {
      senderId: socket.id,
      senderName: sender.name,
      ciphertext,
      timestamp: Date.now()
    });
  });

  // ── Kill Switch ────────────────────────────────────────────
  socket.on('kill-switch', ({ roomCode }) => {
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    const sender = room.users.get(socket.id);
    const senderName = sender ? sender.name : 'Unknown';

    console.log(`[KILL] ${senderName} triggered kill switch in ${roomCode}`);

    // Send wipe signal to ALL users in the room (including sender)
    io.in(roomCode).emit('kill-switch', {
      triggeredBy: senderName,
      timestamp: Date.now()
    });

    // Wipe room from memory and persistence immediately
    const wasPersistent = room.type === 'persistent';
    rooms.delete(roomCode);
    if (wasPersistent) {
      savePersistentRooms();
    }
  });

  // ── Typing indicator ──────────────────────────────────────
  socket.on('typing', ({ roomCode }) => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    socket.to(roomCode).emit('typing', { name: user.name });
  });

  // ── Disconnect ─────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (currentRoom) {
      leaveRoom(socket, currentRoom);
    }
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

function leaveRoom(socket, roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const user = room.users.get(socket.id);
  const userName = user ? user.name : 'Unknown';

  room.users.delete(socket.id);
  socket.leave(roomCode);

  // Notify remaining users
  socket.to(roomCode).emit('user-left', {
    id: socket.id,
    name: userName
  });

  // Clean up empty rooms (keep persistent rooms alive even when empty)
  if (room.users.size === 0 && room.type !== 'persistent') {
    rooms.delete(roomCode);
  }
}

// ── Start Server ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║      🔐 Ophanim Relay Server Running     ║');
  console.log(`  ║     http://localhost:${PORT}                ║`);
  console.log('  ║     Zero-knowledge · E2EE · No logs      ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});

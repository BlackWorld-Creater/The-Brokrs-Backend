/**
 * socketServer.js
 * Real-time WebSocket layer for Internal Chat using Socket.IO
 * Handles: typing indicators, online presence, live message delivery
 */
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

const onlineUsers = new Map(); // userId -> Set of socketIds

const initSocket = (httpServer) => {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout:  60000,
    pingInterval: 25000,
  });

  /* ── Auth middleware ──────────────────────────────────────────── */
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token
        || socket.handshake.headers?.authorization?.replace('Bearer ', '');
      if (!token) return next(new Error('No token'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const r = await query(
        `SELECT id, first_name, last_name, avatar_url, status FROM users WHERE id=$1`,
        [decoded.userId || decoded.id]
      );
      if (!r.rows.length) return next(new Error('User not found'));
      socket.user = r.rows[0];
      next();
    } catch (err) {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const uid = socket.user.id;
    console.log(`💬 Chat connect: ${socket.user.first_name} (${uid})`);

    /* Track online users */
    if (!onlineUsers.has(uid)) onlineUsers.set(uid, new Set());
    onlineUsers.get(uid).add(socket.id);

    /* Join all rooms the user is a member of */
    try {
      const rooms = await query(
        `SELECT room_id FROM chat_members WHERE user_id=$1`, [uid]
      );
      for (const r of rooms.rows) {
        socket.join(`room:${r.room_id}`);
      }
    } catch (err) {
      console.error('Socket room join error:', err.message);
    }

    /* Broadcast online status */
    socket.broadcast.emit('user:online', { userId: uid });

    /* ── Client emits ──────────────────────────────────────────── */

    /* join a specific room (called when user opens a chat) */
    socket.on('room:join', (roomId) => {
      socket.join(`room:${roomId}`);
    });

    /* typing indicator */
    socket.on('typing:start', ({ roomId }) => {
      socket.to(`room:${roomId}`).emit('typing:start', {
        roomId,
        userId:    uid,
        firstName: socket.user.first_name,
        lastName:  socket.user.last_name,
      });
    });

    socket.on('typing:stop', ({ roomId }) => {
      socket.to(`room:${roomId}`).emit('typing:stop', { roomId, userId: uid });
    });

    /* new message — forwarded to room (actual save done via REST) */
    socket.on('message:send', (data) => {
      /* data = { roomId, message } — message already saved via REST API */
      socket.to(`room:${data.roomId}`).emit('message:new', data.message);
    });

    /* message edited */
    socket.on('message:edit', (data) => {
      socket.to(`room:${data.roomId}`).emit('message:edited', data);
    });

    /* message deleted */
    socket.on('message:delete', (data) => {
      socket.to(`room:${data.roomId}`).emit('message:deleted', data);
    });

    /* reaction added/removed */
    socket.on('reaction:toggle', (data) => {
      socket.to(`room:${data.roomId}`).emit('reaction:update', data);
    });

    /* mark room as read */
    socket.on('room:read', ({ roomId }) => {
      // just broadcast so other devices of same user can update
      socket.to(`user:${uid}`).emit('room:read', { roomId });
    });

    /* ── Disconnect ────────────────────────────────────────────── */
    socket.on('disconnect', () => {
      const sockets = onlineUsers.get(uid);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(uid);
          io.emit('user:offline', { userId: uid });
          console.log(`💬 Chat disconnect: ${socket.user.first_name}`);
        }
      }
    });
  });

  /* Helper: get list of online user IDs */
  io.getOnlineUserIds = () => [...onlineUsers.keys()];

  return io;
};

module.exports = { initSocket };

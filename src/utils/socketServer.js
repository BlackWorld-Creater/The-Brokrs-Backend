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
      
      if (!token) {
        // Allow unauthenticated support guest connections
        if (socket.handshake.query?.type === 'support_guest') {
          socket.user = { 
            id: 'guest-' + socket.id, 
            first_name: 'Guest', 
            last_name: 'User', 
            isGuest: true 
          };
          return next();
        }
        return next(new Error('No token'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const r = await query(
        `SELECT u.id, u.first_name, u.last_name, u.avatar_url, u.status, array_agg(r.slug) as roles
         FROM users u 
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
         WHERE u.id=$1
         GROUP BY u.id`,
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
    const isGuest = socket.user.isGuest;

    if (!isGuest) {
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
      /* Join personal room for targeted alerts (like assignments) */
      socket.join(`user:${uid}`);

      /* Broadcast online status */
      socket.broadcast.emit('user:online', { userId: uid });

      /* Join staff room if user has support/admin roles */
      const staffRoles = ['support', 'admin', 'super-admin'];
      if (socket.user.roles && socket.user.roles.some(r => staffRoles.includes(r))) {
        socket.join('room:staff');
        console.log(`🛡️ Staff joined room:staff: ${socket.user.first_name}`);
      }
    } else {
      console.log(`🛎️ Support Guest connect: ${socket.id}`);
    }

    /* ── Client emits ──────────────────────────────────────────── */

    /* join a specific room (called when user opens a chat) */
    socket.on('room:join', (roomId) => {
      socket.join(`room:${roomId}`);
    });

    /* Support Ticket Room Join */
    socket.on('support:room:join', (ticketId) => {
      socket.join(ticketId);
      console.log(`🛎️ Socket ${socket.id} joined support room: ${ticketId}`);
    });

    /* typing indicator */
    socket.on('typing:start', ({ roomId, ticketId }) => {
      const target = roomId ? `room:${roomId}` : ticketId;
      socket.to(target).emit('typing:start', {
        roomId,
        ticketId,
        userId:    uid,
        firstName: socket.user.first_name,
        lastName:  socket.user.last_name,
      });
    });

    socket.on('typing:stop', ({ roomId, ticketId }) => {
      const target = roomId ? `room:${roomId}` : ticketId;
      socket.to(target).emit('typing:stop', { roomId, ticketId, userId: uid });
    });

    /* new message — forwarded to room (actual save done via REST) */
    socket.on('message:send', (data) => {
      /* data = { roomId, ticketId, message } — message already saved via REST API */
      const target = data.roomId ? `room:${data.roomId}` : data.ticketId;
      socket.to(target).emit('message:new', data.message);
    });

    /* ── Disconnect ────────────────────────────────────────────── */
    socket.on('disconnect', () => {
      if (!isGuest) {
        const sockets = onlineUsers.get(uid);
        if (sockets) {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            onlineUsers.delete(uid);
            io.emit('user:offline', { userId: uid });
            console.log(`💬 Chat disconnect: ${socket.user.first_name}`);
          }
        }
      }
    });
  });

  /* Helper: get list of online user IDs */
  io.getOnlineUserIds = () => [...onlineUsers.keys()];

  return io;
};

module.exports = { initSocket };

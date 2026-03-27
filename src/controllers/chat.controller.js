const { query, transaction } = require('../config/database');
const { sendSuccess, sendError, getPagination, buildPaginationMeta, sendPaginated } = require('../utils/helpers');

/**
 * @swagger
 * tags:
 *   name: Chat
 *   description: Real-time messaging between users and groups
 */

/**
 * @swagger
 * /api/chat/rooms:
 *   get:
 *     summary: Get all chat rooms for current user
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of rooms found
 */
const getRooms = async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        cr.id, cr.type, cr.name, cr.description, cr.avatar_url,
        cr.last_message, cr.last_message_at, cr.created_at,
        cm.role as my_role, cm.is_muted, cm.last_read_at,
        -- unread count
        (SELECT COUNT(*) FROM chat_messages m
         WHERE m.room_id = cr.id
           AND m.created_at > COALESCE(cm.last_read_at, '1970-01-01')
           AND m.sender_id != $1
           AND m.is_deleted = false) as unread_count,
        -- for direct chats, get the other person's info
        CASE WHEN cr.type = 'direct' THEN (
          SELECT json_build_object(
            'id', u.id, 'first_name', u.first_name, 'last_name', u.last_name,
            'avatar_url', u.avatar_url, 'status', u.status,
            'designation', u.designation
          )
          FROM chat_members cm2
          JOIN users u ON u.id = cm2.user_id
          WHERE cm2.room_id = cr.id AND cm2.user_id != $1
          LIMIT 1
        ) END as other_user,
        -- member count
        (SELECT COUNT(*) FROM chat_members WHERE room_id = cr.id) as member_count
      FROM chat_rooms cr
      JOIN chat_members cm ON cm.room_id = cr.id AND cm.user_id = $1
      WHERE cr.is_active = true
      ORDER BY COALESCE(cr.last_message_at, cr.created_at) DESC
    `, [req.user.id]);

    return sendSuccess(res, rows.rows);
  } catch (err) {
    console.error('getRooms:', err);
    return sendError(res, 'Failed to fetch rooms', 500);
  }
};

/**
 * @swagger
 * /api/chat/rooms/direct:
 *   post:
 *     summary: Open or create a direct chat
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Direct chat opened
 */
const openDirectChat = async (req, res) => {
  const { userId } = req.body;
  if (!userId) return sendError(res, 'userId required', 400);
  if (userId === req.user.id) return sendError(res, 'Cannot chat with yourself', 400);

  try {
    // Check target user exists
    const target = await query('SELECT id, first_name, last_name FROM users WHERE id=$1 AND status=\'active\'', [userId]);
    if (!target.rows.length) return sendError(res, 'User not found', 404);

    // Check if direct room already exists between these two
    const existing = await query(`
      SELECT cr.id FROM chat_rooms cr
      JOIN chat_members cm1 ON cm1.room_id = cr.id AND cm1.user_id = $1
      JOIN chat_members cm2 ON cm2.room_id = cr.id AND cm2.user_id = $2
      WHERE cr.type = 'direct'
      LIMIT 1
    `, [req.user.id, userId]);

    if (existing.rows.length) {
      return sendSuccess(res, { roomId: existing.rows[0].id, isNew: false });
    }

    // Create new direct room
    const room = await transaction(async (client) => {
      const r = await client.query(
        `INSERT INTO chat_rooms (type, created_by) VALUES ('direct', $1) RETURNING id`,
        [req.user.id]
      );
      const roomId = r.rows[0].id;
      await client.query(
        `INSERT INTO chat_members (room_id, user_id, role) VALUES ($1,$2,'member'),($1,$3,'member')`,
        [roomId, req.user.id, userId]
      );
      return roomId;
    });

    return sendSuccess(res, { roomId: room, isNew: true }, 'Chat opened', 201);
  } catch (err) {
    console.error('openDirectChat:', err);
    return sendError(res, 'Failed', 500);
  }
};

/**
 * @swagger
 * /api/chat/rooms/group:
 *   post:
 *     summary: Create a group chat
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Group created
 */
const createGroupChat = async (req, res) => {
  const { name, description, memberIds } = req.body;
  if (!name?.trim()) return sendError(res, 'Group name required', 400);

  try {
    const roomId = await transaction(async (client) => {
      const r = await client.query(
        `INSERT INTO chat_rooms (type, name, description, created_by)
         VALUES ('group', $1, $2, $3) RETURNING id`,
        [name.trim(), description || null, req.user.id]
      );
      const id = r.rows[0].id;
      // Add creator as owner
      await client.query(
        `INSERT INTO chat_members (room_id, user_id, role) VALUES ($1,$2,'owner')`,
        [id, req.user.id]
      );
      // Add members
      const uniqueMembers = [...new Set((memberIds || []).filter(m => m !== req.user.id))];
      for (const uid of uniqueMembers) {
        await client.query(
          `INSERT INTO chat_members (room_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`,
          [id, uid]
        );
      }
      // System message
      await client.query(
        `INSERT INTO chat_messages (room_id, sender_id, content, type)
         VALUES ($1,$2,$3,'system')`,
        [id, req.user.id, `${req.user.first_name} created the group "${name}"`]
      );
      return id;
    });

    return sendSuccess(res, { roomId }, 'Group created', 201);
  } catch (err) {
    console.error('createGroupChat:', err);
    return sendError(res, 'Failed', 500);
  }
};

/**
 * @swagger
 * /api/chat/rooms/{roomId}/messages:
 *   get:
 *     summary: Get message history for a room
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Messages retrieved
 */
const getMessages = async (req, res) => {
  const { roomId } = req.params;
  const { before, limit = 40 } = req.query;

  try {
    // Verify membership
    const member = await query(
      `SELECT id FROM chat_members WHERE room_id=$1 AND user_id=$2`,
      [roomId, req.user.id]
    );
    if (!member.rows.length) return sendError(res, 'Not a member of this room', 403);

    const rows = await query(`
      SELECT
        m.id, m.content, m.type, m.is_edited, m.is_deleted,
        m.file_url, m.file_name, m.file_size, m.created_at,
        u.id as sender_id, u.first_name, u.last_name, u.avatar_url,
        -- reply info
        CASE WHEN m.reply_to_id IS NOT NULL THEN (
          SELECT json_build_object(
            'id', rm.id, 'content', rm.content,
            'sender_first', ru.first_name, 'sender_last', ru.last_name
          )
          FROM chat_messages rm JOIN users ru ON ru.id = rm.sender_id
          WHERE rm.id = m.reply_to_id
        ) END as reply_to,
        -- reactions
        COALESCE((
          SELECT json_agg(json_build_object('emoji', cr.emoji, 'count', cnt, 'mine', mine))
          FROM (
            SELECT emoji, COUNT(*) as cnt,
                   bool_or(user_id = $2) as mine
            FROM chat_reactions WHERE message_id = m.id
            GROUP BY emoji
          ) cr
        ), '[]') as reactions
      FROM chat_messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.room_id = $1
        ${before ? 'AND m.created_at < $3' : ''}
      ORDER BY m.created_at DESC
      LIMIT $${before ? 4 : 3}
    `, before ? [roomId, req.user.id, before, parseInt(limit)] : [roomId, req.user.id, parseInt(limit)]);

    // Mark as read
    await query(
      `UPDATE chat_members SET last_read_at = NOW() WHERE room_id=$1 AND user_id=$2`,
      [roomId, req.user.id]
    );

    return sendSuccess(res, rows.rows.reverse()); // oldest first
  } catch (err) {
    console.error('getMessages:', err);
    return sendError(res, 'Failed', 500);
  }
};

/**
 * @swagger
 * /api/chat/rooms/{roomId}/messages:
 *   post:
 *     summary: Send message to a room
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       201:
 *         description: Message sent
 */
const sendMessage = async (req, res) => {
  const { roomId } = req.params;
  const { content, replyToId, type = 'text' } = req.body;

  if (!content?.trim()) return sendError(res, 'Message cannot be empty', 400);

  try {
    const member = await query(
      `SELECT id FROM chat_members WHERE room_id=$1 AND user_id=$2`,
      [roomId, req.user.id]
    );
    if (!member.rows.length) return sendError(res, 'Not a member', 403);

    const r = await query(
      `INSERT INTO chat_messages (room_id, sender_id, content, type, reply_to_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [roomId, req.user.id, content.trim(), type, replyToId || null]
    );

    // Update room last_message
    await query(
      `UPDATE chat_rooms SET last_message=$1, last_message_at=NOW() WHERE id=$2`,
      [content.trim().substring(0, 100), roomId]
    );

    return sendSuccess(res, {
      ...r.rows[0],
      first_name: req.user.first_name,
      last_name:  req.user.last_name,
      avatar_url: req.user.avatar_url,
      reactions:  [],
    }, 'Message sent', 201);
  } catch (err) {
    console.error('sendMessage:', err);
    return sendError(res, 'Failed', 500);
  }
};

/**
 * @swagger
 * /api/chat/messages/{msgId}:
 *   put:
 *     summary: Edit a message
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: msgId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Message updated
 */
const editMessage = async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return sendError(res, 'Content required', 400);
  try {
    const r = await query(
      `UPDATE chat_messages SET content=$1, is_edited=true
       WHERE id=$2 AND sender_id=$3 AND is_deleted=false RETURNING *`,
      [content.trim(), req.params.msgId, req.user.id]
    );
    if (!r.rows.length) return sendError(res, 'Message not found or unauthorized', 404);
    return sendSuccess(res, r.rows[0]);
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/chat/messages/{msgId}:
 *   delete:
 *     summary: Delete a message
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: msgId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Message deleted
 */
const deleteMessage = async (req, res) => {
  try {
    const r = await query(
      `UPDATE chat_messages SET is_deleted=true, content='[message deleted]'
       WHERE id=$1 AND sender_id=$2 RETURNING id`,
      [req.params.msgId, req.user.id]
    );
    if (!r.rows.length) return sendError(res, 'Not found or unauthorized', 404);
    return sendSuccess(res, {}, 'Message deleted');
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/chat/messages/{msgId}/react:
 *   post:
 *     summary: Add or toggle reaction to a message
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: msgId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Reaction toggled
 */
const reactToMessage = async (req, res) => {
  const { emoji } = req.body;
  if (!emoji) return sendError(res, 'Emoji required', 400);
  try {
    // Toggle reaction
    const existing = await query(
      `SELECT id FROM chat_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3`,
      [req.params.msgId, req.user.id, emoji]
    );
    if (existing.rows.length) {
      await query('DELETE FROM chat_reactions WHERE id=$1', [existing.rows[0].id]);
      return sendSuccess(res, { removed: true });
    } else {
      await query(
        `INSERT INTO chat_reactions (message_id, user_id, emoji) VALUES ($1,$2,$3)`,
        [req.params.msgId, req.user.id, emoji]
      );
      return sendSuccess(res, { added: true });
    }
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/chat/rooms/{roomId}/members:
 *   get:
 *     summary: Get members of a chat room
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Member list
 */
const getRoomMembers = async (req, res) => {
  try {
    const rows = await query(`
      SELECT cm.role, cm.joined_at, cm.last_read_at,
             u.id, u.first_name, u.last_name, u.email, u.avatar_url,
             u.designation, u.status
      FROM chat_members cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.room_id = $1
      ORDER BY cm.role DESC, u.first_name
    `, [req.params.roomId]);
    return sendSuccess(res, rows.rows);
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/chat/rooms/{roomId}/members:
 *   post:
 *     summary: Add members to a group room
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Members added
 */
const addMembers = async (req, res) => {
  const { userIds } = req.body;
  try {
    for (const uid of userIds || []) {
      await query(
        `INSERT INTO chat_members (room_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [req.params.roomId, uid]
      );
    }
    return sendSuccess(res, {}, `${(userIds||[]).length} member(s) added`);
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/chat/rooms/{roomId}/leave:
 *   delete:
 *     summary: Leave a chat room
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Left room
 */
const leaveRoom = async (req, res) => {
  try {
    await query(
      `DELETE FROM chat_members WHERE room_id=$1 AND user_id=$2`,
      [req.params.roomId, req.user.id]
    );
    return sendSuccess(res, {}, 'Left room');
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/chat/users:
 *   get:
 *     summary: Search users to start new chat
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of searchable users
 */
const getChatUsers = async (req, res) => {
  const { search } = req.query;
  try {
    const rows = await query(`
      SELECT u.id, u.first_name, u.last_name, u.email, u.avatar_url,
             u.designation, u.status, d.name as department_name
      FROM users u
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id != $1
        AND u.status = 'active'
        ${search ? `AND (u.first_name ILIKE $2 OR u.last_name ILIKE $2 OR u.email ILIKE $2)` : ''}
      ORDER BY u.first_name
      LIMIT 30
    `, search ? [req.user.id, `%${search}%`] : [req.user.id]);
    return sendSuccess(res, rows.rows);
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/chat/rooms/{roomId}/read:
 *   put:
 *     summary: Mark all messages in room as read
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Success
 */
const markRoomRead = async (req, res) => {
  try {
    await query(
      `UPDATE chat_members SET last_read_at=NOW() WHERE room_id=$1 AND user_id=$2`,
      [req.params.roomId, req.user.id]
    );
    return sendSuccess(res, {});
  } catch (err) { return sendError(res, 'Failed', 500); }
};

module.exports = {
  getRooms, openDirectChat, createGroupChat,
  getMessages, sendMessage, editMessage, deleteMessage,
  reactToMessage, getRoomMembers, addMembers, leaveRoom,
  getChatUsers, markRoomRead,
};

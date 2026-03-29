const { query, transaction } = require('../config/database');
const { sendSuccess, sendError, auditLog } = require('../utils/helpers');

/**
 * findAvailableAgent
 * Looks for an online user with 'support' or 'admin' role.
 */
const findAvailableAgent = async (io) => {
  if (!io || typeof io.getOnlineUserIds !== 'function') return null;
  
  const onlineIds = io.getOnlineUserIds();
  if (!onlineIds.length) return null;

  const res = await query(`
    SELECT u.id 
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN roles r ON r.id = ur.role_id
    WHERE u.id = ANY($1) 
    AND r.slug IN ('support', 'admin', 'super-admin')
    AND u.status = 'active'
    LIMIT 1
  `, [onlineIds]);

  return res.rows.length ? res.rows[0].id : null;
};

/**
 * getAgents
 * Returns a list of users with 'support', 'admin', or 'super-admin' roles.
 */
exports.getAgents = async (req, res) => {
  try {
    const result = await query(`
      SELECT DISTINCT u.id, u.first_name, u.last_name, u.email, u.avatar_url
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
      WHERE r.slug IN ('support', 'admin', 'super-admin')
      AND u.status = 'active'
      ORDER BY u.first_name ASC
    `);
    return sendSuccess(res, result.rows, 'Agents retrieved successfully');
  } catch (err) {
    console.error('getAgents error:', err);
    return sendError(res, 'Failed to retrieve agents');
  }
};

/**
 * @swagger
 * tags:
 *   name: Customer Support
 *   description: Enhanced API for managing customer support tickets and messages via PostgreSQL
 */

/**
 * @swagger
 * /api/support/tickets:
 *   get:
 *     summary: Retrieve all support tickets
 *     tags: [Customer Support]
 *     responses:
 *       200:
 *         description: A list of tickets
 */
exports.getTickets = async (req, res) => {
  try {
    const { status, category } = req.query;
    let sql = `
      SELECT t.*, 
             u.first_name as user_first_name, u.last_name as user_last_name,
             a.first_name as agent_first_name, a.last_name as agent_last_name
      FROM support_tickets t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN users a ON a.id = t.assigned_to
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      params.push(status);
      sql += ` AND t.status = $${params.length}`;
    }
    if (category) {
      params.push(category);
      sql += ` AND t.category = $${params.length}`;
    }

    sql += ` ORDER BY t.updated_at DESC`;

    const result = await query(sql, params);
    return sendSuccess(res, result.rows, 'Tickets retrieved successfully');
  } catch (err) {
    console.error('getTickets error:', err);
    return sendError(res, 'Failed to retrieve tickets');
  }
};

/**
 * @swagger
 * /api/support/tickets:
 *   post:
 *     summary: Create a new support ticket
 *     tags: [Customer Support]
 */
exports.createTicket = async (req, res) => {
  const { category, title, description, guestName, guestEmail } = req.body;
  const userId = req.user ? req.user.id : null;
  const io = req.app.get('io');

  try {
    const result = await transaction(async (client) => {
      // 1. Create Ticket
      const ticketRes = await client.query(`
        INSERT INTO support_tickets (user_id, guest_name, guest_email, category, title, description, status, mode)
        VALUES ($1, $2, $3, $4, $5, $6, 'open', 'bot')
        RETURNING *
      `, [userId, guestName, guestEmail, category, title, description]);

      const ticket = ticketRes.rows[0];

      // 2. Initial Bot Message
      const botText = `Hi! You selected "${category}". I am the Support Bot. How can I help you with your issue regarding "${title}"? An agent will be with you shortly.`;
      const msgRes = await client.query(`
        INSERT INTO support_messages (ticket_id, sender_id, sender_type, text)
        VALUES ($1, NULL, 'bot', $2)
        RETURNING *
      `, [ticket.id, botText]);

      return { ticket, initialMessage: msgRes.rows[0] };
    });

    // 3. Auto-Assignment Logic (Optional: immediate check)
    const availableAgentId = await findAvailableAgent(io);
    if (availableAgentId) {
      await query(`UPDATE support_tickets SET assigned_to = $1, mode = 'agent', status = 'in-progress' WHERE id = $2`, 
        [availableAgentId, result.ticket.id]);
      result.ticket.assigned_to = availableAgentId;
      result.ticket.mode = 'agent';
      result.ticket.status = 'in-progress';
    }

    // 4. Emit Socket Events
    if (io) {
      io.to('room:staff').emit('support:ticket:new', result.ticket);
      io.to(result.ticket.id).emit('support:message:new', result.initialMessage);
    }

    return sendSuccess(res, result, 'Ticket created successfully', 201);
  } catch (err) {
    console.error('createTicket error:', err);
    return sendError(res, 'Failed to create ticket');
  }
};

/**
 * @swagger
 * /api/support/tickets/{id}/messages:
 *   get:
 *     summary: Retrieve messages for a specific ticket
 */
exports.getMessages = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await query(`
      SELECT m.*, u.first_name, u.last_name, u.avatar_url
      FROM support_messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.ticket_id = $1
      ORDER BY m.created_at ASC
    `, [id]);
    return sendSuccess(res, result.rows, 'Messages retrieved successfully');
  } catch (err) {
    console.error('getMessages error:', err);
    return sendError(res, 'Failed to retrieve messages');
  }
};

/**
 * @swagger
 * /api/support/tickets/{id}/messages:
 *   post:
 *     summary: Send a message for a specific ticket
 */
exports.sendMessage = async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  const senderId = req.user ? req.user.id : null;
  const senderType = req.user ? (req.user.roles?.includes('support') || req.user.roles?.includes('admin') ? 'agent' : 'user') : 'user';
  const io = req.app.get('io');

  try {
    // 1. Verify ticket exists
    const ticketRes = await query(`SELECT * FROM support_tickets WHERE id = $1`, [id]);
    if (!ticketRes.rows.length) return sendError(res, 'Ticket not found', 404);
    const ticket = ticketRes.rows[0];

    // 2. Insert message
    const msgRes = await query(`
      INSERT INTO support_messages (ticket_id, sender_id, sender_type, text)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [id, senderId, senderType, text]);

    const message = msgRes.rows[0];

    // 3. Update ticket updated_at
    await query(`UPDATE support_tickets SET updated_at = NOW() WHERE id = $1`, [id]);

    // 4. Socket Emit
    if (io) {
      io.to(id).emit('support:message:new', { ...message, ticketId: id });
      
      // If user sends message, notify staff/agent if they aren't in the ticket room
      if (senderType === 'user') {
        io.to('room:staff').emit('support:notification', {
          type: 'new_message',
          ticketId: id,
          title: ticket.title,
          text: text.substring(0, 50) + (text.length > 50 ? '...' : '')
        });
      }
    }

    // 5. Bot Auto-reply logic if in bot mode
    if (ticket.mode === 'bot' && senderType === 'user') {
      setTimeout(async () => {
        try {
          const botText = "We have received your message and an agent will assist you shortly. Please hold on or provide any additional details.";
          const botMsgRes = await query(`
            INSERT INTO support_messages (ticket_id, sender_id, sender_type, text)
            VALUES ($1, NULL, 'bot', $2)
            RETURNING *
          `, [id, botText]);
          if (io) io.to(id).emit('support:message:new', { ...botMsgRes.rows[0], ticketId: id });
        } catch (err) {
          console.error('Bot reply error:', err);
        }
      }, 2000);
    }

    return sendSuccess(res, message, 'Message sent successfully', 201);
  } catch (err) {
    console.error('sendMessage error:', err);
    return sendError(res, 'Failed to send message');
  }
};

/**
 * Manual Assignment by Agent
 */
exports.assignTicket = async (req, res) => {
  const { id } = req.params;
  const { agentId } = req.body; // Optional agentId from FE
  const requesterId = req.user.id;
  const targetAgentId = agentId || requesterId;
  const io = req.app.get('io');

  try {
    // Verify target agent exists and has correct role
    if (agentId) {
      const agentCheck = await query(`
        SELECT u.id, u.first_name 
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN roles r ON r.id = ur.role_id
        WHERE u.id = $1 AND r.slug IN ('support', 'admin', 'super-admin')
      `, [agentId]);
      
      if (!agentCheck.rows.length) {
        return sendError(res, 'Invalid agent ID or agent does not have support permissions', 400);
      }
    }

    const updateRes = await query(`
      UPDATE support_tickets 
      SET assigned_to = $1, mode = 'agent', status = 'in-progress', updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [targetAgentId, id]);

    if (!updateRes.rows.length) return sendError(res, 'Ticket not found', 404);

    // Fetch full ticket with agent names for FE sync
    const fullTicketRes = await query(`
      SELECT t.*, a.first_name as agent_first_name, a.last_name as agent_last_name
      FROM support_tickets t
      LEFT JOIN users a ON a.id = t.assigned_to
      WHERE t.id = $1
    `, [id]);
    const fullTicket = fullTicketRes.rows[0];

    if (io) {
      io.emit('support:ticket:updated', fullTicket);
      
      // Specifically notify the assigned agent for their real-time toast
      io.to(`user:${targetAgentId}`).emit('support:ticket:assigned', {
        message: 'A new ticket has been assigned to you!',
        ticket: fullTicket
      });

      io.to(id).emit('support:handover', { 
        ticketId: id,
        agentId: targetAgentId, 
        agentName: `${fullTicket.agent_first_name} ${fullTicket.agent_last_name}`
      });
    }

    await auditLog({ 
      userId: requesterId, 
      action: 'UPDATE', 
      entityType: 'support_ticket', 
      entityId: id, 
      newValues: { assigned_to: targetAgentId },
      req 
    });

    return sendSuccess(res, fullTicket, 'Ticket assigned successfully');
  } catch (err) {
    console.error('assignTicket error:', err);
    return sendError(res, 'Failed to assign ticket');
  }
};

/**
 * Resolve/Close Ticket
 */
exports.resolveTicket = async (req, res) => {
  const { id } = req.params;
  try {
    await query(`UPDATE support_tickets SET status = 'resolved', updated_at = NOW() WHERE id = $1`, [id]);
    const io = req.app.get('io');
    if (io) {
      io.emit('support:ticket:updated', { id, status: 'resolved' });
      io.to(id).emit('support:ticket:resolved', { id });
    }
    return sendSuccess(res, {}, 'Ticket resolved successfully');
  } catch (err) {
    console.error('resolveTicket error:', err);
    return sendError(res, 'Failed to resolve ticket');
  }
};

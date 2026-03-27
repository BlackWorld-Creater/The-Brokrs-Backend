const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', 'support_data.json');

// Initialize DB if not exists
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, JSON.stringify({ tickets: [], messages: [] }, null, 2));
}

const readDB = () => JSON.parse(fs.readFileSync(dbPath, "utf-8"));
const writeDB = (data) => fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));

/**
 * @swagger
 * tags:
 *   name: Customer Support
 *   description: API for managing customer support tickets and messages
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
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       category:
 *                         type: string
 *                       title:
 *                         type: string
 *                       description:
 *                         type: string
 *                       status:
 *                         type: string
 *                       createdAt:
 *                         type: number
 *                       updatedAt:
 *                         type: number
 */
exports.getTickets = (req, res) => {
  const db = readDB();
  res.json({ status: "success", data: db.tickets.sort((a,b) => b.updatedAt - a.updatedAt) });
};

/**
 * @swagger
 * /api/support/tickets:
 *   post:
 *     summary: Create a new support ticket
 *     tags: [Customer Support]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - category
 *               - title
 *               - description
 *             properties:
 *               category:
 *                 type: string
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Ticket created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     category:
 *                       type: string
 *                     title:
 *                       type: string
 *                     description:
 *                       type: string
 *                     status:
 *                       type: string
 *                     createdAt:
 *                       type: number
 *                     updatedAt:
 *                       type: number
 */
exports.createTicket = (req, res) => {
  const { category, title, description } = req.body;
  const db = readDB();
  
  const newTicket = {
    id: Date.now().toString(),
    category,
    title,
    description,
    status: "Open", // Open, In Progress, Resolved
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  
  db.tickets.push(newTicket);
  
  // Add an initial bot message welcoming them based on the category
  const initialMsg = {
    id: Date.now().toString() + "-m",
    ticketId: newTicket.id,
    type: "bot",
    text: `Hi! You selected "${category}". I am the Support Bot. How can I help you with your issue regarding ${title}?`,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    timestamp: Date.now()
  };
  
  db.messages.push(initialMsg);
  
  writeDB(db);
  res.status(201).json({ status: "success", data: newTicket });
};

/**
 * @swagger
 * /api/support/tickets/{id}/messages:
 *   get:
 *     summary: Retrieve messages for a specific ticket
 *     tags: [Customer Support]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The ticket ID
 *     responses:
 *       200:
 *         description: List of messages for the ticket
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       ticketId:
 *                         type: string
 *                       type:
 *                         type: string
 *                       text:
 *                         type: string
 *                       time:
 *                         type: string
 *                       timestamp:
 *                         type: number
 */
exports.getMessages = (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const ticketMessages = db.messages.filter(m => m.ticketId === id).sort((a,b) => a.timestamp - b.timestamp);
  res.json({ status: "success", data: ticketMessages });
};

/**
 * @swagger
 * /api/support/tickets/{id}/messages:
 *   post:
 *     summary: Send a message for a specific ticket
 *     tags: [Customer Support]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The ticket ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - text
 *             properties:
 *               text:
 *                 type: string
 *     responses:
 *       201:
 *         description: Message sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     ticketId:
 *                       type: string
 *                     type:
 *                       type: string
 *                     text:
 *                       type: string
 *                     time:
 *                       type: string
 *                     timestamp:
 *                       type: number
 */
exports.sendMessage = (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  const db = readDB();
  
  const ticket = db.tickets.find(t => t.id === id);
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  const userMsg = {
    id: Date.now().toString(),
    ticketId: id,
    type: "user",
    text,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    timestamp: Date.now()
  };
  
  db.messages.push(userMsg);
  ticket.updatedAt = Date.now();
  writeDB(db);

  // Auto-respond for demonstration (simulating real bot/agent)
  setTimeout(() => {
    try {
      const updatedDb = readDB();
      const botMsg = {
        id: Date.now().toString() + "-bot",
        ticketId: id,
        type: "bot",
        text: "We have received your message and an agent will assist you shortly. Please hold on or provide any additional details.",
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp: Date.now()
      };
      updatedDb.messages.push(botMsg);
      
      // Update ticket latest
      const t = updatedDb.tickets.find(t => t.id === id);
      if (t) t.updatedAt = Date.now();
      
      writeDB(updatedDb);
    } catch (err) {
      console.error("Bot auto-reply error:", err);
    }
  }, 1500); // 1.5 second delay

  res.status(201).json({ status: "success", data: userMsg });
};

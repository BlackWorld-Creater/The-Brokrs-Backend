const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', 'support_data.json');

// Initialize DB if not exists
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, JSON.stringify({ tickets: [], messages: [] }, null, 2));
}

const readDB = () => JSON.parse(fs.readFileSync(dbPath, "utf-8"));
const writeDB = (data) => fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));

exports.getTickets = (req, res) => {
  const db = readDB();
  res.json({ status: "success", data: db.tickets.sort((a,b) => b.updatedAt - a.updatedAt) });
};

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

exports.getMessages = (req, res) => {
  const { id } = req.params;
  const db = readDB();
  const ticketMessages = db.messages.filter(m => m.ticketId === id).sort((a,b) => a.timestamp - b.timestamp);
  res.json({ status: "success", data: ticketMessages });
};

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

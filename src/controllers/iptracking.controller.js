const { query, transaction } = require('../config/database');
const { sendSuccess, sendError, sendPaginated, auditLog, getPagination, buildPaginationMeta } = require('../utils/helpers');

/* ── safe query — returns empty result instead of throwing on missing table ── */
const safeQuery = async (sql, params = []) => {
  try {
    return await query(sql, params);
  } catch (err) {
    if (err.code === '42P01') {
      // Table does not exist — return empty
      return { rows: [], rowCount: 0 };
    }
    throw err;
  }
};

/**
 * @swagger
 * tags:
 *   name: IP Tracking
 *   description: Tracking of client IPs, stats, and blocking
 */

/**
 * @swagger
 * /api/ip-tracking/stats:
 *   get:
 *     summary: Get IP tracking dashboard stats
 *     tags: [IP Tracking]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: IP stats retrieved successfully
 */
const getIPStats = async (req, res) => {
  try {
    const [total, unique, blocked, logins, topIPs, recentActivity, hourly] = await Promise.all([
      safeQuery(`SELECT COUNT(*) as total FROM ip_tracking WHERE created_at > NOW() - INTERVAL '24 hours'`),
      safeQuery(`SELECT COUNT(DISTINCT ip_address) as unique_ips FROM ip_tracking WHERE created_at > NOW() - INTERVAL '24 hours'`),
      safeQuery(`SELECT COUNT(*) as total FROM blocked_ips WHERE is_permanent = true OR expires_at > NOW()`),
      safeQuery(`SELECT COUNT(*) as total FROM ip_tracking WHERE event_type = 'login' AND created_at > NOW() - INTERVAL '24 hours'`),
      safeQuery(`
        SELECT ip_address::text, COUNT(*) as hits, MAX(created_at) as last_seen,
               MAX(country) as country, bool_or(is_blocked) as is_flagged
        FROM ip_tracking WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY ip_address ORDER BY hits DESC LIMIT 10
      `),
      safeQuery(`
        SELECT t.ip_address::text, t.event_type, t.path, t.method,
               t.status_code, t.country, t.city, t.user_agent, t.created_at,
               u.first_name, u.last_name, u.email
        FROM ip_tracking t
        LEFT JOIN users u ON u.id = t.user_id
        ORDER BY t.created_at DESC LIMIT 20
      `),
      safeQuery(`
        SELECT DATE_TRUNC('hour', created_at) as hour, COUNT(*) as requests
        FROM ip_tracking
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY hour ORDER BY hour
      `),
    ]);

    return sendSuccess(res, {
      total24h:      parseInt(total.rows[0]?.total   || 0),
      uniqueIPs:     parseInt(unique.rows[0]?.unique_ips || 0),
      blockedIPs:    parseInt(blocked.rows[0]?.total  || 0),
      logins24h:     parseInt(logins.rows[0]?.total   || 0),
      topIPs:        topIPs.rows,
      recentActivity: recentActivity.rows,
      hourlyTraffic:  hourly.rows,
    });
  } catch (err) {
    console.error('IP stats error:', err);
    return sendError(res, 'Failed to fetch IP stats', 500);
  }
};

/**
 * @swagger
 * /api/ip-tracking:
 *   get:
 *     summary: Get IP tracking logs
 *     tags: [IP Tracking]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: ip
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: IP logs retrieved successfully
 */
const getIPLogs = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const { ip, eventType, userId, from, to } = req.query;

    let conds = ['1=1'], params = [], idx = 1;
    if (ip)        { conds.push(`t.ip_address::text ILIKE $${idx++}`); params.push(`%${ip}%`); }
    if (eventType) { conds.push(`t.event_type = $${idx++}`);           params.push(eventType); }
    if (userId)    { conds.push(`t.user_id = $${idx++}`);              params.push(userId); }
    if (from)      { conds.push(`t.created_at >= $${idx++}`);          params.push(from); }
    if (to)        { conds.push(`t.created_at <= $${idx++}`);          params.push(to); }

    const where = conds.join(' AND ');
    const countRes = await safeQuery(`SELECT COUNT(*) FROM ip_tracking t WHERE ${where}`, params);
    const rows = await safeQuery(
      `SELECT t.*, u.first_name, u.last_name, u.email,
              b.reason as block_reason_detail
       FROM ip_tracking t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN blocked_ips b ON b.ip_address = t.ip_address
       WHERE ${where}
       ORDER BY t.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    return sendPaginated(res, rows.rows, buildPaginationMeta(countRes.rows[0]?.count || 0, page, limit));
  } catch (err) {
    console.error('IP logs error:', err);
    return sendError(res, 'Failed to fetch IP logs', 500);
  }
};

/**
 * @swagger
 * /api/ip-tracking/blocked:
 *   get:
 *     summary: Get all blocked IPs
 *     tags: [IP Tracking]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Blocked IPs retrieved successfully
 */
const getBlockedIPs = async (req, res) => {
  try {
    const rows = await safeQuery(
      `SELECT b.*, u.first_name as blocked_by_name, u.last_name as blocked_by_last
       FROM blocked_ips b
       LEFT JOIN users u ON u.id = b.blocked_by
       ORDER BY b.created_at DESC`
    );
    return sendSuccess(res, rows.rows);
  } catch (err) {
    return sendError(res, 'Failed to fetch blocked IPs', 500);
  }
};

/**
 * @swagger
 * /api/ip-tracking/block:
 *   post:
 *     summary: Block an IP address
 *     tags: [IP Tracking]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ipAddress]
 *             properties:
 *               ipAddress: { type: string }
 *               reason: { type: string }
 *               isPermanent: { type: boolean }
 *     responses:
 *       200:
 *         description: IP blocked successfully
 */
const blockIP = async (req, res) => {
  const { ipAddress, reason, isPermanent, expiresAt } = req.body;
  try {
    if (!ipAddress) return sendError(res, 'IP address required', 400);
    await query(
      `INSERT INTO blocked_ips (ip_address, reason, blocked_by, is_permanent, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (ip_address) DO UPDATE SET reason=$2, blocked_by=$3, is_permanent=$4, expires_at=$5`,
      [ipAddress, reason, req.user.id, isPermanent || false, expiresAt || null]
    );
    await safeQuery(`UPDATE ip_tracking SET is_blocked=true WHERE ip_address=$1`, [ipAddress]);
    await auditLog({ userId: req.user.id, action: 'CREATE', entityType: 'blocked_ip',
                     newValues: { ipAddress, reason, isPermanent }, req });
    return sendSuccess(res, {}, `IP ${ipAddress} blocked`);
  } catch (err) {
    console.error('Block IP error:', err);
    return sendError(res, 'Failed to block IP', 500);
  }
};

/**
 * @swagger
 * /api/ip-tracking/block/{ip}:
 *   delete:
 *     summary: Unblock an IP address
 *     tags: [IP Tracking]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: ip
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: IP unblocked successfully
 */
const unblockIP = async (req, res) => {
  try {
    const ip = decodeURIComponent(req.params.ip);
    await safeQuery('DELETE FROM blocked_ips WHERE ip_address=$1', [ip]);
    await safeQuery('UPDATE ip_tracking SET is_blocked=false WHERE ip_address=$1', [ip]);
    await auditLog({ userId: req.user.id, action: 'DELETE', entityType: 'blocked_ip', req, metadata: { ip } });
    return sendSuccess(res, {}, `IP ${ip} unblocked`);
  } catch (err) {
    return sendError(res, 'Failed to unblock IP', 500);
  }
};

/**
 * @swagger
 * /api/ip-tracking/lookup/{ip}:
 *   get:
 *     summary: Lookup IP history and details
 *     tags: [IP Tracking]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: ip
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: IP lookup data retrieved successfully
 */
const lookupIP = async (req, res) => {
  try {
    const ip = decodeURIComponent(req.params.ip);
    const [history, stats, isBlocked] = await Promise.all([
      safeQuery(
        `SELECT t.*, u.first_name, u.last_name, u.email
         FROM ip_tracking t
         LEFT JOIN users u ON u.id = t.user_id
         WHERE t.ip_address=$1 ORDER BY t.created_at DESC LIMIT 50`,
        [ip]
      ),
      safeQuery(
        `SELECT COUNT(*) as total_requests,
                COUNT(DISTINCT user_id) as unique_users,
                MIN(created_at) as first_seen,
                MAX(created_at) as last_seen,
                COUNT(*) FILTER (WHERE event_type='login') as login_attempts
         FROM ip_tracking WHERE ip_address=$1`,
        [ip]
      ),
      safeQuery(`SELECT * FROM blocked_ips WHERE ip_address=$1`, [ip]),
    ]);
    return sendSuccess(res, {
      ip,
      stats: stats.rows[0] || {},
      history: history.rows,
      blockInfo: isBlocked.rows[0] || null,
    });
  } catch (err) {
    return sendError(res, 'Failed to lookup IP', 500);
  }
};

module.exports = { getIPStats, getIPLogs, getBlockedIPs, blockIP, unblockIP, lookupIP };

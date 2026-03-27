const { query } = require('../config/database');
const { sendSuccess, sendError } = require('../utils/helpers');
const notifService = require('../utils/notificationService');

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: Real-time user alert and notification management
 */

/**
 * @swagger
 * /api/notifications:
 *   get:
 *     summary: Get all user notifications
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Notifications retrieved successfully
 */
const getNotifications = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const onlyUnread = req.query.unread === 'true';
    const where = onlyUnread
      ? 'WHERE n.user_id=$1 AND n.is_read=false'
      : 'WHERE n.user_id=$1';

    const [rows, countRes] = await Promise.all([
      query(
        `SELECT n.*,
           u.first_name as actor_first, u.last_name as actor_last, u.avatar_url as actor_avatar
         FROM notifications n
         LEFT JOIN users u ON u.id = n.actor_id
         ${where}
         ORDER BY n.created_at DESC LIMIT $2`,
        [req.user.id, limit]
      ),
      query(
        `SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=false`,
        [req.user.id]
      ),
    ]);

    return sendSuccess(res, {
      notifications: rows.rows,
      unreadCount:   parseInt(countRes.rows[0].count),
    });
  } catch (err) {
    return sendError(res, 'Failed to fetch notifications', 500);
  }
};

/**
 * @swagger
 * /api/notifications/{id}/read:
 *   put:
 *     summary: Mark single notification as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Marked as read
 */
const markOneRead = async (req, res) => {
  try {
    await notifService.markRead(req.params.id, req.user.id);
    return sendSuccess(res, {}, 'Marked as read');
  } catch (err) {
    return sendError(res, 'Failed', 500);
  }
};

/**
 * @swagger
 * /api/notifications/read-all:
 *   put:
 *     summary: Mark all user notifications as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications marked as read
 */
const markAllRead = async (req, res) => {
  try {
    await notifService.markAllRead(req.user.id);
    return sendSuccess(res, {}, 'All notifications marked as read');
  } catch (err) {
    return sendError(res, 'Failed', 500);
  }
};

/**
 * @swagger
 * /api/notifications/{id}:
 *   delete:
 *     summary: Delete a specific notification
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Notification deleted
 */
const deleteNotification = async (req, res) => {
  try {
    await query('DELETE FROM notifications WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    return sendSuccess(res, {}, 'Deleted');
  } catch (err) {
    return sendError(res, 'Failed', 500);
  }
};

/**
 * @swagger
 * /api/notifications:
 *   delete:
 *     summary: Clear all read notifications
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Read notifications cleared
 */
const clearRead = async (req, res) => {
  try {
    await query('DELETE FROM notifications WHERE user_id=$1 AND is_read=true', [req.user.id]);
    return sendSuccess(res, {}, 'Read notifications cleared');
  } catch (err) {
    return sendError(res, 'Failed', 500);
  }
};

/**
 * @swagger
 * /api/notifications/count:
 *   get:
 *     summary: Get unread notification count
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Unread notification count retrieved
 */
const getUnreadCount = async (req, res) => {
  try {
    const count = await notifService.getUnreadCount(req.user.id);
    return sendSuccess(res, { count });
  } catch (err) {
    return sendError(res, 'Failed', 500);
  }
};

module.exports = {
  getNotifications, markOneRead, markAllRead,
  deleteNotification, clearRead, getUnreadCount,
};

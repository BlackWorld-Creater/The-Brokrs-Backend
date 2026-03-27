/**
 * notificationService.js
 * Central place that sends every kind of in-app notification.
 * All notification types, messages and links are defined here.
 */
const { query } = require('../config/database');

/* ── Core sender ─────────────────────────────────────────────────── */
const send = async ({ userId, title, message, type = 'info', link, entityType, entityId, actorId }) => {
  if (!userId) return;
  try {
    await query(
      `INSERT INTO notifications (user_id, title, message, type, link, entity_type, entity_id, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [userId, title, message, type, link || null, entityType || null, entityId || null, actorId || null]
    );
  } catch (err) {
    console.error('Notification send error:', err.message);
  }
};

/* ── Send to multiple users ──────────────────────────────────────── */
const sendToMany = async (userIds, payload) => {
  await Promise.all((userIds || []).map(uid => send({ ...payload, userId: uid })));
};

/* ── Send to all admins ──────────────────────────────────────────── */
const sendToAdmins = async (payload) => {
  try {
    const admins = await query(
      `SELECT DISTINCT u.id FROM users u
       JOIN user_roles ur ON ur.user_id=u.id
       JOIN roles r ON r.id=ur.role_id
       WHERE r.slug IN ('super-admin','admin') AND u.status='active'`
    );
    await sendToMany(admins.rows.map(a => a.id), payload);
  } catch (err) {
    console.error('sendToAdmins error:', err.message);
  }
};

/* ═══════════════════════════════════════════════════════════════════
 * TASK NOTIFICATIONS
 * ═══════════════════════════════════════════════════════════════════*/

/**
 * When a task is assigned to someone
 * - Notifies the assignee
 * - Notifies all watchers
 */
const taskAssigned = async ({ task, assignedTo, assignedBy, assignerName }) => {
  // Notify the assignee
  if (assignedTo && assignedTo !== assignedBy) {
    await send({
      userId:     assignedTo,
      title:      '📋 New task assigned to you',
      message:    `${assignerName} assigned you: "${task.title}"${task.due_date ? ` · Due ${task.due_date}` : ''}`,
      type:       'task',
      link:       `/tasks?id=${task.id}`,
      entityType: 'task',
      entityId:   task.id,
      actorId:    assignedBy,
    });
  }

  // Notify watchers (excluding the assignee and assigner)
  if (task.watcher_ids?.length) {
    const watchers = task.watcher_ids.filter(id => id !== assignedTo && id !== assignedBy);
    await sendToMany(watchers, {
      title:      `📋 Task assigned`,
      message:    `${assignerName} assigned "${task.title}" to someone`,
      type:       'task',
      link:       `/tasks?id=${task.id}`,
      entityType: 'task',
      entityId:   task.id,
      actorId:    assignedBy,
    });
  }
};

/**
 * When a task is reassigned to a different person
 * - Notifies the new assignee
 * - Notifies the old assignee that it was taken away
 */
const taskReassigned = async ({ task, oldAssigneeId, newAssigneeId, actorId, actorName }) => {
  // Notify new assignee
  if (newAssigneeId && newAssigneeId !== actorId) {
    await send({
      userId:     newAssigneeId,
      title:      '📋 Task reassigned to you',
      message:    `${actorName} reassigned "${task.title}" to you${task.due_date ? ` · Due ${task.due_date}` : ''}`,
      type:       'task',
      link:       `/tasks?id=${task.id}`,
      entityType: 'task',
      entityId:   task.id,
      actorId,
    });
  }
  // Notify old assignee that it was taken
  if (oldAssigneeId && oldAssigneeId !== actorId && oldAssigneeId !== newAssigneeId) {
    await send({
      userId:     oldAssigneeId,
      title:      '📋 Task reassigned',
      message:    `"${task.title}" was reassigned by ${actorName}`,
      type:       'info',
      link:       `/tasks?id=${task.id}`,
      entityType: 'task',
      entityId:   task.id,
      actorId,
    });
  }
};

/**
 * When a task status changes (e.g., completed, in_progress)
 * - Notifies the assigner
 * - Notifies watchers
 */
const taskStatusChanged = async ({ task, oldStatus, newStatus, actorId, actorName }) => {
  const statusLabel = {
    todo:        '⬜ To Do',
    in_progress: '🔵 In Progress',
    in_review:   '🟡 In Review',
    done:        '✅ Done',
    blocked:     '🔴 Blocked',
    cancelled:   '⛔ Cancelled',
  }[newStatus] || newStatus;

  const isDone = newStatus === 'done';

  // Notify assigner (if different from actor)
  if (task.assigned_by && task.assigned_by !== actorId) {
    await send({
      userId:     task.assigned_by,
      title:      isDone ? '✅ Task completed' : `📋 Task status updated`,
      message:    `${actorName} marked "${task.title}" as ${statusLabel}`,
      type:       isDone ? 'success' : 'info',
      link:       `/tasks?id=${task.id}`,
      entityType: 'task',
      entityId:   task.id,
      actorId,
    });
  }

  // Notify watchers
  if (task.watcher_ids?.length) {
    const watchers = task.watcher_ids.filter(id => id !== actorId);
    await sendToMany(watchers, {
      title:      `📋 Task status: ${statusLabel}`,
      message:    `${actorName} updated "${task.title}"`,
      type:       isDone ? 'success' : 'info',
      link:       `/tasks?id=${task.id}`,
      entityType: 'task',
      entityId:   task.id,
      actorId,
    });
  }
};

/**
 * When someone comments on a task
 * - Notifies assignee (if not the commenter)
 * - Notifies assigner (if not the commenter)
 * - Notifies all watchers
 */
const taskCommentAdded = async ({ task, comment, actorId, actorName }) => {
  const notifyIds = new Set();
  if (task.assigned_to && task.assigned_to !== actorId) notifyIds.add(task.assigned_to);
  if (task.assigned_by && task.assigned_by !== actorId) notifyIds.add(task.assigned_by);
  task.watcher_ids?.forEach(id => { if (id !== actorId) notifyIds.add(id); });

  await sendToMany([...notifyIds], {
    title:      '💬 New comment on task',
    message:    `${actorName} commented on "${task.title}": "${comment.substring(0, 80)}${comment.length > 80 ? '…' : ''}"`,
    type:       'info',
    link:       `/tasks?id=${task.id}`,
    entityType: 'task',
    entityId:   task.id,
    actorId,
  });
};

/**
 * When a task is overdue (called by a scheduler or on task fetch)
 */
const taskOverdue = async ({ task }) => {
  if (task.assigned_to) {
    await send({
      userId:     task.assigned_to,
      title:      '⏰ Task overdue',
      message:    `"${task.title}" was due on ${task.due_date} and is still not completed`,
      type:       'warning',
      link:       `/tasks?id=${task.id}`,
      entityType: 'task',
      entityId:   task.id,
    });
  }
};

/**
 * When a task due date is approaching (within 24h)
 */
const taskDueSoon = async ({ task, actorName }) => {
  if (task.assigned_to) {
    await send({
      userId:     task.assigned_to,
      title:      '⏳ Task due soon',
      message:    `"${task.title}" is due tomorrow`,
      type:       'warning',
      link:       `/tasks?id=${task.id}`,
      entityType: 'task',
      entityId:   task.id,
    });
  }
};

/* ── Mark a single notification as read ─────────────────────────── */
const markRead = async (notificationId, userId) => {
  await query(
    `UPDATE notifications SET is_read=true, read_at=NOW() WHERE id=$1 AND user_id=$2`,
    [notificationId, userId]
  );
};

/* ── Mark all as read for a user ─────────────────────────────────── */
const markAllRead = async (userId) => {
  await query(
    `UPDATE notifications SET is_read=true, read_at=NOW() WHERE user_id=$1 AND is_read=false`,
    [userId]
  );
};

/* ── Get unread count ────────────────────────────────────────────── */
const getUnreadCount = async (userId) => {
  const r = await query(
    `SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=false`,
    [userId]
  );
  return parseInt(r.rows[0].count);
};

module.exports = {
  send, sendToMany, sendToAdmins,
  taskAssigned, taskReassigned, taskStatusChanged, taskCommentAdded,
  taskOverdue, taskDueSoon,
  markRead, markAllRead, getUnreadCount,
};

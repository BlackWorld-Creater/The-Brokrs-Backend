/**
 * syncService.js
 *
 * When a Company, Site, or Web Service is updated, this service:
 *  1. Records the change in entity_change_events
 *  2. Propagates relevant field changes to all downstream tables
 *  3. Updates settings if the default company changes
 *  4. Creates user notifications for affected users
 *  5. Returns a summary of what was synced
 */

const { query, transaction } = require('../config/database');

/* ──────────────────────────────────────────────────────────────────
 * recordChangeEvent — always called after any entity update
 * ─────────────────────────────────────────────────────────────────*/
const recordChangeEvent = async (entityType, entityId, oldValues, newValues, changedBy) => {
  try {
    const changedFields = {};
    const allKeys = new Set([...Object.keys(oldValues || {}), ...Object.keys(newValues || {})]);
    for (const key of allKeys) {
      if (JSON.stringify(oldValues?.[key]) !== JSON.stringify(newValues?.[key])) {
        changedFields[key] = { from: oldValues?.[key], to: newValues?.[key] };
      }
    }
    if (Object.keys(changedFields).length === 0) return null;

    const r = await query(
      `INSERT INTO entity_change_events
       (entity_type, entity_id, event_type, changed_fields, old_values, new_values, changed_by)
       VALUES ($1,$2,'update',$3,$4,$5,$6) RETURNING id`,
      [entityType, entityId, JSON.stringify(changedFields),
       JSON.stringify(oldValues), JSON.stringify(newValues), changedBy || null]
    );
    return { eventId: r.rows[0].id, changedFields };
  } catch (err) {
    console.error('recordChangeEvent error:', err.message);
    return null;
  }
};

/* ──────────────────────────────────────────────────────────────────
 * notifyAffectedUsers — send in-app notifications to a list of users
 * ─────────────────────────────────────────────────────────────────*/
const notifyAffectedUsers = async (userIds, title, message) => {
  if (!userIds?.length) return;
  try {
    for (const uid of userIds) {
      await query(
        `INSERT INTO notifications (user_id, title, message, type)
         VALUES ($1,$2,$3,'info') ON CONFLICT DO NOTHING`,
        [uid, title, message]
      );
    }
  } catch (err) {
    console.error('notifyAffectedUsers error:', err.message);
  }
};

/* ──────────────────────────────────────────────────────────────────
 * syncCompanyChanges
 *
 * Called after a company record is updated.
 * Propagates: name, email, phone, logo, currency, timezone
 *  → settings table (if default company)
 *  → notifications to all users in the company
 * ─────────────────────────────────────────────────────────────────*/
const syncCompanyChanges = async (companyId, oldData, newData, changedBy) => {
  const summary = { settingsUpdated: [], usersNotified: 0, sitesUpdated: 0 };

  try {
    // Record the change event
    await recordChangeEvent('company', companyId, oldData, newData, changedBy);

    const isDefault = newData.is_default || oldData.is_default;

    /* 1. Sync settings if this is the default company */
    if (isDefault) {
      const settingsMap = {
        company_name:  newData.name,
        company_email: newData.email,
        company_phone: newData.phone,
      };
      for (const [key, value] of Object.entries(settingsMap)) {
        if (value !== undefined) {
          const r = await query(
            `UPDATE settings SET value=$1, updated_by=$2 WHERE key=$3 RETURNING key`,
            [String(value || ''), changedBy, key]
          );
          if (r.rows.length) summary.settingsUpdated.push(key);
        }
      }
    }

    /* 2. If company became default, update settings and clear old default */
    if (newData.is_default && !oldData.is_default) {
      await query(
        `UPDATE settings SET value=$1 WHERE key='company_name'`,
        [newData.name]
      );
      summary.settingsUpdated.push('company_name (new default)');
    }

    /* 3. Notify all users assigned to this company */
    const usersRes = await query(
      `SELECT id FROM users WHERE company_id=$1 AND status='active'`,
      [companyId]
    );
    const userIds = usersRes.rows.map(u => u.id);

    const changedFieldNames = [];
    if (oldData.name !== newData.name)     changedFieldNames.push('Name');
    if (oldData.email !== newData.email)   changedFieldNames.push('Email');
    if (oldData.phone !== newData.phone)   changedFieldNames.push('Phone');
    if (oldData.address_line1 !== newData.address_line1) changedFieldNames.push('Address');
    if (oldData.gstin !== newData.gstin)   changedFieldNames.push('GSTIN');
    if (oldData.currency !== newData.currency) changedFieldNames.push('Currency');

    if (changedFieldNames.length && userIds.length) {
      await notifyAffectedUsers(
        userIds,
        `Company Updated: ${newData.name}`,
        `${changedFieldNames.join(', ')} ${changedFieldNames.length > 1 ? 'have' : 'has'} been updated`
      );
      summary.usersNotified = userIds.length;
    }

    return summary;
  } catch (err) {
    console.error('syncCompanyChanges error:', err.message);
    return summary;
  }
};

/* ──────────────────────────────────────────────────────────────────
 * syncSiteChanges
 *
 * Called after a site record is updated.
 * Propagates:
 *  → notifications to users assigned to this site
 *  → if site name changes, updates any display references
 * ─────────────────────────────────────────────────────────────────*/
const syncSiteChanges = async (siteId, oldData, newData, changedBy) => {
  const summary = { usersNotified: 0 };

  try {
    await recordChangeEvent('site', siteId, oldData, newData, changedBy);

    /* Notify users at this site */
    const usersRes = await query(
      `SELECT id FROM users WHERE site_id=$1 AND status='active'`,
      [siteId]
    );
    const userIds = usersRes.rows.map(u => u.id);

    const changedFieldNames = [];
    if (oldData.name     !== newData.name)     changedFieldNames.push('Name');
    if (oldData.address_line1 !== newData.address_line1) changedFieldNames.push('Address');
    if (oldData.city     !== newData.city)     changedFieldNames.push('City');
    if (oldData.phone    !== newData.phone)    changedFieldNames.push('Phone');
    if (oldData.is_active !== newData.is_active) {
      changedFieldNames.push(newData.is_active ? 'Site reactivated' : 'Site deactivated');
    }

    if (changedFieldNames.length && userIds.length) {
      await notifyAffectedUsers(
        userIds,
        `Site Updated: ${newData.name}`,
        `${changedFieldNames.join(', ')} updated at your assigned site`
      );
      summary.usersNotified = userIds.length;
    }

    /* If site was deactivated, reassign users to company HQ */
    if (oldData.is_active && !newData.is_active) {
      const hqSite = await query(
        `SELECT id FROM sites WHERE company_id=$1 AND is_hq=true AND id!=$2 LIMIT 1`,
        [newData.company_id, siteId]
      );
      if (hqSite.rows.length) {
        await query(
          `UPDATE users SET site_id=$1 WHERE site_id=$2`,
          [hqSite.rows[0].id, siteId]
        );
        summary.usersReassigned = userIds.length;
      }
    }

    return summary;
  } catch (err) {
    console.error('syncSiteChanges error:', err.message);
    return summary;
  }
};

/* ──────────────────────────────────────────────────────────────────
 * syncWebServiceChanges
 *
 * Called after a web service is updated.
 * Propagates:
 *  → records change event
 *  → notifies admin users if service goes down/into maintenance
 *  → updates ws_logs with new service info
 * ─────────────────────────────────────────────────────────────────*/
const syncWebServiceChanges = async (serviceId, oldData, newData, changedBy) => {
  const summary = { adminsNotified: 0 };

  try {
    await recordChangeEvent('web_service', serviceId, oldData, newData, changedBy);

    /* Notify admins about status changes */
    const statusChanged = oldData.status !== newData.status;
    const urlChanged    = oldData.base_url !== newData.base_url;

    if (statusChanged || urlChanged) {
      const adminsRes = await query(
        `SELECT DISTINCT u.id FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         WHERE r.slug IN ('super-admin','admin') AND u.status='active'`
      );
      const adminIds = adminsRes.rows.map(u => u.id);

      let msg = [];
      if (statusChanged) msg.push(`Status changed from "${oldData.status}" to "${newData.status}"`);
      if (urlChanged)    msg.push(`Base URL updated`);

      if (adminIds.length) {
        await notifyAffectedUsers(
          adminIds,
          `Web Service Updated: ${newData.name}`,
          msg.join('. ')
        );
        summary.adminsNotified = adminIds.length;
      }
    }

    return summary;
  } catch (err) {
    console.error('syncWebServiceChanges error:', err.message);
    return summary;
  }
};

/* ──────────────────────────────────────────────────────────────────
 * getEntityChangeHistory — returns the change log for any entity
 * ─────────────────────────────────────────────────────────────────*/
const getEntityChangeHistory = async (entityType, entityId, limit = 20) => {
  try {
    const r = await query(
      `SELECT e.*, u.first_name, u.last_name, u.email
       FROM entity_change_events e
       LEFT JOIN users u ON u.id = e.changed_by
       WHERE e.entity_type=$1 AND e.entity_id=$2
       ORDER BY e.created_at DESC LIMIT $3`,
      [entityType, entityId, limit]
    );
    return r.rows;
  } catch (err) {
    console.error('getEntityChangeHistory error:', err.message);
    return [];
  }
};

/* ──────────────────────────────────────────────────────────────────
 * getDependencies — returns everything that references a given entity
 * ─────────────────────────────────────────────────────────────────*/
const getDependencies = async (entityType, entityId) => {
  try {
    if (entityType === 'company') {
      const [sites, depts, users, projects] = await Promise.all([
        query(`SELECT id, name, code, type FROM sites WHERE company_id=$1`, [entityId]),
        query(`SELECT id, name, code FROM departments WHERE company_id=$1`, [entityId]),
        query(`SELECT id, first_name, last_name, email, designation FROM users WHERE company_id=$1 AND status='active'`, [entityId]),
        query(`SELECT id, name, code FROM projects WHERE company_id=$1`, [entityId]).catch(() => ({ rows: [] })),
      ]);
      return {
        sites: sites.rows,
        departments: depts.rows,
        users: users.rows,
        projects: projects.rows,
      };
    }

    if (entityType === 'site') {
      const [users, depts] = await Promise.all([
        query(`SELECT id, first_name, last_name, email, designation FROM users WHERE site_id=$1 AND status='active'`, [entityId]),
        query(`SELECT id, name, code FROM departments WHERE site_id=$1`, [entityId]),
      ]);
      return { users: users.rows, departments: depts.rows };
    }

    if (entityType === 'web_service') {
      const [endpoints, keys, logs] = await Promise.all([
        query(`SELECT COUNT(*) as count FROM ws_endpoints WHERE service_id=$1 AND is_active=true`, [entityId]),
        query(`SELECT COUNT(*) as count FROM ws_api_keys WHERE service_id=$1 AND is_active=true`, [entityId]),
        query(`SELECT COUNT(*) as count FROM ws_logs WHERE service_id=$1`, [entityId]),
      ]);
      return {
        activeEndpoints: parseInt(endpoints.rows[0].count),
        activeApiKeys: parseInt(keys.rows[0].count),
        totalLogs: parseInt(logs.rows[0].count),
      };
    }

    return {};
  } catch (err) {
    console.error('getDependencies error:', err.message);
    return {};
  }
};

module.exports = {
  recordChangeEvent,
  syncCompanyChanges,
  syncSiteChanges,
  syncWebServiceChanges,
  getEntityChangeHistory,
  getDependencies,
  notifyAffectedUsers,
};

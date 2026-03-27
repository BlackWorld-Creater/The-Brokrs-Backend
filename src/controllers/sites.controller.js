const { query, transaction } = require('../config/database');
const { sendSuccess, sendError, sendPaginated, auditLog, getPagination, buildPaginationMeta } = require('../utils/helpers');
const { syncSiteChanges, getDependencies, getEntityChangeHistory } = require('../utils/syncService');

/**
 * @swagger
 * tags:
 *   name: Sites
 *   description: Branch/Site level location management
 */

/**
 * @swagger
 * /api/sites:
 *   get:
 *     summary: Get all locations/sites
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of sites retrieved successfully
 */
const getSites = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const { search, companyId, type, isActive } = req.query;
    const conds = ['1=1'], params = [];
    let idx = 1;
    if (search)    { conds.push(`(s.name ILIKE $${idx} OR s.code ILIKE $${idx} OR s.city ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    if (companyId) { conds.push(`s.company_id=$${idx++}`); params.push(companyId); }
    if (type)      { conds.push(`s.type=$${idx++}`);       params.push(type); }
    if (isActive !== undefined && isActive !== '') { conds.push(`s.is_active=$${idx++}`); params.push(isActive === 'true'); }
    const where = conds.join(' AND ');
    const countRes = await query(`SELECT COUNT(*) FROM sites s WHERE ${where}`, params);
    const rows = await query(
      `SELECT s.*, c.name as company_name, c.code as company_code, c.currency,
              u.first_name as mgr_first, u.last_name as mgr_last, u.email as mgr_email,
              (SELECT COUNT(*) FROM users WHERE site_id=s.id AND status='active') as user_count,
              (SELECT COUNT(*) FROM departments WHERE site_id=s.id) as dept_count
       FROM sites s
       JOIN companies c ON c.id=s.company_id
       LEFT JOIN users u ON u.id=s.manager_id
       WHERE ${where}
       ORDER BY s.is_hq DESC, c.name, s.name
       LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    );
    return sendPaginated(res, rows.rows, buildPaginationMeta(countRes.rows[0].count, page, limit));
  } catch (err) { console.error(err); return sendError(res, 'Failed to fetch sites', 500); }
};

/**
 * @swagger
 * /api/sites/{id}:
 *   get:
 *     summary: Get site by ID
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Site details and members
 */
const getSiteById = async (req, res) => {
  try {
    const r = await query(
      `SELECT s.*, c.name as company_name, c.code as company_code, c.currency, c.gstin as company_gstin,
              u.first_name as mgr_first, u.last_name as mgr_last,
              (SELECT COUNT(*) FROM users WHERE site_id=s.id AND status='active') as user_count
       FROM sites s
       JOIN companies c ON c.id=s.company_id
       LEFT JOIN users u ON u.id=s.manager_id
       WHERE s.id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return sendError(res, 'Site not found', 404);

    const [deps, changeHistory, usersAtSite] = await Promise.all([
      getDependencies('site', req.params.id),
      getEntityChangeHistory('site', req.params.id, 10),
      query(`SELECT id, first_name, last_name, email, designation, avatar_url
             FROM users WHERE site_id=$1 AND status='active' LIMIT 10`, [req.params.id]),
    ]);

    return sendSuccess(res, {
      ...r.rows[0],
      usersAtSite: usersAtSite.rows,
      dependencies: deps,
      changeHistory,
    });
  } catch (err) { return sendError(res, 'Failed to fetch site', 500); }
};

/**
 * @swagger
 * /api/sites:
 *   post:
 *     summary: Create new site
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Site created successfully
 */
const createSite = async (req, res) => {
  const d = req.body;
  try {
    if (!d.companyId) return sendError(res, 'Company ID is required', 400);
    const company = await query('SELECT id FROM companies WHERE id=$1', [d.companyId]);
    if (!company.rows.length) return sendError(res, 'Company not found', 404);
    const exists = await query('SELECT id FROM sites WHERE company_id=$1 AND code=$2', [d.companyId, d.code]);
    if (exists.rows.length) return sendError(res, 'Site code already exists for this company', 409);
    if (d.isHq) await query('UPDATE sites SET is_hq=false WHERE company_id=$1', [d.companyId]);
    const r = await query(
      `INSERT INTO sites
       (company_id,code,name,type,email,phone,fax,
        address_line1,address_line2,city,state,country,pincode,gstin,
        latitude,longitude,timezone,is_active,is_hq,manager_id,
        capacity,area_sqft,description,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING *`,
      [d.companyId,d.code,d.name,d.type||'branch',d.email,d.phone,d.fax,
       d.addressLine1,d.addressLine2,d.city,d.state,d.country||'India',d.pincode,d.gstin,
       d.latitude||null,d.longitude||null,d.timezone||'Asia/Kolkata',
       d.isActive!==false,d.isHq||false,d.managerId||null,
       d.capacity||null,d.areaSqft||null,d.description,req.user.id]
    );
    await auditLog({ userId: req.user.id, action: 'CREATE', entityType: 'site',
                     entityId: r.rows[0].id, newValues: { code: d.code, name: d.name, companyId: d.companyId }, req });
    return sendSuccess(res, r.rows[0], 'Site created', 201);
  } catch (err) { console.error(err); return sendError(res, err.message || 'Failed to create site', 500); }
};

/**
 * @swagger
 * /api/sites/{id}:
 *   put:
 *     summary: Update site details
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Site updated successfully
 */
const updateSite = async (req, res) => {
  const { id } = req.params;
  const d = req.body;
  try {
    const old = await query('SELECT * FROM sites WHERE id=$1', [id]);
    if (!old.rows.length) return sendError(res, 'Site not found', 404);
    const oldData = old.rows[0];

    if (d.isHq && !oldData.is_hq) {
      await query('UPDATE sites SET is_hq=false WHERE company_id=$1 AND id!=$2', [oldData.company_id, id]);
    }
    await query(
      `UPDATE sites SET code=$1,name=$2,type=$3,email=$4,phone=$5,fax=$6,
       address_line1=$7,address_line2=$8,city=$9,state=$10,country=$11,pincode=$12,gstin=$13,
       latitude=$14,longitude=$15,timezone=$16,is_active=$17,is_hq=$18,manager_id=$19,
       capacity=$20,area_sqft=$21,description=$22
       WHERE id=$23`,
      [d.code,d.name,d.type,d.email,d.phone,d.fax,
       d.addressLine1,d.addressLine2,d.city,d.state,d.country,d.pincode,d.gstin,
       d.latitude||null,d.longitude||null,d.timezone,d.isActive!==false,d.isHq||false,
       d.managerId||null,d.capacity||null,d.areaSqft||null,d.description,id]
    );

    /* ── CASCADING SYNC ── */
    const newData = { ...d, id, is_active: d.isActive !== false, is_hq: d.isHq || false, company_id: oldData.company_id };
    const syncResult = await syncSiteChanges(id, oldData, newData, req.user.id);

    await auditLog({ userId: req.user.id, action: 'UPDATE', entityType: 'site', entityId: id,
                     oldValues: { name: oldData.name, city: oldData.city, is_active: oldData.is_active },
                     newValues: { name: d.name, city: d.city, is_active: d.isActive }, req });

    return sendSuccess(res, {
      message: 'Site updated',
      syncSummary: { usersNotified: syncResult.usersNotified, usersReassigned: syncResult.usersReassigned || 0 }
    }, 'Site updated and changes propagated');
  } catch (err) { console.error(err); return sendError(res, 'Failed to update site', 500); }
};

/**
 * @swagger
 * /api/sites/{id}:
 *   delete:
 *     summary: Delete site
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Site deleted
 */
const deleteSite = async (req, res) => {
  try {
    const r = await query('SELECT * FROM sites WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return sendError(res, 'Site not found', 404);
    if (r.rows[0].is_hq) return sendError(res, 'Cannot delete HQ site. Change HQ first.', 400);
    // Unassign users from this site before deleting
    await query('UPDATE users SET site_id=NULL WHERE site_id=$1', [req.params.id]);
    await query('UPDATE departments SET site_id=NULL WHERE site_id=$1', [req.params.id]);
    await query('DELETE FROM sites WHERE id=$1', [req.params.id]);
    await auditLog({ userId: req.user.id, action: 'DELETE', entityType: 'site',
                     entityId: req.params.id, oldValues: { name: r.rows[0].name }, req });
    return sendSuccess(res, {}, 'Site deleted');
  } catch (err) { return sendError(res, err.message || 'Failed to delete site', 500); }
};

/**
 * @swagger
 * /api/sites/by-company/{companyId}:
 *   get:
 *     summary: Get all sites for a specific company
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: companyId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of sites found
 */
const getSitesByCompany = async (req, res) => {
  try {
    const rows = await query(
      `SELECT s.*, u.first_name as mgr_first, u.last_name as mgr_last,
              (SELECT COUNT(*) FROM users WHERE site_id=s.id AND status='active') as user_count
       FROM sites s LEFT JOIN users u ON u.id=s.manager_id
       WHERE s.company_id=$1 ORDER BY s.is_hq DESC, s.name`,
      [req.params.companyId]
    );
    return sendSuccess(res, rows.rows);
  } catch (err) { return sendError(res, 'Failed to fetch sites', 500); }
};

/**
 * @swagger
 * /api/sites/{id}/changes:
 *   get:
 *     summary: Get site change history
 *     tags: [Sites]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Change history found
 */
const getSiteChanges = async (req, res) => {
  try {
    const history = await getEntityChangeHistory('site', req.params.id, 20);
    return sendSuccess(res, history);
  } catch (err) { return sendError(res, 'Failed to fetch change history', 500); }
};

module.exports = { getSites, getSiteById, createSite, updateSite, deleteSite, getSitesByCompany, getSiteChanges };

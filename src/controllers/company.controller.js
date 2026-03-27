const { query, transaction } = require('../config/database');
const { sendSuccess, sendError, sendPaginated, auditLog, getPagination, buildPaginationMeta } = require('../utils/helpers');
const { syncCompanyChanges, getDependencies, getEntityChangeHistory } = require('../utils/syncService');

/**
 * @swagger
 * tags:
 *   name: Companies
 *   description: Organization level company management
 */

/**
 * @swagger
 * /api/companies/stats:
 *   get:
 *     summary: Get company dashboard stats
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Stats retrieved successfully
 */
const getCompanyStats = async (req, res) => {
  try {
    const stats = await query(`
      SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE is_active=true)  as active,
             COUNT(*) FILTER (WHERE is_active=false) as inactive,
             COUNT(*) FILTER (WHERE is_default=true) as defaults,
             (SELECT COUNT(*) FROM sites) as total_sites,
             (SELECT COUNT(*) FROM users WHERE company_id IS NOT NULL) as users_assigned
      FROM companies
    `);
    return sendSuccess(res, stats.rows[0]);
  } catch (err) { return sendError(res, 'Failed to fetch stats', 500); }
};

/**
 * @swagger
 * /api/companies:
 *   get:
 *     summary: Get all companies
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of companies retrieved successfully
 */
const getCompanies = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const { search, isActive, type } = req.query;
    const conds = ['1=1'], params = [];
    let idx = 1;
    if (search)    { conds.push(`(c.name ILIKE $${idx} OR c.code ILIKE $${idx} OR c.email ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    if (isActive !== undefined && isActive !== '') { conds.push(`c.is_active=$${idx++}`); params.push(isActive === 'true'); }
    if (type)      { conds.push(`c.type=$${idx++}`); params.push(type); }
    const where = conds.join(' AND ');
    const countRes = await query(`SELECT COUNT(*) FROM companies c WHERE ${where}`, params);
    const rows = await query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM sites s WHERE s.company_id=c.id) as site_count,
              (SELECT COUNT(*) FROM users u WHERE u.company_id=c.id AND u.status='active') as user_count,
              (SELECT COUNT(*) FROM departments d WHERE d.company_id=c.id) as dept_count
       FROM companies c
       WHERE ${where}
       ORDER BY c.is_default DESC, c.name
       LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    );
    return sendPaginated(res, rows.rows, buildPaginationMeta(countRes.rows[0].count, page, limit));
  } catch (err) {
    console.error(err);
    return sendError(res, 'Failed to fetch companies', 500);
  }
};

/**
 * @swagger
 * /api/companies/{id}:
 *   get:
 *     summary: Get company by ID
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Company details and dependencies
 */
const getCompanyById = async (req, res) => {
  try {
    const r = await query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM sites s WHERE s.company_id=c.id) as site_count,
              (SELECT COUNT(*) FROM users u WHERE u.company_id=c.id) as user_count,
              (SELECT COUNT(*) FROM departments d WHERE d.company_id=c.id) as dept_count
       FROM companies c WHERE c.id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return sendError(res, 'Company not found', 404);

    const [sites, deps, changeHistory] = await Promise.all([
      query(`SELECT s.*, u.first_name as mgr_first, u.last_name as mgr_last
             FROM sites s LEFT JOIN users u ON u.id=s.manager_id
             WHERE s.company_id=$1 ORDER BY s.is_hq DESC, s.name`, [req.params.id]),
      getDependencies('company', req.params.id),
      getEntityChangeHistory('company', req.params.id, 10),
    ]);

    return sendSuccess(res, {
      ...r.rows[0],
      sites: sites.rows,
      dependencies: deps,
      changeHistory,
    });
  } catch (err) { return sendError(res, 'Failed to fetch company', 500); }
};

/**
 * @swagger
 * /api/companies/{id}/dependencies:
 *   get:
 *     summary: Get company entity dependencies
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of dependencies
 */
const getCompanyDependencies = async (req, res) => {
  try {
    const deps = await getDependencies('company', req.params.id);
    return sendSuccess(res, deps);
  } catch (err) { return sendError(res, 'Failed to fetch dependencies', 500); }
};

/**
 * @swagger
 * /api/companies/{id}/changes:
 *   get:
 *     summary: Get company change history
 *     tags: [Companies]
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
const getCompanyChanges = async (req, res) => {
  try {
    const history = await getEntityChangeHistory('company', req.params.id, 20);
    return sendSuccess(res, history);
  } catch (err) { return sendError(res, 'Failed to fetch change history', 500); }
};

/**
 * @swagger
 * /api/companies:
 *   post:
 *     summary: Create new company
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, name]
 *             properties:
 *               code: { type: string }
 *               name: { type: string }
 *     responses:
 *       201:
 *         description: Company created successfully
 */
const createCompany = async (req, res) => {
  const d = req.body;
  try {
    const exists = await query('SELECT id FROM companies WHERE code=$1', [d.code]);
    if (exists.rows.length) return sendError(res, 'Company code already exists', 409);
    if (d.isDefault) await query('UPDATE companies SET is_default=false');
    const r = await query(
      `INSERT INTO companies
       (code,name,legal_name,type,industry,logo_url,website,email,phone,fax,
        address_line1,address_line2,city,state,country,pincode,
        pan_number,gstin,tan_number,cin_number,reg_number,
        currency,fiscal_year_start,timezone,date_format,
        is_active,is_default,bank_name,bank_account,bank_ifsc,bank_branch,
        description,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
       RETURNING *`,
      [d.code,d.name,d.legalName,d.type||'private_limited',d.industry,
       d.logoUrl,d.website,d.email,d.phone,d.fax,
       d.addressLine1,d.addressLine2,d.city,d.state,d.country||'India',d.pincode,
       d.panNumber,d.gstin,d.tanNumber,d.cinNumber,d.regNumber,
       d.currency||'INR',d.fiscalYearStart||'04-01',d.timezone||'Asia/Kolkata',d.dateFormat||'DD/MM/YYYY',
       d.isActive!==false,d.isDefault||false,
       d.bankName,d.bankAccount,d.bankIfsc,d.bankBranch,
       d.description,d.notes,req.user.id]
    );
    // If new default, sync settings
    if (d.isDefault) {
      await syncCompanyChanges(r.rows[0].id, {}, r.rows[0], req.user.id);
    }
    await auditLog({ userId: req.user.id, action: 'CREATE', entityType: 'company',
                     entityId: r.rows[0].id, newValues: { code: d.code, name: d.name }, req });
    return sendSuccess(res, r.rows[0], 'Company created', 201);
  } catch (err) {
    console.error(err);
    return sendError(res, err.message || 'Failed to create company', 500);
  }
};

/**
 * @swagger
 * /api/companies/{id}:
 *   put:
 *     summary: Update company details
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Company updated successfully
 */
const updateCompany = async (req, res) => {
  const { id } = req.params;
  const d = req.body;
  try {
    const old = await query('SELECT * FROM companies WHERE id=$1', [id]);
    if (!old.rows.length) return sendError(res, 'Company not found', 404);
    const oldData = old.rows[0];

    if (d.isDefault && !oldData.is_default) {
      await query('UPDATE companies SET is_default=false WHERE id!=$1', [id]);
    }

    await query(
      `UPDATE companies SET
       code=$1,name=$2,legal_name=$3,type=$4,industry=$5,logo_url=$6,website=$7,
       email=$8,phone=$9,fax=$10,
       address_line1=$11,address_line2=$12,city=$13,state=$14,country=$15,pincode=$16,
       pan_number=$17,gstin=$18,tan_number=$19,cin_number=$20,reg_number=$21,
       currency=$22,fiscal_year_start=$23,timezone=$24,date_format=$25,
       is_active=$26,is_default=$27,
       bank_name=$28,bank_account=$29,bank_ifsc=$30,bank_branch=$31,
       description=$32,notes=$33
       WHERE id=$34`,
      [d.code,d.name,d.legalName,d.type,d.industry,d.logoUrl,d.website,
       d.email,d.phone,d.fax,
       d.addressLine1,d.addressLine2,d.city,d.state,d.country,d.pincode,
       d.panNumber,d.gstin,d.tanNumber,d.cinNumber,d.regNumber,
       d.currency,d.fiscalYearStart,d.timezone,d.dateFormat,
       d.isActive!==false,d.isDefault||false,
       d.bankName,d.bankAccount,d.bankIfsc,d.bankBranch,
       d.description,d.notes,id]
    );

    /* ── CASCADING SYNC ── */
    const newData = { ...d, id, is_default: d.isDefault, is_active: d.isActive !== false };
    const syncResult = await syncCompanyChanges(id, oldData, newData, req.user.id);

    await auditLog({ userId: req.user.id, action: 'UPDATE', entityType: 'company', entityId: id,
                     oldValues: { name: oldData.name, email: oldData.email, gstin: oldData.gstin, status: oldData.is_active },
                     newValues: { name: d.name, email: d.email, gstin: d.gstin, status: d.isActive },
                     req });

    return sendSuccess(res, {
      message: 'Company updated',
      syncSummary: {
        settingsUpdated: syncResult.settingsUpdated,
        usersNotified: syncResult.usersNotified,
      }
    }, 'Company updated and changes propagated');
  } catch (err) {
    console.error(err);
    return sendError(res, 'Failed to update company', 500);
  }
};

/**
 * @swagger
 * /api/companies/{id}:
 *   delete:
 *     summary: Delete company
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Company deleted
 */
const deleteCompany = async (req, res) => {
  try {
    const r = await query('SELECT id, name, is_default FROM companies WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return sendError(res, 'Company not found', 404);
    if (r.rows[0].is_default) return sendError(res, 'Cannot delete the default company', 400);
    const siteCount = await query('SELECT COUNT(*) FROM sites WHERE company_id=$1', [req.params.id]);
    if (parseInt(siteCount.rows[0].count) > 0) return sendError(res, 'Remove all sites before deleting company', 400);
    await query('DELETE FROM companies WHERE id=$1', [req.params.id]);
    await auditLog({ userId: req.user.id, action: 'DELETE', entityType: 'company',
                     entityId: req.params.id, oldValues: { name: r.rows[0].name }, req });
    return sendSuccess(res, {}, 'Company deleted');
  } catch (err) {
    return sendError(res, err.message || 'Failed to delete company', 500);
  }
};

module.exports = {
  getCompanies, getCompanyById, createCompany, updateCompany, deleteCompany,
  getCompanyStats, getCompanyDependencies, getCompanyChanges,
};

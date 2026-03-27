const crypto = require('crypto');
const { query, transaction } = require('../config/database');
const { sendSuccess, sendError, sendPaginated, auditLog, getPagination, buildPaginationMeta } = require('../utils/helpers');
const { syncWebServiceChanges, getDependencies, getEntityChangeHistory } = require('../utils/syncService');

/**
 * @swagger
 * tags:
 *   name: Web Services
 *   description: Third-party API and internal microservice management
 */

/**
 * @swagger
 * /api/web-services:
 *   get:
 *     summary: Get all web services
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of web services retrieved successfully
 */
const getServices = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const { search, status, environment } = req.query;
    const conds = ['1=1'], params = [];
    let idx = 1;
    if (search)      { conds.push(`(ws.name ILIKE $${idx} OR ws.slug ILIKE $${idx} OR ws.base_url ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    if (status)      { conds.push(`ws.status=$${idx++}`);       params.push(status); }
    if (environment) { conds.push(`ws.environment=$${idx++}`);  params.push(environment); }
    const where = conds.join(' AND ');
    const countRes = await query(`SELECT COUNT(*) FROM web_services ws WHERE ${where}`, params);
    const rows = await query(
      `SELECT ws.*,
              (SELECT COUNT(*) FROM ws_endpoints e WHERE e.service_id=ws.id AND e.is_active=true) as endpoint_count,
              (SELECT COUNT(*) FROM ws_api_keys k WHERE k.service_id=ws.id AND k.is_active=true) as key_count,
              (SELECT COUNT(*) FROM ws_logs l WHERE l.service_id=ws.id AND l.created_at > NOW()-INTERVAL '24h') as calls_24h
       FROM web_services ws
       WHERE ${where}
       ORDER BY ws.name
       LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    );
    return sendPaginated(res, rows.rows, buildPaginationMeta(countRes.rows[0].count, page, limit));
  } catch (err) { console.error(err); return sendError(res, 'Failed to fetch services', 500); }
};

/**
 * @swagger
 * /api/web-services/{id}:
 *   get:
 *     summary: Get service by ID
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Web service details, endpoints, and history
 */
const getServiceById = async (req, res) => {
  try {
    const r = await query(`SELECT * FROM web_services WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return sendError(res, 'Service not found', 404);
    const [endpoints, keys, recentLogs, changeHistory] = await Promise.all([
      query(`SELECT * FROM ws_endpoints WHERE service_id=$1 ORDER BY method, path`, [req.params.id]),
      query(`SELECT id, name, key_prefix, scopes, expires_at, is_active, last_used, usage_count, created_at
             FROM ws_api_keys WHERE service_id=$1 ORDER BY created_at DESC`, [req.params.id]),
      query(`SELECT l.*, u.first_name, u.last_name FROM ws_logs l LEFT JOIN users u ON u.id=l.user_id
             WHERE l.service_id=$1 ORDER BY l.created_at DESC LIMIT 20`, [req.params.id]),
      getEntityChangeHistory('web_service', req.params.id, 10),
    ]);
    return sendSuccess(res, { ...r.rows[0], endpoints: endpoints.rows, apiKeys: keys.rows, recentLogs: recentLogs.rows, changeHistory });
  } catch (err) { return sendError(res, 'Failed to fetch service', 500); }
};

/**
 * @swagger
 * /api/web-services:
 *   post:
 *     summary: Create new web service
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Service created successfully
 */
const createService = async (req, res) => {
  const d = req.body;
  try {
    const slug = (d.slug || d.name).toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
    const exists = await query('SELECT id FROM web_services WHERE slug=$1', [slug]);
    if (exists.rows.length) return sendError(res, 'Service slug already exists', 409);
    const r = await query(
      `INSERT INTO web_services (name,slug,description,base_url,version,auth_type,status,environment,timeout_ms,retry_count,rate_limit,tags,is_active,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [d.name,slug,d.description,d.baseUrl,d.version||'v1',d.authType||'api_key',d.status||'active',
       d.environment||'production',d.timeoutMs||30000,d.retryCount||3,d.rateLimit||100,d.tags||[],d.isActive!==false,req.user.id]
    );
    await auditLog({ userId: req.user.id, action: 'CREATE', entityType: 'web_service',
                     entityId: r.rows[0].id, newValues: { name: d.name, baseUrl: d.baseUrl }, req });
    return sendSuccess(res, r.rows[0], 'Web service created', 201);
  } catch (err) { console.error(err); return sendError(res, err.message||'Failed to create service', 500); }
};

/**
 * @swagger
 * /api/web-services/{id}:
 *   put:
 *     summary: Update web service
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Service updated
 */
const updateService = async (req, res) => {
  const { id } = req.params;
  const d = req.body;
  try {
    const old = await query('SELECT * FROM web_services WHERE id=$1', [id]);
    if (!old.rows.length) return sendError(res, 'Service not found', 404);
    const oldData = old.rows[0];

    await query(
      `UPDATE web_services SET name=$1,description=$2,base_url=$3,version=$4,auth_type=$5,status=$6,environment=$7,timeout_ms=$8,retry_count=$9,rate_limit=$10,tags=$11,is_active=$12 WHERE id=$13`,
      [d.name,d.description,d.baseUrl,d.version,d.authType,d.status,d.environment,d.timeoutMs||30000,d.retryCount||3,d.rateLimit||100,d.tags||[],d.isActive!==false,id]
    );

    /* ── CASCADING SYNC ── */
    const newData = { ...d, id, is_active: d.isActive !== false };
    const syncResult = await syncWebServiceChanges(id, oldData, newData, req.user.id);

    await auditLog({ userId: req.user.id, action: 'UPDATE', entityType: 'web_service', entityId: id,
                     oldValues: { name: oldData.name, status: oldData.status, base_url: oldData.base_url },
                     newValues: { name: d.name, status: d.status, base_url: d.baseUrl }, req });

    return sendSuccess(res, {
      message: 'Service updated',
      syncSummary: { adminsNotified: syncResult.adminsNotified }
    }, 'Service updated and changes propagated');
  } catch (err) { return sendError(res, 'Failed to update service', 500); }
};

/**
 * @swagger
 * /api/web-services/{id}:
 *   delete:
 *     summary: Delete web service
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Service deleted
 */
const deleteService = async (req, res) => {
  try {
    const r = await query('SELECT id, name FROM web_services WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return sendError(res, 'Service not found', 404);
    await query('DELETE FROM web_services WHERE id=$1', [req.params.id]);
    await auditLog({ userId: req.user.id, action: 'DELETE', entityType: 'web_service',
                     entityId: req.params.id, oldValues: { name: r.rows[0].name }, req });
    return sendSuccess(res, {}, 'Service deleted');
  } catch (err) { return sendError(res, 'Failed to delete service', 500); }
};

/**
 * @swagger
 * /api/web-services/{id}/endpoints:
 *   get:
 *     summary: Get endpoints for a web service
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of endpoints found
 */
const getEndpoints = async (req, res) => {
  try {
    const rows = await query(`SELECT * FROM ws_endpoints WHERE service_id=$1 ORDER BY method, path`, [req.params.id]);
    return sendSuccess(res, rows.rows);
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/web-services/{id}/endpoints:
 *   post:
 *     summary: Create new endpoint for a web service
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       201:
 *         description: Endpoint created
 */
const createEndpoint = async (req, res) => {
  const d = req.body;
  try {
    const svc = await query('SELECT id FROM web_services WHERE id=$1', [req.params.id]);
    if (!svc.rows.length) return sendError(res, 'Service not found', 404);
    const r = await query(
      `INSERT INTO ws_endpoints (service_id,name,method,path,description,auth_required,is_active,request_schema,response_schema,headers,sample_payload,tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.params.id,d.name,d.method||'GET',d.path,d.description,d.authRequired!==false,d.isActive!==false,
       JSON.stringify(d.requestSchema||{}),JSON.stringify(d.responseSchema||{}),JSON.stringify(d.headers||{}),
       d.samplePayload?JSON.stringify(d.samplePayload):null,d.tags||[]]
    );
    return sendSuccess(res, r.rows[0], 'Endpoint created', 201);
  } catch (err) { console.error(err); return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/web-services/{id}/endpoints/{epId}:
 *   put:
 *     summary: Update an endpoint
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: epId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Endpoint updated
 */
const updateEndpoint = async (req, res) => {
  const d = req.body;
  try {
    const r = await query(
      `UPDATE ws_endpoints SET name=$1,method=$2,path=$3,description=$4,auth_required=$5,is_active=$6,request_schema=$7,response_schema=$8,headers=$9,sample_payload=$10,tags=$11 WHERE id=$12 RETURNING *`,
      [d.name,d.method,d.path,d.description,d.authRequired!==false,d.isActive!==false,
       JSON.stringify(d.requestSchema||{}),JSON.stringify(d.responseSchema||{}),JSON.stringify(d.headers||{}),
       d.samplePayload?JSON.stringify(d.samplePayload):null,d.tags||[],req.params.epId]
    );
    if (!r.rows.length) return sendError(res, 'Endpoint not found', 404);
    return sendSuccess(res, r.rows[0]);
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/web-services/{id}/endpoints/{epId}:
 *   delete:
 *     summary: Delete an endpoint
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: epId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Endpoint deleted
 */
const deleteEndpoint = async (req, res) => {
  try {
    const r = await query('DELETE FROM ws_endpoints WHERE id=$1 RETURNING id', [req.params.epId]);
    if (!r.rows.length) return sendError(res, 'Endpoint not found', 404);
    return sendSuccess(res, {}, 'Endpoint deleted');
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/web-services/{id}/api-keys:
 *   post:
 *     summary: Generate new API key for a service
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       201:
 *         description: API key generated
 */
const generateApiKey = async (req, res) => {
  const { name, scopes, expiresAt } = req.body;
  try {
    const rawKey  = `sk_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const prefix  = rawKey.substring(0, 10) + '...';
    const r = await query(
      `INSERT INTO ws_api_keys (service_id,name,key_hash,key_prefix,scopes,expires_at,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, key_prefix, scopes, expires_at, created_at`,
      [req.params.id,name||'API Key',keyHash,prefix,scopes||[],expiresAt||null,req.user.id]
    );
    return sendSuccess(res, { ...r.rows[0], rawKey }, 'API key generated — save it now!', 201);
  } catch (err) { console.error(err); return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/web-services/{id}/api-keys/{keyId}:
 *   delete:
 *     summary: Revoke an API key
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: keyId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: API key revoked
 */
const revokeApiKey = async (req, res) => {
  try {
    await query('UPDATE ws_api_keys SET is_active=false WHERE id=$1', [req.params.keyId]);
    return sendSuccess(res, {}, 'API key revoked');
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/web-services/{id}/logs:
 *   get:
 *     summary: Get service execution logs
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Logs retrieved
 */
const getServiceLogs = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const countRes = await query(`SELECT COUNT(*) FROM ws_logs WHERE service_id=$1`, [req.params.id]);
    const rows = await query(
      `SELECT l.*, u.first_name, u.last_name FROM ws_logs l LEFT JOIN users u ON u.id=l.user_id
       WHERE l.service_id=$1 ORDER BY l.created_at DESC LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    return sendPaginated(res, rows.rows, buildPaginationMeta(countRes.rows[0].count, page, limit));
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/web-services/stats:
 *   get:
 *     summary: Get web services global stats
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Stats retrieved successfully
 */
const getServiceStats = async (req, res) => {
  try {
    const stats = await query(`
      SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE status='active' AND is_active=true) as active,
             COUNT(*) FILTER (WHERE status='inactive') as inactive,
             COUNT(*) FILTER (WHERE status='maintenance') as maintenance,
             COUNT(*) FILTER (WHERE environment='production') as production,
             COUNT(*) FILTER (WHERE environment='staging') as staging,
             (SELECT COUNT(*) FROM ws_endpoints WHERE is_active=true) as total_endpoints,
             (SELECT COUNT(*) FROM ws_api_keys WHERE is_active=true) as active_keys,
             (SELECT COUNT(*) FROM ws_logs WHERE created_at > NOW()-INTERVAL '24h') as calls_24h
      FROM web_services
    `);
    return sendSuccess(res, stats.rows[0]);
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/web-services/{id}/health:
 *   post:
 *     summary: Trigger manual health check
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Health check completed
 */
const testServiceHealth = async (req, res) => {
  const { id } = req.params;
  try {
    const svc = await query('SELECT * FROM web_services WHERE id=$1', [id]);
    if (!svc.rows.length) return sendError(res, 'Service not found', 404);
    const start = Date.now();
    let status = 'unknown', statusCode = null, error = null;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      const response = await fetch(svc.rows[0].base_url, { method: 'GET', signal: ctrl.signal, headers: { 'User-Agent': 'AdminPanel-HealthCheck/1.0' } });
      clearTimeout(timeout);
      statusCode = response.status;
      status = response.ok ? 'healthy' : 'degraded';
    } catch (e) { status = 'down'; error = e.message; }
    const responseTime = Date.now() - start;
    await query(`UPDATE web_services SET last_checked=NOW(), last_status=$1 WHERE id=$2`, [status, id]);
    await query(
      `INSERT INTO ws_logs (service_id,method,path,status_code,response_time_ms,request_ip,metadata) VALUES ($1,'GET','/',$2,$3,$4,$5)`,
      [id, statusCode, responseTime, req.ip, JSON.stringify({ healthCheck: true, error })]
    );
    return sendSuccess(res, { status, statusCode, responseTime, error, checkedAt: new Date() });
  } catch (err) { return sendError(res, 'Health check failed', 500); }
};

/**
 * @swagger
 * /api/web-services/{id}/changes:
 *   get:
 *     summary: Get service change history
 *     tags: [Web Services]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: History retrieved
 */
const getServiceChanges = async (req, res) => {
  try {
    const history = await getEntityChangeHistory('web_service', req.params.id, 20);
    return sendSuccess(res, history);
  } catch (err) { return sendError(res, 'Failed', 500); }
};

module.exports = {
  getServices, getServiceById, createService, updateService, deleteService,
  getEndpoints, createEndpoint, updateEndpoint, deleteEndpoint,
  generateApiKey, revokeApiKey, getServiceLogs, getServiceStats,
  testServiceHealth, getServiceChanges,
};

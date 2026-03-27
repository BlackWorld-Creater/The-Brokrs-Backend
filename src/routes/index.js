const express = require('express');
const router = express.Router();

const { authenticate, requireRole, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { loginValidator, registerValidator, changePasswordValidator } = require('../validators/auth.validator');

const authController       = require('../controllers/auth.controller');
const usersController      = require('../controllers/users.controller');
const rolesController      = require('../controllers/roles.controller');
const dashboardController  = require('../controllers/dashboard.controller');
const verticalsController  = require('../controllers/verticals.controller');
const modulesController    = require('../controllers/modules.controller');
const ipController         = require('../controllers/iptracking.controller');

// ─── AUTH ─────────────────────────────────────────────────────────────────────
const authRouter = express.Router();
authRouter.post('/login',           loginValidator, validate, authController.login);
authRouter.post('/refresh',         authController.refreshToken);
authRouter.post('/logout',          authenticate, authController.logout);
authRouter.get('/me',               authenticate, authController.getMe);
authRouter.put('/profile',          authenticate, authController.updateProfile);
authRouter.put('/change-password',  authenticate, changePasswordValidator, validate, authController.changePassword);

// ─── USERS ────────────────────────────────────────────────────────────────────
const usersRouter = express.Router();
usersRouter.use(authenticate);
usersRouter.get('/stats',             requirePermission('users', 'read'),   usersController.getUserStats);
usersRouter.get('/',                  requirePermission('users', 'read'),   usersController.getUsers);
usersRouter.get('/:id',               requirePermission('users', 'read'),   usersController.getUserById);
usersRouter.post('/',                 requirePermission('users', 'create'), registerValidator, validate, usersController.createUser);
usersRouter.put('/:id',               requirePermission('users', 'update'), usersController.updateUser);
usersRouter.delete('/:id',            requirePermission('users', 'delete'), usersController.deleteUser);
usersRouter.put('/:id/permissions',   requirePermission('roles', 'manage'), usersController.updateUserPermissions);
usersRouter.get('/:id/login-history', requirePermission('users', 'read'), usersController.getUserLoginHistory);
usersRouter.post('/:id/reset-password', requirePermission('users', 'update'), usersController.resetUserPassword);

// ─── ROLES ────────────────────────────────────────────────────────────────────
const rolesRouter = express.Router();
rolesRouter.use(authenticate);
rolesRouter.get('/',                    requirePermission('roles', 'read'),   rolesController.getRoles);
rolesRouter.get('/:id',                 requirePermission('roles', 'read'),   rolesController.getRoleById);
rolesRouter.post('/',                   requirePermission('roles', 'create'), rolesController.createRole);
rolesRouter.put('/:id',                 requirePermission('roles', 'update'), rolesController.updateRole);
rolesRouter.delete('/:id',              requirePermission('roles', 'delete'), rolesController.deleteRole);
rolesRouter.put('/:roleId/permissions', requirePermission('roles', 'manage'), rolesController.updateRolePermissions);

// ─── MODULES (simple list for frontend nav) ───────────────────────────────────
const modulesListRouter = express.Router();
modulesListRouter.get('/', authenticate, rolesController.getModules);

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
const dashboardRouter = express.Router();
dashboardRouter.use(authenticate);
dashboardRouter.get('/stats', requirePermission('dashboard', 'read'), dashboardController.getDashboardStats);

// ─── DEPARTMENTS ─────────────────────────────────────────────────────────────
const deptsRouter = express.Router();
deptsRouter.use(authenticate);
deptsRouter.get('/',     requirePermission('departments', 'read'),   dashboardController.getDepartments);
deptsRouter.post('/',    requirePermission('departments', 'create'), dashboardController.createDepartment);
deptsRouter.delete('/:id', requirePermission('departments', 'delete'), dashboardController.deleteDepartment);
deptsRouter.put('/:id',  requirePermission('departments', 'update'), dashboardController.updateDepartment);

// ─── AUDIT LOGS ───────────────────────────────────────────────────────────────
const auditRouter = express.Router();
auditRouter.use(authenticate);
auditRouter.get('/', requirePermission('audit', 'read'), dashboardController.getAuditLogs);

// ─── NOTIFICATIONS ───────────────────────────────────────────────────────────
const notifRouter = express.Router();
notifRouter.use(authenticate);
notifRouter.get('/',         dashboardController.getNotifications);
notifRouter.put('/read-all', dashboardController.markAllNotificationsRead);

// ─── SETTINGS ────────────────────────────────────────────────────────────────
const settingsRouter = express.Router();
settingsRouter.use(authenticate);
settingsRouter.get('/', dashboardController.getSettings);
settingsRouter.put('/', requirePermission('settings', 'manage'), dashboardController.updateSettings);

// ─── VERTICALS ────────────────────────────────────────────────────────────────
const verticalsRouter = express.Router();
verticalsRouter.use(authenticate);
verticalsRouter.get('/',       requirePermission('verticals', 'read'),   verticalsController.getVerticals);
verticalsRouter.get('/:id',    requirePermission('verticals', 'read'),   verticalsController.getVerticalById);
verticalsRouter.post('/',      requirePermission('verticals', 'create'), verticalsController.createVertical);
verticalsRouter.put('/:id',    requirePermission('verticals', 'update'), verticalsController.updateVertical);
verticalsRouter.delete('/:id', requirePermission('verticals', 'delete'), verticalsController.deleteVertical);

// ─── MODULES MANAGER ─────────────────────────────────────────────────────────
const modulesManageRouter = express.Router();
modulesManageRouter.use(authenticate);
modulesManageRouter.get('/',                  requirePermission('modules', 'read'),   modulesController.getAllModules);
modulesManageRouter.post('/',               requirePermission('modules', 'manage'), modulesController.createModule);
modulesManageRouter.put('/:id',               requirePermission('modules', 'manage'), modulesController.updateModule);
modulesManageRouter.put('/:id/toggle',        requirePermission('modules', 'manage'), modulesController.toggleModule);
modulesManageRouter.get('/:id/permissions',   requirePermission('modules', 'read'),   modulesController.getModulePermissions);

// ─── IP TRACKING ──────────────────────────────────────────────────────────────
const ipRouter = express.Router();
ipRouter.use(authenticate);
ipRouter.get('/stats',        requirePermission('audit', 'read'),   ipController.getIPStats);
ipRouter.get('/blocked',      requirePermission('audit', 'read'),   ipController.getBlockedIPs);
ipRouter.post('/block',       requirePermission('audit', 'manage'), ipController.blockIP);
ipRouter.delete('/block/:ip', requirePermission('audit', 'manage'), ipController.unblockIP);
ipRouter.get('/lookup/:ip',   requirePermission('audit', 'read'),   ipController.lookupIP);
ipRouter.get('/',             requirePermission('audit', 'read'),   ipController.getIPLogs);

// ─── MOUNT ALL ────────────────────────────────────────────────────────────────
router.use('/auth',           authRouter);
router.use('/users',          usersRouter);
router.use('/roles',          rolesRouter);
router.use('/modules',        modulesListRouter);
router.use('/modules/manage', modulesManageRouter);
router.use('/dashboard',      dashboardRouter);
router.use('/departments',    deptsRouter);
router.use('/audit-logs',     auditRouter);
router.use('/notifications',  notifRouter);
router.use('/settings',       settingsRouter);
router.use('/verticals',      verticalsRouter);
router.use('/ip-tracking',    ipRouter);

module.exports = router;

// ─── COMPANY MASTER ──────────────────────────────────────────────────────────
const companyController = require('../controllers/company.controller');
const companyRouter = express.Router();
companyRouter.use(authenticate);
companyRouter.get('/stats',  requirePermission('company','read'),   companyController.getCompanyStats);
companyRouter.get('/',       requirePermission('company','read'),   companyController.getCompanies);
companyRouter.get('/:id',    requirePermission('company','read'),   companyController.getCompanyById);
companyRouter.post('/',      requirePermission('company','create'), companyController.createCompany);
companyRouter.put('/:id',    requirePermission('company','update'), companyController.updateCompany);
companyRouter.delete('/:id', requirePermission('company','delete'), companyController.deleteCompany);

// ─── SITE MASTER ─────────────────────────────────────────────────────────────
const sitesController = require('../controllers/sites.controller');
const sitesRouter = express.Router();
sitesRouter.use(authenticate);
sitesRouter.get('/by-company/:companyId', requirePermission('sites','read'),  sitesController.getSitesByCompany);
sitesRouter.get('/',       requirePermission('sites','read'),   sitesController.getSites);
sitesRouter.get('/:id',    requirePermission('sites','read'),   sitesController.getSiteById);
sitesRouter.post('/',      requirePermission('sites','create'), sitesController.createSite);
sitesRouter.put('/:id',    requirePermission('sites','update'), sitesController.updateSite);
sitesRouter.delete('/:id', requirePermission('sites','delete'), sitesController.deleteSite);

// ─── WEB SERVICES ─────────────────────────────────────────────────────────────
const wsController = require('../controllers/webservices.controller');
const wsRouter = express.Router();
wsRouter.use(authenticate);
wsRouter.get('/stats',                  requirePermission('web-services','read'),   wsController.getServiceStats);
wsRouter.get('/',                       requirePermission('web-services','read'),   wsController.getServices);
wsRouter.post('/',                      requirePermission('web-services','create'), wsController.createService);
wsRouter.get('/:id',                    requirePermission('web-services','read'),   wsController.getServiceById);
wsRouter.put('/:id',                    requirePermission('web-services','update'), wsController.updateService);
wsRouter.delete('/:id',                 requirePermission('web-services','delete'), wsController.deleteService);
wsRouter.get('/:id/endpoints',          requirePermission('web-services','read'),   wsController.getEndpoints);
wsRouter.post('/:id/endpoints',         requirePermission('web-services','create'), wsController.createEndpoint);
wsRouter.put('/:id/endpoints/:epId',    requirePermission('web-services','update'), wsController.updateEndpoint);
wsRouter.delete('/:id/endpoints/:epId', requirePermission('web-services','delete'), wsController.deleteEndpoint);
wsRouter.post('/:id/api-keys',          requirePermission('web-services','manage'), wsController.generateApiKey);
wsRouter.delete('/:id/api-keys/:keyId', requirePermission('web-services','manage'), wsController.revokeApiKey);
wsRouter.get('/:id/logs',               requirePermission('web-services','read'),   wsController.getServiceLogs);
wsRouter.post('/:id/health-check',      requirePermission('web-services','read'),   wsController.testServiceHealth);

router.use('/companies',     companyRouter);
router.use('/sites',         sitesRouter);
router.use('/web-services',  wsRouter);

// ─── ADDITIONAL SYNC ROUTES ────────────────────────────────────────────────────
// These are appended to existing routers already defined above
// Company change history + dependencies
companyRouter.get('/:id/dependencies', requirePermission('company','read'), companyController.getCompanyDependencies);
companyRouter.get('/:id/changes',      requirePermission('company','read'), companyController.getCompanyChanges);
// Site change history
sitesRouter.get('/:id/changes',        requirePermission('sites','read'), sitesController.getSiteChanges);
// Web service change history
wsRouter.get('/:id/changes',           requirePermission('web-services','read'), wsController.getServiceChanges);

// ─── TASKS ────────────────────────────────────────────────────────────────────
const tasksController = require('../controllers/tasks.controller');
const tasksRouter = express.Router();
tasksRouter.use(authenticate);
tasksRouter.get('/stats',                        requirePermission('tasks','read'),   tasksController.getTaskStats);
tasksRouter.get('/',                             requirePermission('tasks','read'),   tasksController.getTasks);
tasksRouter.post('/',                            requirePermission('tasks','create'), tasksController.createTask);
tasksRouter.get('/:id',                          requirePermission('tasks','read'),   tasksController.getTaskById);
tasksRouter.put('/:id',                          requirePermission('tasks','update'), tasksController.updateTask);
tasksRouter.patch('/:id/status',                 requirePermission('tasks','update'), tasksController.updateStatus);
tasksRouter.delete('/:id',                       requirePermission('tasks','delete'), tasksController.deleteTask);
tasksRouter.post('/:id/comments',                requirePermission('tasks','read'),   tasksController.addComment);
tasksRouter.delete('/:id/comments/:commentId',   requirePermission('tasks','read'),   tasksController.deleteComment);
router.use('/tasks', tasksRouter);

// ─── ENHANCED NOTIFICATIONS ────────────────────────────────────────────────────
const notificationsController = require('../controllers/notifications.controller');
// Override existing notif routes with enhanced controller
notifRouter.get('/count',        notificationsController.getUnreadCount);
notifRouter.put('/:id/read',     notificationsController.markOneRead);
notifRouter.delete('/:id',       notificationsController.deleteNotification);
notifRouter.delete('/',          notificationsController.clearRead);
// Override the base GET and read-all with enhanced versions
// (already mounted at /notifications, add overrides)
router.get('/notifications',          authenticate, notificationsController.getNotifications);
router.put('/notifications/read-all', authenticate, notificationsController.markAllRead);

// ─── HR ───────────────────────────────────────────────────────────────────────
const hrController = require('../controllers/hr.controller');
const hrRouter = express.Router();
hrRouter.use(authenticate);
hrRouter.get('/stats',         requirePermission('hr','read'),   hrController.getHRStats);
hrRouter.get('/',              requirePermission('hr','read'),   hrController.getEmployees);
hrRouter.get('/:id',           requirePermission('hr','read'),   hrController.getEmployeeById);
hrRouter.put('/:id/profile',   requirePermission('hr','update'), hrController.upsertEmployeeProfile);
router.use('/hr', hrRouter);

// ─── ATTENDANCE ────────────────────────────────────────────────────────────────
const attendanceController = require('../controllers/attendance.controller');
const attendanceRouter = express.Router();
attendanceRouter.use(authenticate);
attendanceRouter.get('/stats',  requirePermission('attendance','read'),   attendanceController.getAttendanceStats);
attendanceRouter.get('/my',     authenticate,                             attendanceController.getMyAttendance);
attendanceRouter.post('/checkin',  authenticate,                          attendanceController.checkIn);
attendanceRouter.post('/checkout', authenticate,                          attendanceController.checkOut);
attendanceRouter.get('/',       requirePermission('attendance','read'),   attendanceController.getAttendance);
attendanceRouter.post('/',      requirePermission('attendance','create'), attendanceController.markAttendance);
router.use('/attendance', attendanceRouter);

// ─── LEAVE ────────────────────────────────────────────────────────────────────
const leaveController = require('../controllers/leave.controller');
const leaveRouter = express.Router();
leaveRouter.use(authenticate);
leaveRouter.get('/stats',      requirePermission('leave','read'),   leaveController.getLeaveStats);
leaveRouter.get('/',           requirePermission('leave','read'),   leaveController.getLeaveRequests);
leaveRouter.post('/',          authenticate,                        leaveController.createLeaveRequest);
leaveRouter.put('/:id/status', requirePermission('leave','approve'), leaveController.updateLeaveStatus);
leaveRouter.delete('/:id',     authenticate,                        leaveController.deleteLeaveRequest);
router.use('/leave', leaveRouter);

// ─── PROJECTS ──────────────────────────────────────────────────────────────────
const projectsController = require('../controllers/projects.controller');
const projectsRouter = express.Router();
projectsRouter.use(authenticate);
projectsRouter.get('/stats',   requirePermission('projects','read'),   projectsController.getProjectStats);
projectsRouter.get('/',        requirePermission('projects','read'),   projectsController.getProjects);
projectsRouter.post('/',       requirePermission('projects','create'), projectsController.createProject);
projectsRouter.get('/:id',     requirePermission('projects','read'),   projectsController.getProjectById);
projectsRouter.put('/:id',     requirePermission('projects','update'), projectsController.updateProject);
projectsRouter.delete('/:id',  requirePermission('projects','delete'), projectsController.deleteProject);
router.use('/projects', projectsRouter);

// ─── REPORTS ───────────────────────────────────────────────────────────────────
const reportsController = require('../controllers/reports.controller');
const reportsRouter = express.Router();
reportsRouter.use(authenticate);
reportsRouter.get('/headcount',  requirePermission('reports','read'), reportsController.getHeadcountReport);
reportsRouter.get('/attendance', requirePermission('reports','read'), reportsController.getAttendanceReport);
reportsRouter.get('/leave',      requirePermission('reports','read'), reportsController.getLeaveReport);
reportsRouter.get('/tasks',      requirePermission('reports','read'), reportsController.getTasksReport);
reportsRouter.get('/projects',   requirePermission('reports','read'), reportsController.getProjectsReport);
router.use('/reports', reportsRouter);

// ─── EMAIL SETTINGS ───────────────────────────────────────────────────────────
const emailController = require('../controllers/email.controller');
const emailRouter = express.Router();
emailRouter.use(authenticate);
emailRouter.get('/',            requirePermission('settings','read'),   emailController.getEmailSettings);
emailRouter.put('/',            requirePermission('settings','manage'), emailController.saveEmailSettings);
emailRouter.post('/test-connection', requirePermission('settings','manage'), emailController.testEmailConnection);
emailRouter.post('/send-test',  requirePermission('settings','manage'), emailController.sendTestEmail);
emailRouter.get('/logs',        requirePermission('settings','read'),   emailController.getEmailLogs);
router.use('/email-settings', emailRouter);

// ─── USER DASHBOARD ───────────────────────────────────────────────────────────
router.get('/user-dashboard', authenticate, emailController.getUserDashboard);

// ─── CHAT ─────────────────────────────────────────────────────────────────────
const chatController = require('../controllers/chat.controller');
const chatRouter = express.Router();
chatRouter.use(authenticate); 
chatRouter.get('/users',                          chatController.getChatUsers);
chatRouter.get('/rooms',                          chatController.getRooms);
chatRouter.post('/rooms/direct',                  chatController.openDirectChat);
chatRouter.post('/rooms/group',                   chatController.createGroupChat);
chatRouter.get('/rooms/:roomId/messages',         chatController.getMessages);
chatRouter.post('/rooms/:roomId/messages',        chatController.sendMessage);
chatRouter.get('/rooms/:roomId/members',          chatController.getRoomMembers);
chatRouter.post('/rooms/:roomId/members',         chatController.addMembers);
chatRouter.delete('/rooms/:roomId/leave',         chatController.leaveRoom);
chatRouter.put('/rooms/:roomId/read',             chatController.markRoomRead);
chatRouter.put('/messages/:msgId',                chatController.editMessage);
chatRouter.delete('/messages/:msgId',             chatController.deleteMessage);
chatRouter.post('/messages/:msgId/react',         chatController.reactToMessage);
router.use('/chat', chatRouter);

// ─── CUSTOMER SUPPORT ────────────────────────────────────────────────────────
const supportController = require('../controllers/support.controller');
const supportRouter = express.Router();
supportRouter.get('/tickets', supportController.getTickets);
supportRouter.post('/tickets', supportController.createTicket);
supportRouter.get('/tickets/:id/messages', supportController.getMessages);
supportRouter.post('/tickets/:id/messages', supportController.sendMessage);
router.use('/support', supportRouter);

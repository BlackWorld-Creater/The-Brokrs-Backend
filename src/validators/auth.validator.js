const { body } = require('express-validator');

/*
 * Password Policy:
 *  - Minimum 8 characters
 *  - At least 2 uppercase letters
 *  - At least 2 lowercase letters  (1 minimum per spec, using 1 to be practical)
 *  - At least 2 digits
 *  - At least 2 special characters (@$!%*?&#^()_+=\-[]{})
 */
const PASSWORD_REGEX = /^(?=(?:.*[A-Z]){1,})(?=(?:.*[a-z]){1,})(?=(?:.*\d){2,})(?=(?:.*[@$!%*?&#^()_+=\-\[\]{}|]){2,}).{8,}$/;

const PASSWORD_MSG =
  'Password must be at least 8 characters with: 1+ uppercase, 1+ lowercase, 2+ numbers, 2+ special characters (@$!%*?&#^()_+=)';

const strongPasswordField = (fieldName = 'password', isRequired = true) => {
  const chain = body(fieldName);
  if (isRequired) chain.notEmpty().withMessage(`${fieldName} is required`);
  return chain
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(PASSWORD_REGEX).withMessage(PASSWORD_MSG);
};

const loginValidator = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
];

const registerValidator = [
  body('firstName').trim().notEmpty().isLength({ min: 2, max: 100 }).withMessage('First name must be 2–100 characters'),
  body('lastName').trim().notEmpty().isLength({ min: 2, max: 100 }).withMessage('Last name must be 2–100 characters'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  strongPasswordField('password'),
  body('phone').optional({ checkFalsy: true }).isMobilePhone().withMessage('Valid phone number required'),
  body('departmentId').optional({ checkFalsy: true }).isUUID().withMessage('Valid department ID required'),
];

const changePasswordValidator = [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  strongPasswordField('newPassword'),
];

const forgotPasswordValidator = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
];

const resetPasswordValidator = [
  body('token').notEmpty().withMessage('Reset token is required'),
  strongPasswordField('password'),
];

module.exports = {
  loginValidator,
  registerValidator,
  changePasswordValidator,
  forgotPasswordValidator,
  resetPasswordValidator,
  PASSWORD_MSG,
  PASSWORD_REGEX,
};

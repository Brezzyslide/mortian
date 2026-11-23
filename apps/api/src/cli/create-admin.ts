/**
 * Creates the first super_admin. Run once per environment:
 *   ADMIN_EMAIL=you@company.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='...' node dist/cli/create-admin.js
 * The password is read from the environment so it does not land in shell history as an argument.
 * Sign in afterwards to enrol TOTP; no staff session is issued before that.
 */
import pg from 'pg';
import { SandboxMessaging } from '@project/adapters';
import { IdentityService } from '@project/identity';
import { loadConfig } from '../config.js';

const config = loadConfig();
const { ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD } = process.env;
if (!ADMIN_EMAIL || !ADMIN_NAME || !ADMIN_PASSWORD) {
  console.error('ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD are required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 });
const identity = new IdentityService(pool, new SandboxMessaging(), {
  issuer: config.AUTH_ISSUER,
  jwtSecret: config.AUTH_JWT_SECRET,
  otpPepper: config.AUTH_OTP_PEPPER,
  fieldKey: config.AUTH_FIELD_KEY,
});

try {
  const id = await identity.createStaffMember({
    email: ADMIN_EMAIL,
    fullName: ADMIN_NAME,
    password: ADMIN_PASSWORD,
    roles: ['super_admin'],
    grantedBy: null,
  });
  console.log(`Created super_admin ${id}`);
} finally {
  await pool.end();
}

import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import pg from 'pg';
import { CustomerDocumentService } from '@project/finance';
import { normalizeNigerianMobile, type AccessClaims } from '@project/identity';
import { Auth, StaffRoles } from '../auth/decorators.js';
import { parseBody } from '../http.js';
import { PG_POOL } from '../infra.module.js';

const CUSTOMER_ROLES = ['customer', 'rider', 'merchant'];
/** Roles that may see ID documents (the same roles that may open and review them). */
const DOCUMENT_ROLES = ['underwriter', 'manager', 'super_admin'];

/**
 * Staff look-up of customers, whether or not they have applied for anything. Searching by
 * phone takes any common Nigerian format; an FA- reference finds the account holder.
 */
@Controller('admin/customers')
export class CustomersController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(CustomerDocumentService) private readonly docs: CustomerDocumentService,
  ) {}

  @StaffRoles('underwriter', 'collections', 'finance', 'manager')
  @Get()
  async search(@Query('q') qRaw?: string) {
    const q = (qRaw ?? '').trim().slice(0, 100);
    const phone = q ? normalizeNigerianMobile(q) : null;
    const reference = /^FA-\d{6,}$/i.test(q) ? q.toUpperCase() : null;
    // Name search: escape LIKE wildcards so "%" or "_" match literally.
    const name = !phone && !reference && q.length >= 2 ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    if (q && !phone && !reference && !name) return { customers: [] };
    const { rows } = await this.pool.query(
      `SELECT p.id, p.full_name AS "fullName", p.phone, p.status, p.created_at AS "createdAt",
              (SELECT count(*)::int FROM finance_account f WHERE f.person_id = p.id) AS "accounts",
              (SELECT count(*)::int FROM customer_document d WHERE d.person_id = p.id AND d.status = 'submitted') AS "documentsToReview"
         FROM person p
        WHERE EXISTS (SELECT 1 FROM person_role r WHERE r.person_id = p.id AND r.role = ANY($1))
          AND ($2::text IS NULL OR p.phone = $2)
          AND ($3::text IS NULL OR p.full_name ILIKE $3)
          AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM finance_account f WHERE f.person_id = p.id AND f.reference = $4))
        ORDER BY p.created_at DESC
        LIMIT 50`,
      [CUSTOMER_ROLES, phone, name, reference],
    );
    return { customers: rows };
  }

  @StaffRoles('underwriter', 'collections', 'finance', 'manager')
  @Get(':id')
  async one(@Param('id') idRaw: string, @Auth() auth: AccessClaims) {
    const id = parseBody(z.uuid(), idRaw);
    const p = (
      await this.pool.query(
        `SELECT p.id, p.full_name AS "fullName", p.phone, p.status, p.created_at AS "createdAt",
                array(SELECT r.role FROM person_role r WHERE r.person_id = p.id AND r.role = ANY($2) ORDER BY r.role) AS roles
           FROM person p
          WHERE p.id = $1 AND EXISTS (SELECT 1 FROM person_role r WHERE r.person_id = p.id AND r.role = ANY($2))`,
        [id, CUSTOMER_ROLES],
      )
    ).rows[0];
    if (!p) throw new NotFoundException();
    const accounts = (
      await this.pool.query(
        `SELECT reference, product_code AS "productCode", status, created_at AS "createdAt"
           FROM finance_account WHERE person_id = $1 ORDER BY created_at DESC`,
        [id],
      )
    ).rows;
    const canSeeDocuments = auth.roles.some((r) => DOCUMENT_ROLES.includes(r));
    return {
      customer: p,
      accounts,
      documents: canSeeDocuments ? await this.docs.forPerson(id, { includeReplaced: true }) : null,
    };
  }
}

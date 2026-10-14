// Identity verification vendors (C1-2, C1-3, C1-4, C1-6). The PRD leaves the vendor to be chosen;
// these interfaces are what the chosen vendor must provide. The sandbox implementations are
// deterministic so flows and tests can exercise both outcomes.

export interface IndividualCheck {
  idType: 'bvn' | 'nin';
  idNumber: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string; // YYYY-MM-DD
  phone: string;
  /** Token from the vendor's liveness SDK session on the device. */
  livenessToken: string;
}

export interface IndividualResult {
  match: boolean;
  livenessPassed: boolean;
  verifiedName: string | null;
  vendorRef: string;
  failureReason?: 'id_not_found' | 'details_mismatch' | 'liveness_failed' | 'phone_mismatch';
}

export interface DocumentCheck {
  country: string;
  docType: 'passport' | 'national_id' | 'drivers_licence';
  docNumber: string;
  fullName: string;
  livenessToken: string;
}

export interface CompanyRecord {
  found: boolean;
  companyName?: string;
  status?: 'active' | 'inactive';
  directors?: string[];
  registeredAddress?: string;
}

export interface IdentityVendor {
  readonly name: string;
  verifyIndividual(c: IndividualCheck): Promise<IndividualResult>;
  verifyDocument(c: DocumentCheck): Promise<IndividualResult>;
  /** Re-runs liveness only (C1-8 re-verification, C2-2 recovery). */
  verifyLiveness(livenessToken: string, expectedName: string): Promise<{ passed: boolean; vendorRef: string }>;
}

export interface CompanyRegistry {
  readonly name: string;
  lookup(rcNumber: string): Promise<CompanyRecord>;
}

const ID_RE = /^\d{11}$/;

/**
 * Sandbox: 11-digit IDs; IDs ending 0000 are not found; liveness tokens containing "fail" fail;
 * last names "Mismatch" fail the details match. The verified name is "FIRST LAST" in upper case.
 */
export class SandboxIdentity implements IdentityVendor {
  readonly name = 'sandbox';
  async verifyIndividual(c: IndividualCheck): Promise<IndividualResult> {
    const ref = `sbx_${c.idType}_${c.idNumber.slice(-4)}_${Date.now()}`;
    if (!ID_RE.test(c.idNumber) || c.idNumber.endsWith('0000')) return { match: false, livenessPassed: false, verifiedName: null, vendorRef: ref, failureReason: 'id_not_found' };
    if (/mismatch/i.test(c.lastName)) return { match: false, livenessPassed: false, verifiedName: null, vendorRef: ref, failureReason: 'details_mismatch' };
    if (/fail/i.test(c.livenessToken)) return { match: true, livenessPassed: false, verifiedName: null, vendorRef: ref, failureReason: 'liveness_failed' };
    return { match: true, livenessPassed: true, verifiedName: `${c.firstName} ${c.lastName}`.toUpperCase(), vendorRef: ref };
  }
  async verifyDocument(c: DocumentCheck): Promise<IndividualResult> {
    const ref = `sbx_doc_${Date.now()}`;
    if (c.docNumber.length < 5 || c.docNumber.endsWith('0000')) return { match: false, livenessPassed: false, verifiedName: null, vendorRef: ref, failureReason: 'id_not_found' };
    if (/fail/i.test(c.livenessToken)) return { match: true, livenessPassed: false, verifiedName: null, vendorRef: ref, failureReason: 'liveness_failed' };
    return { match: true, livenessPassed: true, verifiedName: c.fullName.toUpperCase(), vendorRef: ref };
  }
  async verifyLiveness(token: string): Promise<{ passed: boolean; vendorRef: string }> {
    return { passed: !/fail/i.test(token), vendorRef: `sbx_live_${Date.now()}` };
  }
}

/**
 * Sandbox CAC register: RC numbers are "RC" plus 6-7 digits; RC numbers ending 000 are not found.
 * Registered directors are supplied through SANDBOX_CAC_DIRECTORS ("RC123456=Ada Okafor;Bola Ade|...")
 * or default to the business's declared directors so the flow can be exercised end to end.
 */
export class SandboxCompanyRegistry implements CompanyRegistry {
  readonly name = 'sandbox';
  private readonly fixtures = new Map<string, string[]>();
  constructor(fixtures = process.env.SANDBOX_CAC_DIRECTORS ?? '') {
    for (const entry of fixtures.split('|').filter(Boolean)) {
      const [rc, names] = entry.split('=');
      if (rc && names) this.fixtures.set(rc.trim().toUpperCase(), names.split(';').map((n) => n.trim()));
    }
  }
  register(rc: string, directors: string[]): void {
    this.fixtures.set(rc.toUpperCase(), directors);
  }
  async lookup(rcNumber: string): Promise<CompanyRecord> {
    const rc = rcNumber.trim().toUpperCase();
    if (!/^RC\d{6,7}$/.test(rc) || rc.endsWith('000')) return { found: false };
    return {
      found: true,
      companyName: `SANDBOX COMPANY ${rc}`,
      status: 'active',
      directors: this.fixtures.get(rc) ?? [],
      registeredAddress: '1 Marina, Lagos Island, Lagos',
    };
  }
}

export function createIdentityVendor(name: string): IdentityVendor {
  if (name === 'sandbox') return new SandboxIdentity();
  throw new Error(`identity vendor "${name}" is not integrated yet (C1-2: vendor to be chosen)`);
}

export function createCompanyRegistry(name: string): CompanyRegistry {
  if (name === 'sandbox') return new SandboxCompanyRegistry();
  throw new Error(`CAC registry adapter "${name}" is not integrated yet`);
}

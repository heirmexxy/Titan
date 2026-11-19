/**
 * Carbon verification and registry submission.
 *
 * Verifiers (VVBs) get their own organisation, users and API keys, and see only projects assigned to them.
 * They raise findings, owners respond, and verifiers sign a statement fingerprinted to the exact evidence package.
 * Owners then prepare a registry submission (Verra, Gold Standard, Puro.earth, Isometric or other): a package of
 * the evidence in that registry's vocabulary, uploaded through the registry's own portal, and its status and
 * issued serial numbers are tracked here. Registries do not offer public submission APIs, so Titan prepares,
 * fingerprints and tracks rather than pushing.
 */
import { createHash } from 'node:crypto';
import { toCsv, toZip } from '../export/files.js';

interface Pool { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

export class VerifyError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export const REGISTRIES: Record<string, { name: string; unit: string; note: string }> = {
  verra: { name: 'Verra (VCS)', unit: 'VCUs', note: 'Upload the monitoring data and verification report through the Verra Registry project page.' },
  gold_standard: { name: 'Gold Standard', unit: 'VERs', note: 'Upload through the Gold Standard Impact Registry (SustainCERT review).' },
  puro: { name: 'Puro.earth', unit: 'CORCs', note: 'Upload the production batch evidence through the Puro Registry supplier portal.' },
  isometric: { name: 'Isometric', unit: 'credits', note: 'Upload through the Isometric registry project workspace.' },
  other: { name: 'Other registry', unit: 'credits', note: 'Use the registry’s own submission route.' },
};

/** Stable JSON (sorted keys) so the same evidence always has the same fingerprint. Pure. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
}
export const fingerprint = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');

type PackFn = (projectId: string) => Promise<any>;

export class RegistryService {
  constructor(readonly pool: Pool, private pack: PackFn, private publicUrl: string) {}
  private q(t: string, v: unknown[] = []) { return this.pool.query(t, v); }

  // ---------- Access ----------
  async projectForVerifier(projectId: string, verifierOrgId: string) {
    const p = (await this.q(
      `SELECT p.*, o.name AS org_name FROM carbon_projects p JOIN organisations o ON o.id = p.org_id
       JOIN verifier_assignments va ON va.project_id = p.id AND va.verifier_org_id = $2 AND va.revoked_at IS NULL WHERE p.id = $1`, [projectId, verifierOrgId])).rows[0];
    if (!p) throw new VerifyError(404, 'not_found', 'Project not found');
    return p;
  }
  async projectForOwner(projectId: string, orgId: string | null) {
    const p = (await this.q(`SELECT p.*, o.name AS org_name FROM carbon_projects p JOIN organisations o ON o.id = p.org_id WHERE p.id = $1 AND ($2::uuid IS NULL OR p.org_id = $2)`, [projectId, orgId])).rows[0];
    if (!p) throw new VerifyError(404, 'not_found', 'Project not found');
    return p;
  }

  async assignedProjects(verifierOrgId: string) {
    return (await this.q(
      `SELECT p.id, p.name, p.methodology, p.registry, p.registry_methodology, o.name AS owner, va.granted_at,
         (SELECT count(*) FROM carbon_activities a WHERE a.project_id = p.id AND a.status = 'calculated')::int AS calculated,
         (SELECT count(*) FROM verification_findings f WHERE f.project_id = p.id AND f.verifier_org_id = $1 AND f.status <> 'closed')::int AS open_findings,
         (SELECT max(signed_at) FROM verification_statements s WHERE s.project_id = p.id AND s.verifier_org_id = $1) AS last_statement
       FROM verifier_assignments va JOIN carbon_projects p ON p.id = va.project_id JOIN organisations o ON o.id = p.org_id
       WHERE va.verifier_org_id = $1 AND va.revoked_at IS NULL ORDER BY va.granted_at DESC`, [verifierOrgId])).rows;
  }

  /** Assigns a verifier organisation (creating it, and its first user, when new). Returns the user to invite. */
  async assign(projectId: string, ownerOrgId: string | null, o: { email: string; organisation: string; by: string }) {
    const p = await this.projectForOwner(projectId, ownerOrgId);
    const email = o.email.trim().toLowerCase();
    let user = (await this.q(`SELECT u.id, u.role, u.org_id, u.password_hash FROM users u WHERE lower(u.email) = $1`, [email])).rows[0];
    if (user && user.role !== 'verifier') throw new VerifyError(409, 'not_a_verifier', 'That email already belongs to a non-verifier Titan user. Use the verifier’s own work email.');
    let created = false;
    if (!user) {
      const org = (await this.q(`SELECT id FROM organisations WHERE kind = 'verifier' AND lower(name) = lower($1)`, [o.organisation])).rows[0]
        ?? (await this.q(`INSERT INTO organisations (name, kind) VALUES ($1,'verifier') RETURNING id`, [o.organisation])).rows[0];
      user = (await this.q(`INSERT INTO users (org_id, email, role) VALUES ($1,$2,'verifier') RETURNING id, org_id, role, password_hash`, [org.id, email])).rows[0];
      created = true;
    }
    await this.q(`INSERT INTO verifier_assignments (project_id, verifier_org_id, granted_by) VALUES ($1,$2,$3)
                  ON CONFLICT (project_id, verifier_org_id) DO UPDATE SET revoked_at = NULL, granted_by = $3, granted_at = now()`, [p.id, user.org_id, o.by]);
    return { userId: user.id as string, verifierOrgId: user.org_id as string, needsPassword: created || !user.password_hash, project: p };
  }

  async revoke(projectId: string, ownerOrgId: string | null, verifierOrgId: string) {
    await this.projectForOwner(projectId, ownerOrgId);
    const r = await this.q(`UPDATE verifier_assignments SET revoked_at = now() WHERE project_id = $1 AND verifier_org_id = $2 AND revoked_at IS NULL`, [projectId, verifierOrgId]);
    if (!r.rowCount) throw new VerifyError(404, 'not_found', 'Verifier not assigned');
  }

  async setRegistry(projectId: string, ownerOrgId: string | null, o: { registry?: string | null; registryMethodology?: string | null; registryProjectId?: string | null }) {
    await this.projectForOwner(projectId, ownerOrgId);
    return (await this.q(`UPDATE carbon_projects SET registry = coalesce($2, registry), registry_methodology = $3, registry_project_id = $4 WHERE id = $1 RETURNING *`,
      [projectId, o.registry ?? null, o.registryMethodology ?? null, o.registryProjectId ?? null])).rows[0];
  }

  // ---------- Evidence ----------
  /** The evidence for chosen activities (default: all calculated), with a fingerprint that ignores generation time. */
  async evidence(projectId: string, activityIds?: string[] | null) {
    const full = await this.pack(projectId);
    const acts = (full.activities as any[]).filter((a) => (activityIds?.length ? activityIds.includes(a.id) : a.status === 'calculated'));
    if (activityIds?.length && acts.length !== activityIds.length) throw new VerifyError(400, 'invalid_activities', 'Some activities are not in this project');
    const body = {
      format: 'titan-carbon-evidence/1',
      project: full.project,
      activities: acts,
      totals: { activities: acts.length, netTco2e: Math.round(acts.reduce((s, a) => s + (a.result?.status === 'ok' ? Number(a.result.netTco2e) || 0 : 0), 0) * 1e4) / 1e4 },
      howToVerify: full.howToVerify,
      proofEndpoint: `${this.publicUrl}/v1/readings/proof?device=<deviceId>&seq=<seq>`,
    };
    return { ...body, sha256: fingerprint(body), generatedAt: new Date().toISOString() };
  }

  // ---------- Findings ----------
  async listFindings(projectId: string, verifierOrgId?: string | null) {
    return (await this.q(
      `SELECT f.*, o.name AS verifier, a.reference AS activity_reference FROM verification_findings f JOIN organisations o ON o.id = f.verifier_org_id
       LEFT JOIN carbon_activities a ON a.id = f.activity_id WHERE f.project_id = $1 AND ($2::uuid IS NULL OR f.verifier_org_id = $2) ORDER BY f.created_at DESC`,
      [projectId, verifierOrgId ?? null])).rows;
  }
  async raiseFinding(projectId: string, verifierOrgId: string, o: { activityId?: string | null; kind: string; text: string; by: string }) {
    await this.projectForVerifier(projectId, verifierOrgId);
    if (!['clarification', 'corrective_action', 'observation'].includes(o.kind)) throw new VerifyError(400, 'invalid_kind', 'kind must be clarification, corrective_action or observation');
    if (o.activityId && !(await this.q(`SELECT 1 FROM carbon_activities WHERE id = $1 AND project_id = $2`, [o.activityId, projectId])).rows.length) throw new VerifyError(400, 'invalid_activity', 'Activity not in this project');
    return (await this.q(`INSERT INTO verification_findings (project_id, activity_id, verifier_org_id, kind, text, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [projectId, o.activityId ?? null, verifierOrgId, o.kind, o.text, o.by])).rows[0];
  }
  async respond(findingId: string, ownerOrgId: string | null, response: string, by: string) {
    const f = (await this.q(`SELECT f.*, p.org_id FROM verification_findings f JOIN carbon_projects p ON p.id = f.project_id WHERE f.id = $1`, [findingId])).rows[0];
    if (!f || (ownerOrgId && f.org_id !== ownerOrgId)) throw new VerifyError(404, 'not_found', 'Finding not found');
    if (f.status === 'closed') throw new VerifyError(400, 'closed', 'This finding is closed');
    return (await this.q(`UPDATE verification_findings SET response = $2, responded_by = $3, responded_at = now(), status = 'responded' WHERE id = $1 RETURNING *`, [findingId, response, by])).rows[0];
  }
  async closeFinding(findingId: string, verifierOrgId: string, reopen = false) {
    const r = await this.q(
      `UPDATE verification_findings SET status = $3, closed_at = CASE WHEN $3 = 'closed' THEN now() END WHERE id = $1 AND verifier_org_id = $2 RETURNING *`,
      [findingId, verifierOrgId, reopen ? 'open' : 'closed']);
    if (!r.rows[0]) throw new VerifyError(404, 'not_found', 'Finding not found');
    return r.rows[0];
  }

  // ---------- Statements ----------
  async sign(projectId: string, verifierOrgId: string, o: { activityIds: string[]; opinion: string; verifiedTco2e: number; statement: string; by: string }) {
    await this.projectForVerifier(projectId, verifierOrgId);
    if (!['positive', 'qualified', 'negative'].includes(o.opinion)) throw new VerifyError(400, 'invalid_opinion', 'opinion must be positive, qualified or negative');
    if (!o.activityIds.length) throw new VerifyError(400, 'invalid_activities', 'Choose the activities this statement covers');
    const open = (await this.q(`SELECT count(*)::int AS n FROM verification_findings WHERE project_id = $1 AND verifier_org_id = $2 AND kind = 'corrective_action' AND status <> 'closed'
      AND (activity_id IS NULL OR activity_id = ANY($3::uuid[]))`, [projectId, verifierOrgId, o.activityIds])).rows[0].n;
    if (open && o.opinion === 'positive') throw new VerifyError(400, 'open_findings', `${open} corrective action request(s) are still open. Close them or give a qualified opinion.`);
    const ev = await this.evidence(projectId, o.activityIds);
    if (o.verifiedTco2e > ev.totals.netTco2e + 1e-6) throw new VerifyError(400, 'too_high', `Verified amount cannot exceed the calculated ${ev.totals.netTco2e} tCO2e`);
    return (await this.q(
      `INSERT INTO verification_statements (project_id, verifier_org_id, activity_ids, opinion, verified_tco2e, statement, package_sha256, signed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [projectId, verifierOrgId, o.activityIds, o.opinion, o.verifiedTco2e, o.statement, ev.sha256, o.by])).rows[0];
  }
  async listStatements(projectId: string, verifierOrgId?: string | null) {
    return (await this.q(`SELECT s.*, o.name AS verifier FROM verification_statements s JOIN organisations o ON o.id = s.verifier_org_id
      WHERE s.project_id = $1 AND ($2::uuid IS NULL OR s.verifier_org_id = $2) ORDER BY s.signed_at DESC`, [projectId, verifierOrgId ?? null])).rows;
  }

  // ---------- Registry submissions ----------
  async prepareSubmission(projectId: string, ownerOrgId: string | null, o: { registry: string; statementId?: string | null; activityIds?: string[] | null; by: string }) {
    const p = await this.projectForOwner(projectId, ownerOrgId);
    if (!REGISTRIES[o.registry]) throw new VerifyError(400, 'invalid_registry', `registry must be one of ${Object.keys(REGISTRIES).join(', ')}`);
    let activityIds = o.activityIds ?? null;
    let claimed: number;
    let statement = null;
    if (o.statementId) {
      statement = (await this.q(`SELECT * FROM verification_statements WHERE id = $1 AND project_id = $2`, [o.statementId, projectId])).rows[0];
      if (!statement) throw new VerifyError(400, 'invalid_statement', 'Statement not found for this project');
      if (statement.opinion === 'negative') throw new VerifyError(400, 'negative_opinion', 'A negative verification cannot be submitted');
      activityIds = statement.activity_ids;
      claimed = Number(statement.verified_tco2e);
    }
    const ev = await this.evidence(projectId, activityIds);
    if (!ev.activities.length) throw new VerifyError(400, 'nothing_to_submit', 'No calculated activities to submit');
    if (statement && statement.package_sha256 !== ev.sha256) throw new VerifyError(409, 'evidence_changed', 'The evidence changed after the verifier signed. Ask the verifier to review and sign again.');
    claimed = statement ? Number(statement.verified_tco2e) : ev.totals.netTco2e;
    return (await this.q(
      `INSERT INTO registry_submissions (project_id, org_id, registry, statement_id, activity_ids, claimed_tco2e, package_sha256, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [projectId, p.org_id, o.registry, statement?.id ?? null, ev.activities.map((a: any) => a.id), claimed, ev.sha256, o.by])).rows[0];
  }

  async listSubmissions(projectId: string) {
    return (await this.q(`SELECT * FROM registry_submissions WHERE project_id = $1 ORDER BY created_at DESC`, [projectId])).rows;
  }

  async updateSubmission(id: string, ownerOrgId: string | null, o: { status: string; registryRef?: string | null; issuedTco2e?: number | null; serialFrom?: string | null; serialTo?: string | null; notes?: string | null }) {
    if (!['submitted', 'under_review', 'issued', 'rejected'].includes(o.status)) throw new VerifyError(400, 'invalid_status', 'status must be submitted, under_review, issued or rejected');
    const s = (await this.q(`SELECT * FROM registry_submissions WHERE id = $1 AND ($2::uuid IS NULL OR org_id = $2)`, [id, ownerOrgId])).rows[0];
    if (!s) throw new VerifyError(404, 'not_found', 'Submission not found');
    if (o.status === 'issued' && !(o.issuedTco2e && o.issuedTco2e > 0)) throw new VerifyError(400, 'invalid_issuance', 'Enter the issued amount');
    if (o.issuedTco2e && o.issuedTco2e > Number(s.claimed_tco2e) + 1e-6) throw new VerifyError(400, 'invalid_issuance', 'Issued amount is more than was claimed');
    return (await this.q(
      `UPDATE registry_submissions SET status = $2, registry_ref = coalesce($3, registry_ref), issued_tco2e = coalesce($4, issued_tco2e), serial_from = coalesce($5, serial_from),
         serial_to = coalesce($6, serial_to), notes = coalesce($7, notes), submitted_at = CASE WHEN $2 = 'submitted' THEN coalesce(submitted_at, now()) ELSE submitted_at END,
         decided_at = CASE WHEN $2 IN ('issued','rejected') THEN now() ELSE decided_at END WHERE id = $1 RETURNING *`,
      [id, o.status, o.registryRef ?? null, o.issuedTco2e ?? null, o.serialFrom ?? null, o.serialTo ?? null, o.notes ?? null])).rows[0];
  }

  /** Registry package: JSON or a zip with the JSON, CSV tables and a README for the registry upload. */
  async submissionPackage(id: string, ownerOrgId: string | null, format: 'json' | 'zip') {
    const s = (await this.q(`SELECT * FROM registry_submissions WHERE id = $1 AND ($2::uuid IS NULL OR org_id = $2)`, [id, ownerOrgId])).rows[0];
    if (!s) throw new VerifyError(404, 'not_found', 'Submission not found');
    const p = await this.projectForOwner(s.project_id, null);
    const ev = await this.evidence(s.project_id, s.activity_ids);
    const statement = s.statement_id ? (await this.q(`SELECT s.*, o.name AS verifier FROM verification_statements s JOIN organisations o ON o.id = s.verifier_org_id WHERE s.id = $1`, [s.statement_id])).rows[0] : null;
    const findings = await this.listFindings(s.project_id);
    const reg = REGISTRIES[s.registry];
    const pkg = {
      format: 'titan-registry-package/1',
      registry: { id: s.registry, name: reg.name, unit: reg.unit, projectId: p.registry_project_id, methodology: p.registry_methodology, howToSubmit: reg.note },
      submission: { id: s.id, claimedTco2e: Number(s.claimed_tco2e), preparedAt: s.created_at, evidenceSha256: ev.sha256, evidenceMatchesPreparation: ev.sha256 === s.package_sha256 },
      verification: statement ? { verifier: statement.verifier, opinion: statement.opinion, verifiedTco2e: Number(statement.verified_tco2e), statement: statement.statement, signedAt: statement.signed_at, evidenceSha256: statement.package_sha256 } : null,
      findings: findings.map((f) => ({ kind: f.kind, status: f.status, text: f.text, response: f.response, activity: f.activity_reference })),
      evidence: ev,
    };
    if (format === 'json') return { json: pkg };
    const acts = ev.activities as any[];
    const files = [
      { name: 'package.json', data: Buffer.from(JSON.stringify(pkg, null, 2)) },
      { name: 'activities.csv', data: Buffer.from(toCsv(['activity_id', 'reference', 'device', 'started_utc', 'ended_utc', 'status', 'net_tco2e', 'readiness'],
        acts.map((a) => [a.id, a.reference, a.device, a.startedAt ? new Date(a.startedAt) : null, a.endedAt ? new Date(a.endedAt) : null, a.status, a.result?.netTco2e ?? null, a.readiness?.status]))) },
      { name: 'measurements.csv', data: Buffer.from(toCsv(['activity_id', 'kind', 'value', 'unit', 'document', 'document_sha256', 'entered_by', 'entered_utc'],
        acts.flatMap((a) => (a.measurements ?? []).map((m: any) => [a.id, m.kind, m.value, m.unit, m.document_ref, m.document_sha256, m.entered_by, m.created_at ? new Date(m.created_at) : null])))) },
      { name: 'findings.csv', data: Buffer.from(toCsv(['kind', 'status', 'finding', 'response', 'activity'], findings.map((f) => [f.kind, f.status, f.text, f.response, f.activity_reference]))) },
      { name: 'README.txt', data: Buffer.from(
        `Registry package for ${p.name} (${reg.name})\n\nClaimed: ${s.claimed_tco2e} tCO2e in ${acts.length} activities.\nEvidence fingerprint (SHA-256 of package.json "evidence" without generatedAt/sha256): ${ev.sha256}\n` +
        `${statement ? `Verified by ${statement.verifier}: ${statement.opinion} opinion, ${statement.verified_tco2e} tCO2e, signed ${new Date(statement.signed_at).toISOString()}.\n` : 'Not yet verified.\n'}\n` +
        `How to submit: ${reg.note}\nEvery device reading cited can be checked against its Ed25519 signature at ${this.publicUrl}/v1/readings/proof.\n`) },
    ];
    return { zip: toZip(files), name: `titan-${s.registry}-${p.name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}-${String(s.id).slice(0, 8)}.zip` };
  }
}

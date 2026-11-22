// Run: npm run test:company-profile — crew cannot see or edit Company Profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const A = await jiti.import(path.join(root, 'lib/company-profile-access.ts'));
const src = (p) => readFileSync(path.join(root, p), 'utf8');

test('reserved SETTINGS / secrets ids are detected', () => {
  assert.equal(A.isReservedDocumentId('SETTINGS-abc'), true);
  assert.equal(A.isReservedDocumentId('settings-abc'), true);
  assert.equal(A.isCompanySettingsId('SETTINGS-owner-1', 'owner-1'), true);
  assert.equal(A.isCompanySettingsId('SETTINGS-other', 'owner-1'), false);
  assert.equal(A.isReservedDocumentId('RECEPTIONIST-SECRETS-abc'), true);
  assert.equal(A.isReservedDocumentId('PLATFORM-x'), true);
  assert.equal(A.isReservedDocumentId('EST-0001'), false);
  assert.equal(A.isReservedDocumentId(''), false);
});

test('page: crew nav opens Account only, never Company Profile tabs or editors', () => {
  const page = src('app/page.tsx');
  assert.match(page, /from '@\/lib\/company-profile-access'/);
  assert.match(page, /const openAccountOrProfile/);
  assert.match(page, /if \(currentCrew\) \{/);
  assert.match(page, /setProfileTab\('billing'\)/);
  assert.match(page, /currentCrew \? 'Account' : t\('profile'\)/);
  assert.match(page, /data-testid=\{currentCrew \? 'nav-account' : 'nav-profile'\}/);
  assert.match(page, /data-testid=\{currentCrew \? 'crew-account-heading' : 'company-profile-heading'\}/);
  assert.match(page, /currentCrew \? 'Account' : t\('companyProfile'\)/);
  // Company Profile tab bar and editors are owner-only
  assert.match(page, /\{!currentCrew && \(\s*<div className="flex border-b mb-8 overflow-x-auto">/s);
  assert.match(page, /\{!currentCrew && profileTab === 'info' && \(/);
  assert.match(page, /\{!currentCrew && profileTab === 'payments' && \(/);
  // Video Tutorials are visible to owners and crew; company editors stay owner-only
  assert.match(page, /profileTab === 'tutorials' && \(/);
  assert.match(page, /<VideoTutorialsPanel/);
  assert.match(page, /data-testid="crew-video-tutorials-tab"/);
  assert.match(page, /profileTab !== 'billing' && profileTab !== 'tutorials'/);
  assert.match(page, /\{!currentCrew && profileTab === 'billing' && billingPanel === 'manage' && \(/);
  // Side doors closed
  assert.match(page, /\{!currentCrew && \(\s*<Button variant="outline" onClick=\{\(\) => openAccountOrProfile\(\)\}>← \{t\('companyProfile'\)\}<\/Button>/s);
  assert.match(page, /Change trade on Profile/);
  assert.match(page, /\{!currentCrew && \(\s*<Button[\s\S]*openAccountOrProfile\('info'\)/);
  // Crew still get the Account card (login email + Crew member of {company})
  assert.match(page, /BillingAccountCard/);
  assert.match(page, /isCrew: true/);
  assert.match(page, /ownerCompany: profile\.company/);
});

test('page: company profile writes are skipped for crew (saves, auto-save, logo, certificate, receptionist)', () => {
  const page = src('app/page.tsx');
  assert.match(page, /const saveProfileSettings[\s\S]*if \(currentCrew\) \{[\s\S]*CREW_COMPANY_PROFILE_WRITE_DENIED/m);
  assert.match(page, /const upsertUserSettingsProfile[\s\S]*if \(currentCrew\) return;/m);
  assert.match(page, /Auto-save company profile[\s\S]*if \(currentCrew\) return;/m);
  assert.match(page, /const handleLogoUpload[\s\S]*if \(currentCrew\) \{[\s\S]*CREW_COMPANY_PROFILE_WRITE_DENIED/m);
  assert.match(page, /const handleCertificateUpload[\s\S]*if \(currentCrew\) \{[\s\S]*CREW_COMPANY_PROFILE_WRITE_DENIED/m);
  assert.match(page, /const saveReceptionistData[\s\S]*if \(currentCrew\) \{[\s\S]*CREW_COMPANY_PROFILE_WRITE_DENIED/m);
});

test('server: crew data proxy and documents/save refuse SETTINGS writes', () => {
  const crew = src('app/api/crew/data/[table]/route.ts');
  assert.match(crew, /from '@\/lib\/company-profile-access'/);
  assert.match(crew, /if \(isReservedDocumentId\(id\)\) \{/);
  assert.match(crew, /Only the account owner can change workspace settings/);
  // Reads of SETTINGS are still allowed so jobs can render company name/logo
  assert.match(crew, /allowSettingsRead: table === 'estimates'/);

  const save = src('app/api/documents/save/route.ts');
  assert.match(save, /from '@\/lib\/company-profile-access'/);
  assert.match(save, /if \(isReservedDocumentId\(id\)\) \{/);
  assert.match(save, /Reserved document id/);
});

test('RLS trigger already blocks SETTINGS writes unless auth.uid() is the owner (no new migration)', () => {
  const sql = src('supabase/security-hardening-2026-11b.sql');
  assert.match(sql, /estimates_guard_reserved_ids/);
  assert.match(sql, /Only the account owner can change workspace settings/);
  assert.match(sql, /NEW\.id = 'SETTINGS-' \|\| NEW\.user_id::text/);
  assert.match(sql, /auth\.uid\(\) IS DISTINCT FROM NEW\.user_id/);
});

test('document letterhead and crew label stay available without the Company Profile page', () => {
  const page = src('app/page.tsx');
  // Company name / logo still render on the shell and documents
  assert.match(page, /\{profile\.company \|\| 'EstimateAce'\}/);
  assert.match(page, /logoDisplayUrl && \(/);
  // "Crew member of {company}" comes from BillingAccountCard / belongsTo
  const card = src('components/BillingAccountCard.tsx');
  const lib = src('lib/billing-account.ts');
  assert.match(lib, /belongsTo/);
  assert.match(card, /Crew member of|belongsTo/);
});

#!/usr/bin/env node
/**
 * Reports outdated npm packages and current xAI model defaults.
 * Run: npm run update:check
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

console.log('EstimateAce — dependency & API model check\n');
console.log('xAI defaults (from lib/xai-config.ts):');
console.log('  Chat:   grok-4.5-latest  (override: GROK_CHAT_MODEL or GROK_MODEL)');
console.log('  Vision: grok-4.5-latest  (override: GROK_VISION_MODEL or GROK_MODEL)');
console.log('\nPinned app versions:');
console.log(`  next:    ${pkg.dependencies?.next ?? 'n/a'}`);
console.log(`  react:   ${pkg.dependencies?.react ?? 'n/a'}`);
console.log(`  supabase: ${pkg.dependencies?.['@supabase/supabase-js'] ?? 'n/a'}`);
console.log('\nOutdated npm packages (if any):\n');

try {
  execSync('npm outdated', { cwd: root, stdio: 'inherit' });
} catch {
  // npm outdated exits 1 when packages are outdated — expected
}

console.log('\nTip: merge Dependabot/Renovate PRs weekly, or run: npm run update:deps');
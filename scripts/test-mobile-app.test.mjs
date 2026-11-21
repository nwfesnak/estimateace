// Run: npm run test:mobile — App Store / Google Play (Capacitor) wrapper checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { alias: { '@': root } });
const S = await jiti.import(path.join(root, 'lib/native-app-shared.ts'));
const SV = await jiti.import(path.join(root, 'lib/native-app-server.ts'));
const cfg = (await jiti.import(path.join(root, 'capacitor.config.ts'))).default;
const src = (p) => readFileSync(path.join(root, p), 'utf8');

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

test('user-agent token detection', () => {
  assert.equal(S.isNativeUserAgent(`${SAFARI} EstimateAceApp/1.0`), true);
  assert.equal(S.isNativeUserAgent(SAFARI), false);
  assert.equal(S.isNativeUserAgent('Mozilla/5.0 NotEstimateAceAppX'), false);
  assert.equal(S.isNativeUserAgent(''), false);
  assert.equal(S.isNativeUserAgent(null), false);
});

test('which links leave the app', () => {
  const base = 'https://app.estimateace.com/';
  assert.equal(S.shouldOpenExternally('https://checkout.stripe.com/c/pay/cs_test', base), true);
  assert.equal(S.shouldOpenExternally('https://connect.stripe.com/setup/e/acct_1', base), true);
  assert.equal(S.shouldOpenExternally('https://estimateace.com/pricing', base), true);
  assert.equal(S.shouldOpenExternally('https://maps.google.com/?q=1', base), true);
  assert.equal(S.shouldOpenExternally('https://app.estimateace.com/client/abc', base), false);
  assert.equal(S.shouldOpenExternally('/terms', base), false);
  assert.equal(S.shouldOpenExternally('#top', base), false);
  assert.equal(S.shouldOpenExternally('mailto:help@estimateace.com', base), false);
  assert.equal(S.shouldOpenExternally('tel:+15555550123', base), false);
  assert.equal(S.shouldOpenExternally('javascript:void(0)', base), false);
});

test('purchase endpoints refuse store-app requests, allow the web', async () => {
  const app = new Request('https://app.estimateace.com/api/billing/checkout', {
    method: 'POST',
    headers: { 'user-agent': `${SAFARI} EstimateAceApp/1.0` },
  });
  const res = SV.refuseInAppPurchase(app);
  assert.ok(res);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'native_app_purchase_unavailable');
  const web = new Request('https://app.estimateace.com/api/billing/checkout', {
    method: 'POST',
    headers: { 'user-agent': SAFARI },
  });
  assert.equal(SV.refuseInAppPurchase(web), null);
  for (const f of [
    'app/api/billing/checkout/route.ts',
    'app/api/billing/portal/route.ts',
    'app/api/crew/seat-checkout/route.ts',
    'app/api/receptionist/checkout/route.ts',
    'app/api/billing/start-trial/route.ts',
  ]) {
    const s = src(f);
    const post = s.indexOf('export async function POST');
    const guard = s.indexOf('refuseInAppPurchase(request)', post);
    assert.ok(guard > post && guard - post < 250, `${f}: guard is the first thing in POST`);
  }
});

test('capacitor config: live site, offline page, browser for Stripe, UA token', () => {
  assert.equal(cfg.appId, 'com.estimateace.app');
  assert.equal(cfg.appName, 'EstimateAce');
  assert.equal(cfg.server.url, 'https://app.estimateace.com');
  assert.equal(cfg.server.cleartext, false);
  assert.ok(existsSync(path.join(root, cfg.webDir, 'index.html')));
  assert.ok(existsSync(path.join(root, cfg.webDir, cfg.server.errorPath)), 'offline page bundled');
  assert.match(cfg.appendUserAgent, /\bEstimateAceApp\b/);
  const nav = cfg.server.allowNavigation.join(' ');
  assert.ok(!/stripe/.test(nav), 'Stripe opens in the system browser, not the app');
  assert.ok(!/(^|\s)\*\.estimateace\.com/.test(nav), 'marketing site / pricing opens outside the app');
  assert.ok(nav.includes('app.estimateace.com'));
});

test('iOS project: permission strings, arm64, privacy manifest bundled', () => {
  const plist = src('ios/App/App/Info.plist');
  for (const k of [
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSPhotoLibraryUsageDescription',
    'NSPhotoLibraryAddUsageDescription',
    'NSLocationWhenInUseUsageDescription',
  ]) {
    assert.match(plist, new RegExp(`<key>${k}</key>\\s*<string>EstimateAce [^<]{20,}</string>`), k);
  }
  assert.match(plist, /<string>arm64<\/string>/);
  assert.ok(!/armv7/.test(plist));
  const priv = src('ios/App/App/PrivacyInfo.xcprivacy');
  assert.match(priv, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);
  assert.match(priv, /NSPrivacyCollectedDataTypeCoarseLocation/);
  assert.match(priv, /NSPrivacyAccessedAPICategoryUserDefaults/);
  const pbx = src('ios/App/App.xcodeproj/project.pbxproj');
  assert.match(pbx, /PrivacyInfo\.xcprivacy in Resources/);
  const icon = readFileSync(path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
  assert.equal(icon.readUInt32BE(16), 1024);
  assert.equal(icon[25], 2, 'App Store icon must be RGB with no alpha channel');
});

test('Android project: package id, camera/mic permissions, signing from untracked file', () => {
  const manifest = src('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android\.permission\.CAMERA/);
  assert.match(manifest, /android.permission.RECORD_AUDIO/);
  assert.match(manifest, /android.permission.ACCESS_COARSE_LOCATION/);
  assert.match(manifest, /android\.hardware\.camera" android:required="false"/);
  const gradle = src('android/app/build.gradle');
  assert.match(gradle, /applicationId "com\.estimateace\.app"/);
  assert.match(gradle, /keystore\.properties/);
  assert.match(src('android/.gitignore'), /^keystore\.properties$/m);
  assert.ok(existsSync(path.join(root, 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png')));
});

test('website: Meta pixel and safe-area class only change inside the app', () => {
  const layout = src('app/layout.tsx');
  assert.match(layout, /if\(!document\.documentElement\.classList\.contains\('native-app'\)\)\{!function/);
  assert.match(layout, /fbq\('track','PageView'\);\}`/);
  assert.match(layout, /<NativeAppBridge \/>/);
  assert.match(src('app/globals.css'), /html\.native-app \.app-shell/);
});

test('no plan / add-on / seat purchase buttons render in the app', () => {
  const page = src('app/page.tsx');
  const guarded = (needle, window = 1600) => {
    let at = page.indexOf(needle);
    assert.ok(at > 0, `${needle} present`);
    while (at > 0) {
      const before = page.slice(Math.max(0, at - window), at);
      assert.ok(/!nativeApp|nativeApp \?/.test(before), `unguarded: ${needle} @${at}`);
      at = page.indexOf(needle, at + 1);
    }
  };
  guarded("onClick={() => void startSubscriptionCheckout(");
  guarded('onClick={() => void openBillingPortal()}');
  guarded('onClick={() => void addCrewMember()}', 300);
  guarded('void startCrewSeatCheckout({', 400);
  assert.match(page, /\{!nativeApp && \(\s*<Button\s+type="button"\s+onClick=\{goToSignupPayScreen\}/);

  const rec = src('components/AIReceptionist.tsx');
  let at = rec.indexOf('onClick={() => void startAddonCheckout()}');
  assert.ok(at > 0);
  while (at > 0) {
    assert.match(rec.slice(at - 900, at), /nativeApp \?/);
    at = rec.indexOf('onClick={() => void startAddonCheckout()}', at + 1);
  }
  const gate = src('components/SubscriptionGate.tsx');
  assert.ok(gate.indexOf('{!nativeApp && (') < gate.indexOf("onCheckout('monthly')"));
  const trial = src('app/trial/page.tsx');
  assert.match(trial, /if \(nativeApp\) return <NativeSignupNotice \/>;/);
});

test('account deletion stays available in the app (Apple 5.1.1(v))', () => {
  const page = src('app/page.tsx');
  const del = page.indexOf('Schedule account deletion');
  assert.ok(del > 0);
  // The delete card must not sit behind a nativeApp guard.
  const card = page.lastIndexOf('<h3 className="text-xl font-semibold text-red-700">Delete account</h3>', del);
  assert.ok(card > 0);
  assert.ok(!/nativeApp/.test(page.slice(card, del)));
  assert.ok(existsSync(path.join(root, 'app/api/account/delete/route.ts')));
});

test('npm scripts and release docs exist', () => {
  const pkg = JSON.parse(src('package.json'));
  for (const s of ['mobile:sync', 'mobile:ios', 'mobile:android', 'mobile:assets']) assert.ok(pkg.scripts[s], s);
  for (const f of [
    'docs/MOBILE_RELEASE.md',
    'docs/store-listing/app-store.md',
    'docs/store-listing/google-play.md',
    'docs/store-listing/app-privacy.md',
    'docs/store-listing/review-notes.md',
    'docs/store-listing/privacy-answers.md',
  ]) {
    assert.ok(existsSync(path.join(root, f)), f);
  }
});

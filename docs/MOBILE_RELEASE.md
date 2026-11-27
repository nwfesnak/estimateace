# EstimateAce on the App Store and Google Play: Mac mini checklist

This is the step-by-step guide for turning EstimateAce into the iPhone and Android apps and getting them into the stores. Do it on the Mac mini, from top to bottom. Each step says how long it usually takes.

---

## How the app works (read once)

- The store app is a **native shell** (built with [Capacitor 8](https://capacitorjs.com)) that opens the live site **https://app.estimateace.com**.
  - Every website deploy updates the app right away. You only need to re-submit to the stores when the **native** parts change: icons, permissions, plugins or `capacitor.config.ts`.
- **No signal:** the app shows a bundled "You're offline — Try again" screen (`mobile/www/offline.html`).
- **Links to other sites:** Stripe checkout, customer pay links, Stripe Connect setup, maps and help pages open in the phone's browser (Safari / Chrome), not inside the app.
- **Store payment rules.** The app is a free companion to the paid web service (Apple guideline **3.1.3(f)**). That has three consequences:
  - Inside the app there are **no** buttons or prices for buying a plan, an add-on or a crew seat.
  - The app shows: *"Plans, add-ons and crew seats are managed in your EstimateAce account on the web at estimateace.com."*
  - New users see: *"Create your account on the web at estimateace.com, then log in here."*
  - The website is unchanged. Contractors' **customer** payments (pay links for real-world jobs) are allowed and keep working.
- **No tracking.** The Facebook/Meta pixel is switched off inside the app, so you don't need Apple's "Allow tracking?" popup.

### Native features (guideline 4.2)

The store app is more than a remote WebView. Native pieces that ship in this project:

- **LiDAR room scan** — custom Capacitor plugin (`RoomScanPlugin.swift` / Apple RoomPlan) on LiDAR-equipped Pro iPhones (iOS 16+). Other devices enter length × width × height.
- **Camera, microphone, and photo library** — job-site photos, walkthrough video, and receipt capture via the WebView (`getUserMedia` / file picker), with Info.plist and AndroidManifest usage strings.
- **Approximate location** — optional, used only to bias address autocomplete.
- **Offline / no-network screen** — bundled `mobile/www/offline.html` (`server.errorPath`) with a Try again button and auto-retry when the connection returns.
- **System-browser handoff** — Stripe, maps, and other hosts open in Safari / Chrome Custom Tabs (`@capacitor/browser` and `allowNavigation`).
- **Splash screen and status bar** — `@capacitor/splash-screen` and `@capacitor/status-bar`.
- **In-app account deletion** — Profile → Billing → Delete account (Apple 5.1.1(v)), plus https://app.estimateace.com/delete-account (Google).
- **No purchase CTAs** — plan, add-on, and crew-seat checkout buttons and prices are hidden in the native app; those APIs return 403 for the app user-agent.

There are no push-notification or haptics plugins in this release.

- **Account deletion** is inside the app (Apple 5.1.1(v)): Profile → Billing → Manage billing → Delete account. There's also a public page for Google Play: **https://app.estimateace.com/delete-account**.

| Item | Value |
|---|---|
| App name | EstimateAce |
| Bundle ID / package name | `com.estimateace.app` (iOS and Android). **Can never change after the first upload.** |
| iOS minimum | iOS 15, iPhone only (iPad runs the iPhone version). To support iPad later, see "Later" at the bottom. |
| Android minimum / target | Android 7 (API 24) / Android 16 (API 36) |
| Privacy policy URL | https://app.estimateace.com/privacy |
| Terms URL | https://app.estimateace.com/terms |
| Account deletion URL | https://app.estimateace.com/delete-account |
| Support email | admin@estimateace.com |
| Current store version | iOS 1.0.1 (build 2) · Android versionName 1.0.1 / versionCode 2 |

---

## 0. Accounts to create first (start now: approval can take days)

1. **Apple Developer Program**: **$99 per year**, https://developer.apple.com/programs/enroll/
   - Enroll **as an organization** (your LLC/company) so the store shows your company name, not your personal name.
   - Organization enrollment needs a free **D-U-N-S number**. Look one up or request it at https://developer.apple.com/enroll/duns-lookup/ (it can take up to about 5 business days).
   - You need an Apple ID with two-factor authentication on.
2. **Google Play Console**: **$25 one time**, https://play.google.com/console/signup
   - Choose an **Organization** account if you can (it also uses a D-U-N-S number).
   - **Personal** Google Play accounts must run a **closed test with at least 12 testers for 14 days in a row** before they can publish to production. Organization accounts skip that rule.
   - Google verifies your identity (ID and address). This can take a few days.

---

## 1. Install the tools on the Mac mini (about 1–2 hours, mostly downloads)

1. **Update macOS** to the newest version (System Settings → General → Software Update). The newest Xcode needs a recent macOS.
2. **Xcode**: install it from the Mac App Store (large download). Open it once, accept the license, and let it install its components. Then, in Terminal:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app
   xcodebuild -runFirstLaunch
   ```
   In Xcode → Settings → Components, install the latest **iOS simulator**.
3. **Homebrew**: follow the instructions at https://brew.sh.
4. **Node.js 22 or newer** and **git**:
   ```bash
   brew install node git
   node -v   # must print v22 or higher
   ```
5. **CocoaPods: not needed.** This project uses Swift Package Manager, which is built into Xcode. Skip CocoaPods unless a future plugin asks for it (`brew install cocoapods`).
6. **Android Studio**: install it from https://developer.android.com/studio. Open it and run the setup wizard with the defaults (it installs the Android SDK and its own Java). Then:
   - Go to Settings → Languages & Frameworks → Android SDK.
   - Make sure **Android 16 (API 36)** and the latest **Build-Tools** are checked.
   - Add this to `~/.zshrc`, then open a new Terminal:
     ```bash
     export ANDROID_HOME="$HOME/Library/Android/sdk"
     export PATH="$ANDROID_HOME/platform-tools:$PATH"
     ```

## 2. Get the code and set it up (10 minutes)

```bash
git clone https://github.com/nwfesnak/estimateace.git
cd estimateace
npm run mobile:setup     # checks tools, runs npm ci, creates/syncs ios/ and android/
```

`npm run mobile:setup` is safe to run again any time. The other mobile commands:

| Command | What it does |
|---|---|
| `npm run mobile:sync` | Copies `capacitor.config.ts`, plugins and the offline page into `ios/` and `android/` |
| `npm run mobile:ios` | Syncs, then opens the iOS project in Xcode |
| `npm run mobile:android` | Syncs, then opens the Android project in Android Studio |
| `npm run mobile:assets` | Regenerates every icon and splash size from `assets/*.png` |
| `npm run mobile:doctor` | Health check of the Capacitor setup |
| `npm run test:mobile` | Automated checks for the mobile wrapper |

New logo? Replace `assets/icon-only.png` (1024×1024, no transparency), `assets/icon-foreground.png`, `assets/icon-background.png`, `assets/splash.png` and `assets/splash-dark.png` (2732×2732), then run `npm run mobile:assets`. `python3 scripts/mobile-make-source-art.py` redraws the current "EA" art.

## 3. Try it on the simulator and on your phone (30 minutes)

**iPhone**
1. Run `npm run mobile:ios`. Xcode opens `ios/App/App.xcodeproj`. The first time, wait for "Resolving Package Graph" to finish.
2. Click the **App** project → **App** target → **Signing & Capabilities**.
3. Tick **Automatically manage signing** and choose your **Team** (it appears after Apple approves your developer account).
4. Choose an iPhone simulator at the top and press ▶ Run.
5. To run on your own iPhone:
   - Plug it in and trust the computer.
   - On the phone, turn on Settings → Privacy & Security → **Developer Mode**.
   - Choose the phone in Xcode and press ▶.

**Android**
1. Run `npm run mobile:android` and wait for Android Studio's Gradle sync to finish.
2. Use Device Manager to create a Pixel emulator, or plug in a phone with USB debugging on.
3. Press ▶ Run.

**Check these in the app before you submit:**
- [ ] The splash screen shows, then the login page loads.
- [ ] Log in works. The **Turnstile** check passes. "Forgot your password?" sends the email. The reset link opens in the phone's browser, where you set the new password, then log in inside the app.
- [ ] Nothing hides under the notch / status bar or the home bar. Scroll every main tab.
- [ ] New estimate → take a photo with the **camera**. Allow camera access when asked. Then attach a photo from the **library**. Then record a short **video**; the microphone prompt should appear.
- [ ] Profile → Billing shows the plan status but **no** Subscribe buttons and no prices. Manage billing still shows **Delete account**.
- [ ] AI Receptionist shows no Subscribe button or price.
- [ ] Open a customer pay link or terms link. It opens in Safari / Chrome, not inside the app.
- [ ] Airplane mode on → relaunch → the "You're offline" screen appears. Airplane mode off → **Try again** → the app loads.
- [ ] Android: the back button goes back, and at the login screen it closes the app.

## 3B. LiDAR room scan (iPhone Pro only) — build + test on the Mac mini

The app has its own small native plugin, not an npm package:
- `ios/App/App/RoomScanPlugin.swift` uses Apple RoomPlan.
- `ios/App/App/EstimateAceBridgeViewController.swift` registers it. `SceneDelegate.swift` and `Main.storyboard` now use this controller.
- The web code that calls it is `lib/room-scan.ts`.

It could not be compiled on Linux, so the **first Xcode build on the Mac is the first compile**.

1. `npm install && npm run mobile:sync`, then `npm run mobile:ios` (opens Xcode).
2. In Xcode, check that the **App** target lists `RoomScanPlugin.swift` and `EstimateAceBridgeViewController.swift` under *Build Phases → Compile Sources*. They are already in the project file.
3. Check that *Build Settings → Other Linker Flags* contains `-weak_framework RoomPlan`. This keeps the app launching on iOS 15 phones, which have no RoomPlan.
4. Build onto a **LiDAR iPhone**: 12 Pro / 13 Pro / 14 Pro / 15 Pro / 16 Pro / 17 Pro (or Pro Max), iOS 16+. The simulator has no LiDAR, so "Scan room" stays hidden there. That is expected.
5. In the app, open an estimate and tap **📸 Photo estimate**. The **Scan room (LiDAR)** button should appear.
   - Tap it and allow camera access. The first time, iOS shows the camera permission text from Info.plist.
   - Walk the room and tap **Done**.
   - After a few seconds the floor sq ft, wall sq ft, perimeter, ceiling height, doors and windows fill in.
6. Check the numbers against a tape measure. Within about 5% is normal. Floor area is exact on iOS 17+; on iOS 16 it is approximated from the walls (a little high for L-shaped rooms).
7. Test **Cancel**: the sheet closes and the measurements stay unchanged.
8. On a non-Pro iPhone and on Android, the scan button must not appear. Typing length × width × height must still work.

Privacy: the 3D scan never leaves the phone. Only the summary numbers (sq ft, feet, counts) are sent with the estimate request, so the App Privacy answers don't change.

If the build fails in `RoomScanPlugin.swift`, copy the error. RoomPlan APIs are guarded with `#available(iOS 16/17)`, and the deployment target stays iOS 15.

## 4. Signing

**iOS**: Xcode handles it once your Team is chosen (step 3). No files to manage.

**Android**: you need an **upload key** (one time; keep it safe forever).
1. Create the key:
   ```bash
   # A generated upload keystore also lives at /workspace/android-upload-keystore.jks
   # with the password in /workspace/android-keystore.txt (never commit either file).
   keytool -genkeypair -v -keystore /workspace/android-upload-keystore.jks \
     -alias estimateace-upload -keyalg RSA -keysize 2048 -validity 10950
   ```
2. Create `android/keystore.properties` (gitignored — **never commit it**). Point `storeFile` at the `.jks` path:
   ```properties
   storeFile=/workspace/android-upload-keystore.jks
   storePassword=YOUR_STORE_PASSWORD
   keyAlias=estimateace-upload
   keyPassword=YOUR_KEY_PASSWORD
   ```
3. Back up the `.jks` file and both passwords in your password manager. Google Play App Signing holds the real app-signing key; if this upload key is lost, Google can reset it, but that's slow.

## 5. Version numbers (every release)

- **iOS**: Xcode → App target → General.
  - **Version** (currently `1.0.1`): what users see.
  - **Build**: a number that must go up on every upload (1, 2, 3…).
- **Android**: in `android/app/build.gradle`:
  - `versionName "1.0.1"`: what users see.
  - `versionCode 1`: must go up on every upload.

## 6. Build and upload

**iOS → TestFlight**
1. In Xcode, choose **Any iOS Device (arm64)** at the top.
2. Product → **Archive**. When the Organizer opens, choose **Distribute App** → **App Store Connect** → Upload.
3. In 10–30 minutes the build shows in App Store Connect → your app → **TestFlight**.
4. Add yourself under **Internal Testing**, install the **TestFlight** app on your iPhone, and test.
5. Answer the export compliance question: **No** custom encryption. `ITSAppUsesNonExemptEncryption` is already set to NO.

**Android → Internal testing**
1. In Android Studio: Build → **Generate Signed App Bundle / APK** → **Android App Bundle**, using the key from step 4, **release**.
   - Or from Terminal: `cd android && ./gradlew bundleRelease`.
   - The file is `android/app/build/outputs/bundle/release/app-release.aab`.
2. In Play Console, open Testing → **Internal testing** → Create release. Upload the `.aab` and add testers by email.
3. Accept **Play App Signing** when asked.
4. Personal account? Also run **Closed testing** with 12 or more testers for 14 days before you can apply for production.

## 7. Store listings (copy from `docs/store-listing/`)

**App Store Connect** (https://appstoreconnect.apple.com → Apps → ＋ New App)
- Platform iOS. Name **EstimateAce**. Language English (U.S.). Bundle ID `com.estimateace.app`. SKU `estimateace-ios`.
- **App Information**:
  - Subtitle.
  - Category: **Business** (secondary: Productivity).
  - Content rights: No third-party content.
  - Age rating questionnaire: everything "None"; result **4+**.
- **Pricing and Availability**: **Free**, United States (add Canada later if wanted).
- **App Privacy**: privacy policy URL, plus the answers in `docs/store-listing/app-privacy.md`.
- **Version page**:
  - Screenshots.
  - Promotional text, description and keywords (from `app-store.md`).
  - Support URL `https://estimateace.com`, marketing URL `https://estimateace.com`.
  - Copyright "2026 EstimateAce".
  - **App Review Information** (from `review-notes.md`, including the demo login).
  - Choose the build from TestFlight → **Add for Review** → Submit.

**Google Play Console** (Create app)
- App name **EstimateAce**. Default language English (US). **App**, **Free**. Accept the declarations.
- **Dashboard → Set up your app**:
  - Privacy policy URL.
  - App access: "All or some functionality is restricted", with the demo login from `review-notes.md`.
  - Ads: **No**.
  - Content rating questionnaire: Category Utility/Productivity; result Everyone.
  - Target audience: **18+**.
  - News app: No.
  - Data safety: answers in `app-privacy.md`, plus delete-account URL `https://app.estimateace.com/delete-account`.
  - Government app: No. Financial features: none (customer payments go through Stripe on the web).
  - Health: No.
- **Main store listing**: short and full description (from `google-play.md`), app icon 512×512, feature graphic 1024×500, phone screenshots.

## 8. Screenshots

Take them on the simulators / emulator, logged into the **demo account** with realistic sample jobs (no real customer names or phone numbers).

| Store | Required size | How |
|---|---|---|
| App Store: iPhone 6.9" | **1320 × 2868** (or 1290 × 2796) portrait, 3–10 images | iPhone 17 Pro Max (or 16 Pro Max) simulator → ⌘S saves to the Desktop |
| App Store: iPhone 6.5" | 1284 × 2778 or 1242 × 2688 (only if App Store Connect asks) | iPhone 11 Pro Max / XS Max simulator |
| Google Play: phone | 2–8 images, 9:16, each side 1080–3840 px (1080 × 1920 is safe) | Pixel emulator → camera icon in the emulator toolbar |
| Google Play: feature graphic | **1024 × 500** PNG/JPG | Make in Canva: logo plus "Estimates & invoices in minutes" |
| Google Play: app icon | **512 × 512** PNG | Resize `assets/icon-only.png` |

Suggested 5 shots:
1. The dashboard / jobs list.
2. AI estimate from photos.
3. A finished estimate PDF.
4. An invoice with a customer pay link.
5. AI Receptionist call log.

## 9. Review tips (avoid the common rejections)

- **4.2 Minimum functionality (web wrapper).** The app adds native camera and video capture, an offline screen, a native splash, system-browser handoff and account deletion. In the review notes, mention camera capture for job photos and the AI phone receptionist. If Apple still says "4.2", the usual fix is adding **push notifications** (for example "new lead from AI Receptionist"). See "Later".
- **3.1.1 / 3.1.3(f) payments.** The app never shows plan prices or Subscribe buttons. Don't add any wording like "subscribe on our website for $X". The review notes explain this.
- **5.1.1(v) account deletion.** It's in the app (Profile → Billing → Manage billing → Delete account). Put the path in the review notes.
- **Demo account.** It must work for the whole review: an active plan (promo or comped), sample jobs, and Turnstile allowed. If Turnstile blocks the reviewer, see "Settings you control" below.
- **Google Play 12-tester rule** (personal accounts only): recruit testers early (family, crew, customers).

## 10. Settings you control (outside the code)

Nothing is **required** right now. The app loads `https://app.estimateace.com` itself, so the browser origin, Supabase auth, cookies and Turnstile all see the same site as on the web.

| Service | Setting | Needed now? |
|---|---|---|
| Supabase → Auth → URL configuration | Site URL and redirect URLs: keep what the website uses today (`https://app.estimateace.com/reset-password` must stay allowed) | No change. Password-reset and confirm emails open in the phone browser, which is fine. |
| Cloudflare Turnstile widget | Hostnames: `app.estimateace.com` (already set) | No change. If a reviewer gets stuck on the check, make sure the widget mode is **Managed**, so a person can always click through. |
| Stripe | Nothing. Checkout and Connect open in the browser. | No |
| Vercel env | Nothing | No |

**Only if you later bundle the web app inside the app** (no `server.url`), add `capacitor://localhost` and `https://localhost` to Supabase redirect URLs, and `localhost` to the Turnstile hostnames. The current setup doesn't need it.

## 11. Later (optional upgrades)

- **Push notifications** (helps with 4.2): add `@capacitor/push-notifications`, an APNs key (Apple) and Firebase `google-services.json` (Android), and a server sender for new leads, payments and calls.
- **Open email links in the app** (Universal Links / App Links):
  - Host `/.well-known/apple-app-site-association` (needs your Apple Team ID) and `/.well-known/assetlinks.json` (needs the Play signing SHA-256) on app.estimateace.com.
  - Add the Associated Domains capability in Xcode and an intent filter in `AndroidManifest.xml`.
- **iPad layout:** in Xcode → App target → General → Supported Destinations, add iPad. You'll then also need 13" iPad screenshots (2064 × 2752).
- **US storefront purchase links:** since May 2025 Apple lets US apps link to web checkout. That's a policy decision; the app currently shows no purchase links anywhere.

# Build and sign for Safari on macOS

**You can complete the main guide entirely in Xcode and Finder. Terminal is not required.**
Sign in with your own Apple ID (now called an Apple Account), select your team, and let
Xcode sign both the app and extension. A free **Personal Team** works for personal use;
paid Apple Developer Program membership is not needed for this local build.

With both targets signed using your Apple Development certificate, Safari does not need
**Allow unsigned extensions**. This is still a personal development installation: signing
assets can expire and require renewal. It is not an App Store or notarized distribution build.

The prebuilt Safari ZIP in Releases is an **unsigned testing build** with an ad-hoc
signature. It requires developer features and re-enabling unsigned extensions after every
Safari restart. Signing in to Xcode does not change that downloaded app: build the source
with your own signing settings below.

## 1. Install Xcode and download the source

1. Install the full **Xcode** app from the Mac App Store. Open it, accept its licence, and
   let it install required components. Command Line Tools alone are not enough.
2. Use a macOS version supported by Xcode. The checked-in app targets **macOS 27.0** and
   has been built with **Xcode 27.1**; this guide does not establish older-macOS compatibility.
3. Open the [repository page](https://github.com/mindingulove/yt-local-player).
4. Click the green **Code → Download ZIP** button. Use this source ZIP, not
   **YT-Local-Player-Safari.zip** from Releases, which contains only the prebuilt app.
5. In **Finder → Downloads**, double-click the source ZIP to extract it. Open the extracted
   **yt-local-player-main** folder. That folder contains **README.md**, **extension**,
   **vendor**, and **YT Local Player**; it is the source folder used below.

You do not need Node.js, npm, Homebrew, or the optional yt-dlp helper for this build.

## 2. Copy the bundled HLS library in Finder

Do this before building: the command-line installer normally performs this copy, but an
Xcode-only build needs you to do it once yourself.

1. In the extracted source folder, open **vendor**.
2. Select **hls.min.js** and choose **Edit → Copy** (or press **⌘C**).
3. Return to the source folder, then open **extension → lib**.
4. Choose **Edit → Paste Item** (or press **⌘V**). Replace the existing file if asked.

The destination must be **extension/lib/hls.min.js**. Keep the other files in that folder.

## 3. Open the exact project file

1. Return to the source folder and open the **YT Local Player** folder.
2. Double-click **YT Local Player.xcodeproj** to open it in Xcode.

That is the project file to click. Do not open the prebuilt app or an individual Swift
source file instead. Opening the project does not install the extension.

## 4. Sign in and create an Apple Development certificate

1. In **Xcode → Settings → Accounts** (called **Apple Accounts** in some versions), click
   **+ → Apple Account / Apple ID** and sign in with your own account.
2. Complete two-factor authentication and any Apple agreement prompts.
3. Select your account and its **Personal Team**, or your existing paid team if you have one.
4. Click **Manage Certificates… → + → Apple Development**. Xcode creates the certificate
   and stores its private key in your Mac's Keychain. You can also use an existing valid
   Apple Development certificate whose private key is on this Mac.

All sign-in happens inside Xcode. You do not need to enter your Apple ID in Terminal or
manually copy a Team ID for this graphical workflow.

## 5. Configure both targets in Xcode

1. Select the blue **YT Local Player** project icon at the top of Xcode's left sidebar.
   If the sidebar is hidden, choose **View → Navigators → Project**.
2. Under **TARGETS**, select **YT Local Player**.
3. Open **Signing & Capabilities**. Select **All** configurations if Xcode offers an
   All / Debug / Release selector.
4. Enable **Automatically manage signing** and select your own team in **Team**.
5. Open **Build Settings**, select **All**, and search for **BUNDLE_ID_PREFIX**. Under
   **User-Defined**, replace **io.github.example** with a distinctive reverse-DNS prefix,
   such as **io.github.yourusername**. Apply it to **both Debug and Release**: expand the
   setting's disclosure arrow and check both values.
6. Under **TARGETS**, select **YT Local Player Extension** and repeat steps 3–5. Use the
   **same team and the same prefix** for this target.
7. Return to **Signing & Capabilities** for each target and check that signing resolves
   to **Apple Development**, with no signing errors. Do not choose **Sign to Run Locally**;
   that creates an ad-hoc signature and still requires Safari's unsigned-extension option.

For the example prefix, the resulting identifiers should be:

| Target | Bundle identifier |
| --- | --- |
| YT Local Player | io.github.yourusername.ytlocalplayer |
| YT Local Player Extension | io.github.yourusername.ytlocalplayer.Extension |

If Apple says an identifier is unavailable, choose a more distinctive prefix on both
targets. Keep your chosen identifiers for later updates so Safari recognizes the same
extension. Save the project. These signing choices change your local project settings;
do not commit your personal team settings back to the shared repository.

Apple documents [assigning targets to a team](https://help.apple.com/xcode/mac/current/en.lproj/dev23aab79b4.html),
[Personal Teams](https://developer.apple.com/help/account/basics/about-your-developer-account),
and [creating certificates](https://help.apple.com/xcode/mac/current/en.lproj/dev154b28f09.html).

## 6. Build through Xcode's menus

1. In Xcode's top toolbar, select the **YT Local Player** scheme and **My Mac** destination.
2. Choose **Product → Scheme → Edit Scheme…**.
3. Select **Run** on the left, open **Info**, set **Build Configuration** to **Release**,
   and click **Close**.
4. Choose **Product → Build** (or press **⌘B**).
5. If Keychain asks whether **codesign** may use your signing key, authorize it with your
   Mac login password.
6. Wait for **Build Succeeded**. If it fails, open **View → Navigators → Issues** and resolve
   the reported error before proceeding.

Use **Build**, rather than the Run / Play button or **⌘R**, so you can install the app in
Applications before launching it and avoid registering a second copy from Xcode's build folder.

## 7. Move the built app into Applications with Finder

1. In Xcode, choose **Product → Show Build Folder in Finder**.
2. In the Finder window, open **Products → Release**. If Finder opens directly in Products,
   open **Release** there.
3. Select **YT Local Player.app** and press **⌘C**.
4. Choose **Go → Applications** in Finder.
5. Choose **Edit → Move Item Here** (**⌥⌘V**). Use **Move**, rather than Paste, to avoid
   keeping a second built app that Safari might register. Replace the previous copy if
   you are updating, and authenticate if macOS requests permission to write to Applications.
6. Double-click **YT Local Player.app** in **Applications** to open it once and register
   its extension with Safari.

A later build will recreate the app in Xcode's build folder; move that new build into
Applications again when updating. If you need to find the product another way, expand
**Products** in Xcode's project navigator, Control-click **YT Local Player.app**, and choose
**Show in Finder** after the successful Release build.

## 8. Enable and check it in Safari

1. Open **Safari → Settings → Extensions**.
2. Enable **YT Local Player** and grant access to **youtube.com**.
3. Reload your YouTube pages, including the YouTube web app if you use it, so they load the
   new extension code.
4. If **Allow unsigned extensions** was previously enabled, turn it off. Fully quit and
   reopen Safari and confirm **YT Local Player** remains available and works on YouTube.
5. Safari's web developer features can then be turned off as well.

This checks the result through Safari without a command-line signature check. If it only
works while unsigned extensions are allowed, revisit both targets' signing settings and
make sure Applications contains your new Apple Development-signed build.

## Updates and troubleshooting

- **Updating source:** download the new source ZIP and repeat the Finder library copy,
  both-target signing setup, build, and move steps. Use the same team and bundle identifiers.
  Rebuilding your existing configured source folder keeps its local signing choices.
- **No certificate or authentication failure:** sign in again under Xcode Settings and
  check Manage Certificates for an Apple Development certificate with its private key on
  this Mac. Check that both targets use the correct team, then build again.
- **Certificate or profile expired:** renew the assets in Xcode, rebuild, and reinstall.
  Personal Team provisioning has restrictions and may require periodic renewal.
- **Two extension copies:** quit Safari, remove older app copies you no longer need, keep
  the signed app in Applications, and reopen it and Safari. Avoid launching from the build folder.
- **Missing HLS library or player resources:** verify **extension/lib/hls.min.js** exists.
  Copy it from **vendor/hls.min.js** again and rebuild. Keep the extracted source folders
  together so Xcode's relative file references still resolve.
- **Older macOS or SDK error:** the app target currently requires macOS 27.0. Changing the
  extension target alone does not change the app's requirement.

## Optional: Terminal automation and signature inspection

The main steps above do not require these commands. If you prefer automation, the existing
installer script performs the HLS copy, Release build, installation into Applications, and
first launch. Use this alternative instead of manually configuring and moving the app.

In Terminal, change to the source folder containing README.md. Copy
**Local.xcconfig.example** to **Local.xcconfig**:

```sh
cp Local.xcconfig.example Local.xcconfig
open -e Local.xcconfig
```

Set **DEVELOPMENT_TEAM** to your 10-character Team ID and **BUNDLE_ID_PREFIX** to your unique
prefix. To find the Team ID after selecting your team in Xcode, inspect **Build Settings →
All → Development Team** and copy the underlying 10-character value. It is not your email,
certificate fingerprint, or bundle identifier. Local.xcconfig is ignored by Git; do not
put passwords or private keys in it.

Then run:

```sh
bash scripts/install-safari.sh
```

If Terminal reports that only Command Line Tools are selected, choose your full Xcode
installation under **Xcode → Settings → Locations → Command Line Tools**, then retry.
Do not use **scripts/build-release.sh** for a personally signed installation: it deliberately
creates the ad-hoc-signed public testing build.

For additional signature inspection, these commands check the app and its embedded extension:

```sh
codesign --verify --deep --strict --verbose=2 "/Applications/YT Local Player.app"
codesign -dv --verbose=4 "/Applications/YT Local Player.app"
codesign -dv --verbose=4 "/Applications/YT Local Player.app/Contents/PlugIns/YT Local Player Extension.appex"
```

The first command should succeed. The other two should report **Authority=Apple Development: …**
and the same **TeamIdentifier** matching your team. **Signature=adhoc** or
**TeamIdentifier=not set** indicates an ad-hoc build; integrity verification alone does not
establish an Apple-issued signature.

## Sharing a build with someone else

Each person can follow this guide with their own Apple ID for their own Mac. Do not share
your signing private key or ask someone to sign in with your account.

For other people to install a normally signed build without building or enabling unsigned
extensions, the publisher needs Apple Developer Program membership and a proper distribution
build: the Mac App Store, or Developer ID signing and notarization for supported direct
distribution. That is separate from this Personal Team workflow and is not performed by
the current release script. See Apple's
[Safari extension distribution documentation](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension)
and [Developer ID overview](https://developer.apple.com/developer-id/).

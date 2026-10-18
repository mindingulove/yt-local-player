# Build and sign for Safari on macOS

Build YT Local Player on your own Mac and sign it with your own Apple ID (now called an
Apple Account). A free Xcode **Personal Team** works for personal use; paid Apple Developer
Program membership is not needed for this local build. With both the app and extension
signed using your Apple Development certificate, Safari does not need **Allow unsigned
extensions**, and you can leave its web developer features off.

This is a local development installation, not an App Store or notarized distribution build.
The Safari ZIP in this project's Releases uses an ad-hoc signature and still requires the
unsigned-extension option. To use your own signature, build from source below.

## 1. Install Xcode and get the source

Install the full **Xcode** app from the Mac App Store (Command Line Tools alone are not
enough). Open it once, accept its licence, and let it install any required components.
Use a macOS version supported by Xcode. The checked-in project currently uses the macOS
27 SDK and an app deployment target of macOS 27.0, and has been built with Xcode 27.1;
these instructions do not establish compatibility with older macOS versions.

To download and open the source using Finder:

1. Open the [repository page](https://github.com/mindingulove/yt-local-player).
2. Click the green **Code** button, then **Download ZIP**. This downloads the source project;
   the Safari app ZIP under Releases does not contain the Xcode project.
3. In **Finder → Downloads**, double-click the downloaded ZIP to extract it. Open the
   extracted **yt-local-player-main** folder (the name can differ for another branch).
4. Inside it, open the **YT Local Player** folder.
5. Double-click **YT Local Player.xcodeproj**. This is the file to open in Xcode. Finder
   treats it as a single project file even though it is stored as a directory on disk.
6. Continue with Apple ID sign-in in step 2 below. Opening the project does not install
   the extension; the build/install command in step 4 does that.

The source folder containing **README.md**, **Local.xcconfig.example**, and **scripts** is
the **repository root** used by the Terminal commands below. To open Terminal there, select
that folder in Finder and choose **Services → New Terminal at Folder** from its context
menu (it may be under **Quick Actions**). If you downloaded the ZIP, skip the `git clone`
and `cd yt-local-player` commands below; your Terminal is already in the source folder.

In Terminal, check that the full Xcode installation is selected:

```sh
xcodebuild -version
```

If it reports that only Command Line Tools are selected, select your Xcode installation
(adjust the path if you installed it elsewhere):

```sh
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

Alternatively, download the source using Terminal instead of the ZIP:

```sh
git clone https://github.com/mindingulove/yt-local-player.git
cd yt-local-player
```

Node.js, npm, Homebrew, and the optional yt-dlp helper are not required for this Safari
build. The generated JavaScript decoder and other browser resources are already included.

## 2. Sign in with your own Apple ID and create a certificate

1. In **Xcode → Settings → Accounts** (called **Apple Accounts** in some versions), click
   **+**, choose **Apple Account / Apple ID**, and sign in with your own account. Complete
   two-factor authentication and any Apple agreement prompts.
2. Select your account and its **Personal Team**, or your existing paid team if you have one.
3. Click **Manage Certificates…**, then **+ → Apple Development**. Xcode creates the
   certificate and stores its private key in your Mac's Keychain. An existing valid Apple
   Development certificate with its private key on this Mac can also be used.
4. Note the team's **10-character Team ID** if Xcode displays it in the account details.
   It is not your email address, certificate fingerprint, or bundle identifier.

If Xcode does not display the Team ID in Accounts, open the project:

```sh
open "YT Local Player/YT Local Player.xcodeproj"
```

Select the blue project icon, then the **YT Local Player** target. Under **Signing &
Capabilities**, select your team with **Automatically manage signing** enabled. In
**Build Settings**, choose **All**, search for **Development Team**, and copy the underlying
10-character value (double-click the value to inspect it). Use that value in the next step.
The installation script supplies the same team to both targets, so you do not need to
save personal signing settings in the shared project. Do not use **Sign to Run Locally**;
that creates an ad-hoc signature rather than your Apple Development signature.

Apple documents [Personal Teams and account setup](https://developer.apple.com/help/account/basics/about-your-developer-account),
[the signing workflow](https://help.apple.com/xcode/mac/current/en.lproj/dev60b6fbbc7.html),
and [creating signing certificates](https://help.apple.com/xcode/mac/current/en.lproj/dev154b28f09.html).

## 3. Configure your local signing values

From the repository root:

```sh
cp Local.xcconfig.example Local.xcconfig
open -e Local.xcconfig
```

Replace the example values with your Team ID and a unique reverse-DNS prefix, for example:

```xcconfig
DEVELOPMENT_TEAM = ABCDE12345
BUNDLE_ID_PREFIX = io.github.yourusername
```

Replace both placeholders. The project derives the app ID
`io.github.yourusername.ytlocalplayer` and extension ID
`io.github.yourusername.ytlocalplayer.Extension` from that prefix. Keep the same prefix
for future updates so Safari recognizes the same extension. If Apple says an identifier
is unavailable, choose a more distinctive prefix.

`Local.xcconfig` is ignored by Git. Do not put your Apple password, verification codes, or
private keys in it; authentication happens inside Xcode and Keychain.

## 4. Compile, sign, and install

From the repository root, run:

```sh
bash scripts/install-safari.sh
```

The script copies the bundled HLS library into the Safari resources, builds the **Release**
scheme with automatic signing and your `Local.xcconfig`, and allows Xcode to update
provisioning assets. It then installs `/Applications/YT Local Player.app` and opens it
once to register the extension. It replaces an existing app at that path and removes its
temporary build-products copy to avoid registering duplicate extensions. Your account
needs write access to `/Applications`.

If Keychain asks whether `codesign` may use your signing key, authorize it using your Mac
login password. Wait for `BUILD SUCCEEDED`; do not continue after a build error.

Use this script rather than Xcode's **⌘R**, which can register a second Debug copy. Do not
use `scripts/build-release.sh` for this installation: that script deliberately makes an
ad-hoc-signed public download.

## 5. Verify the signatures and enable the extension

Check the app and its embedded extension in Terminal:

```sh
codesign --verify --deep --strict --verbose=2 "/Applications/YT Local Player.app"
codesign -dv --verbose=4 "/Applications/YT Local Player.app"
codesign -dv --verbose=4 "/Applications/YT Local Player.app/Contents/PlugIns/YT Local Player Extension.appex"
```

The first command should succeed. In each of the last two outputs, check for
`Authority=Apple Development: …` and the same `TeamIdentifier` matching your Team ID.
`Signature=adhoc` or `TeamIdentifier=not set` means you are checking an ad-hoc build.
A successful integrity check alone does not establish an Apple-issued signature.

In **Safari → Settings → Extensions**, enable **YT Local Player** and grant access to
`youtube.com`. Reload an open YouTube watch page. If you previously enabled **Allow unsigned
extensions**, turn it off and fully quit/reopen Safari to confirm the signed installation
remains available. Safari's web developer features can then be turned off as well.

## Updates and troubleshooting

- **Updating:** pull the new source, run `bash scripts/install-safari.sh` again, and reload
  YouTube. Keep your `Local.xcconfig`. New resource files must be included in the Xcode
  project; maintainers should update it or rerun `safari-web-extension-converter` when adding
  files to `extension/`.
- **No signing certificate / no accounts / authentication failure:** check that your account
  is signed in to Xcode, the correct team is selected, and Manage Certificates shows a valid
  Apple Development certificate with its private key on this Mac. Then rerun the script.
- **Certificate or profile expired:** renew the required signing assets in Xcode, rebuild,
  and reinstall. Personal Team provisioning has restrictions and can require periodic
  reprovisioning; do not treat a local development build as a permanent distribution install.
- **Two copies in Safari:** quit Safari, remove older downloaded or Debug copies of the app
  that you no longer need, keep the signed app in `/Applications`, and reopen it and Safari.
- **Still requires unsigned extensions:** inspect both signatures above and confirm Safari
  is using the copy in `/Applications`. Signing in to Xcode does not modify the release ZIP
  or a previously installed app; the signed build must succeed and be installed.
- **Older macOS / SDK error:** the current app target requires macOS 27.0. Installing only
  Command Line Tools or changing the extension target alone does not change that requirement.

## Sharing a build with someone else

Each person can follow this guide with their own Apple ID for their own Mac. Do not share
your signing private key or ask someone to sign in with your account.

For a download that other people can install without building or enabling Safari's
unsigned-extension option, the publisher needs Apple Developer Program membership and a
proper distribution build: the Mac App Store, or Developer ID signing and notarization
for supported direct distribution. That is separate from the Personal Team workflow and
is not performed by this repository's current release script. See Apple's
[Safari extension distribution documentation](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension)
and [Developer ID overview](https://developer.apple.com/developer-id/).

### S84 (Naldo), 2026-08-30 to 31, the quote tool and the advertising capture became two real phone apps: icons, names, and a router that opens the right camera. 3 PRs merged and live, 1 open from the close review. Close PR naldo/s84-close

**NUMBER:** the handoff carried none. S82 and S83 both merged to master while this session ran, so S84 was verified at close against master's fragments, every remote branch, every open and merged PR, `git worktree list`, and the machine-local self-assessment. Nothing had been stamped anywhere before that check, so no artifact had to be corrected.

## What Naldo asked for

"The name and the logo for the mobile web app, so when people download the app they see a better version instead of the black logo. I want to save multiple versions, the quote tool admin side, the office side, the advertising side, and share those links automatically with the right logo."

## The problem was never the logo

There was no web manifest and no `apple-touch-icon` anywhere in the application. iOS had nothing to use, so it fell back to a screenshot of the dark page. That is the black square. Nothing was broken; the thing had never been built.

## Shipped

- **#1111** two installable apps. Static manifests in `public/`, a generated icon set (192, 512, maskable 512, apple-touch 180 per app), a public `/install` page with QR codes and add-to-home-screen steps, root/portal/refer layout metadata, and three entries in the `operatorGate` allowlist.
- **#1127** one ads icon that opens YOUR camera. `/advertising/go` routes an admin to `/admin/advertising/capture` and a crew login to `/advertising/capture`, plus an `/admin/advertising` segment layout so the owner's camera carries the advertising identity.
- **#1137** `/login` serves the advertising manifest, icon and name when `?from=` points into the advertising surface, so installing from the login screen saves the right app. Required splitting the page into a server component plus `LoginForm.tsx`, since a client module cannot export `generateMetadata`.
- **#1143 OPEN** the close review's own findings, needing a merge-go.

## Two decisions Naldo made that overrode mine

1. **The icon is the FULL logo.** My first cut cropped the wreath and houses off the top and set a bold YLL underneath, on the argument that a 1.55:1 badge's lettering does not survive phone-icon size. He wanted the whole logo. It is his brand, and at 60px the badge shape reads even though the words do not, which is what actually matters on a home screen.
2. **No third app, and no rule change.** When he could not open the ads app I offered four options including letting admins into the crew surface. He wanted none of them: "I just wanna be able to click the app and then start taking photos." The answer was already in the repo. `/admin/advertising/capture` is the owners-shoot-too camera and auto-provisions its own worker row; the icon was pointing at the wrong door. A router fixed it and granted nobody anything.

## The support questions, answered from code rather than from a theory about iOS

- **"Why does it ask to verify my location every time?"** The camera starts a `watchPosition` the moment it opens, deliberately, so the fix is warm before the shutter. One call, correct. It turned out to be a setting on his phone.
- **"I can't seem to be able to send the ads one."** Not a broken link. Both advertising pages call `getAdvertisingCaller()` and redirect a non-advertising account to `/`, so his admin login was bounced to the quote tool by design. Reading that gate is what surfaced the owner camera and produced #1127.

Both had a plausible platform explanation available. Both were settled by reading the repo.

## Device-confirmed

Naldo installed both apps on his phone and confirmed the icons and names. That closed the one gate no amount of served-HTML checking could: iOS decides what a home-screen icon becomes, and every claim before that point was evidence about bytes, not about what a person sees.

## The close review, four lenses, every finding mine

Staff returned **BLOCK** (1 HIGH, 3 MED, 2 LOW). Customer, admin and technical returned CONCERNS (1 MED each). Dispositioned in **#1143**.

- **HIGH, and the one I would never have found.** `BlockedNote`, what a deactivated or not-yet-linked crew login sees, has no controls. Installed standalone there is no address bar and no back button, and every page in the surface gates on the same `getAdvertisingCaller()` that produced the block, **including the Settings screen holding the only Sign Out button**. Force-quitting the app was the only exit. The gate predates this session. Shipping `display: standalone` for that surface AND a public page telling crews to install it as their daily icon is what turned a screen into a trap. Fixed: `BlockedNote` now carries a Sign out button posting to the advertising logout route, which does not gate on the worker row.
- **MED, found by all four lenses independently.** `/estimate`, `/referral-link`, `/forms/<type>` and `/crew` all still inherited the operator manifest, whose `start_url` is the login screen. I fixed that exact class for `/portal` and `/refer` inside #1111 and then wrote in the PR body that the rest was deliberate "because it needs new layouts". Three of the four already export `metadata`; it was one line each. `src/app/publicManifest.test.ts` now pins every public page surface and was mutation probed.
- **MED.** The install page still warned crews to wait for the camera before installing, to avoid saving the wrong icon. #1137 removed that bug and its own commit message says "the install page warned people about it; now it does not have to", and then never edited the page. Removed.
- **MED.** "Opens straight into the camera" was false at first sign-in: `/api/login` always sends an advertising account to `/advertising`, ignoring `?from=`, so a new hire landed on Campaigns two taps short. The redirect now honours `?from=` when `isAdvertisingPath` allows it. The code moved to meet the claim rather than the claim being softened.
- **MED.** No instruction to delete the old black-square icon, which a phone never refreshes. Added.
- **LOWs accepted with reasons:** the pre-existing silent bounce for non-advertising accounts; the cosmetic route-name disclosure on the public manifests. A third LOW, "unverified on a real iPhone", is CLOSED by Naldo's device round.

## Mistakes worth carrying forward

- Shipped a standalone app around a screen with no exit. Turning off browser chrome is a change to every dead end already in that surface.
- Three of my own completeness assertions were wrong on correct data, all the same way: counting raw occurrences in a file whose comments discuss the same symbol. Assert on a delta or a distinctive anchor.
- A bash heredoc silently ate a backslash in the `safeRedirectTarget` open-redirect guard. Second heredoc mangling on this machine after S78's em dash. Never type an escape into a heredoc here; extract from source, read back, assert.
- Deploy-polling loops fired hundreds of requests at production and tripped Vercel's bot protection, making the live site 403 my own checks. A verification step should not be able to look like an outage.

## State at close

Gates on master: tsc 0 - lint 0 errors, 22 warnings - vitest **9745 across 564 files**. On the open #1143 branch: **9753 across 565**. Prod verified in a browser after each merge. **No ledger rows minted:** every review finding is either fixed in #1143 or accepted with a stated reason, so there is nothing deferred to carry.

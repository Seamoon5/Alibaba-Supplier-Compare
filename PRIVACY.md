# Privacy Policy — Alibaba Supplier Compare

**Last updated: 29 September 2026**

Alibaba Supplier Compare is a browser extension. This policy describes exactly what it does with
your data. The short version: **it reads pages you opened yourself, keeps the result on your own
computer, and sends nothing anywhere.**

## What the extension collects

**Product and supplier information from Alibaba product pages you visit yourself.** When you press
the toolbar button on an Alibaba product page, the extension reads the prices, minimum order
quantity, supplier name, company age, and credential badges published on that page, and adds them
to a comparison list in the side panel.

## What the extension does not collect

- No personal information about you
- No browsing history. It runs only on the tab you press the button on.
- No files from your computer
- No usage analytics, no tracking, no advertising, no telemetry of any kind
- No cookies, no device identifiers, no fingerprinting
- No supplier contact details (Alibaba does not publish them on product pages, and the extension
  does not attempt to retrieve them)

## Where your data goes

Nowhere. Everything is stored locally in your browser using `chrome.storage.local` and never leaves
your device. There is no server, no account, no sign-in, and no network request made by this
extension. The copied cells when you press **Copy for Sheets** or **Copy quote summary** go to your
own clipboard, and the **Download CSV** file is saved by your own browser to a folder you choose.

## What it reads, and when

The extension asks for the `activeTab` permission. This means that only when you press its toolbar
button does it get temporary access to the single tab you are looking at. It does not run on any
page in the background, and it cannot read tabs you have not explicitly pointed it at.

## Third-party services

None. The extension makes no requests to any server, including the developer's. If you later install
a version that can write to Google Sheets, that version will be documented here before release, and
it will require your explicit authorisation with Google.

## Your control

- **Clear this comparison**: the **Clear** button in the side panel removes every saved supplier.
- **Reset everything**: Settings → **Reset saved data** clears saved suppliers and filters.
- **Remove it entirely**: in Chrome, open `chrome://extensions`, find Alibaba Supplier Compare, and
  choose **Remove**. This deletes all of its stored data.

## Changes to this policy

Any change to what the extension collects will be listed here, with the version number that
introduced it, before that version is published.

## Contact

Questions about this policy: open an issue on the project's GitHub repository.

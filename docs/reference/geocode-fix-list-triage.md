# Geocode fix-list triage (25 properties, measured 2026-08-29)

Every property below has no verified coordinate, so its jobs cannot be scheduled.
The Archive button on /admin/geocoding refuses any property that has a job or a
live quote attached, so the list splits cleanly into what the tool will let you
archive and what it will not.

## 1. Safe to archive: 7 test rows

These are test or placeholder records with no job and no live quote. Archiving
them takes the list from 25 rows to 18 and leaves only real work on screen.

| Customer | Address |
|---|---|
| Anonymous | (no address) |
| Save Test 80510 | 30 Wagon Ln, Smithtown, NY 11787 |
| E2E Sat Test | 42 Lincoln Ave, Smithtown, NY 11787 |
| test | 7302 E Ave U 3, Littlerock, CA |
| Bistro E2E Test | 123 Main St, Smithtown, NY 11787 |
| Naldoven E2E Neighbor Test | 123 Main St, Smithtown, NY 11787 |
| Naldoven E2E Neighbor Test | 1 Test Lane, Amityville 11701 |

## 2. Real customers the tool WOULD let you archive: 7 rows. Fix, do not archive.

No job and no live quote yet, so the Archive button will not stop you, but these
are real people. Fix the address instead.

| Customer | Address on file | What is wrong |
|---|---|---|
| chris o connor | 65 Forest Road, Kings Park, NY, 11701 | Kings Park is 11754. 11701 is Amityville. |
| Nicholas Zebellos | 46-36 Springfield Boulevard, Queens 11361 | Needs the borough spelled the way Google expects (Bayside, NY 11361). |
| noah levy | (blank) | No address was ever captured. Needs a call or a look at the lead. |
| francesca woll | 2 Seaforth lane Huntington | Missing state and zip (NY 11743). |
| andrew bykov | (blank) | No address was ever captured. |
| john flynn | 8 Main Street Kings Park, NY 11754 (All of Main St for KP Chamber | Chamber job, not one house. Decide whether it belongs as a property at all. |
| pam fitch | 3 Kielly Ct, Salisbury Mills | Missing state and zip (NY 12577). Also far outside the normal service area. |

## 3. Blocked from archiving, must be fixed: 11 rows

The tool refuses to archive these because a job or a live quote is attached.
Six have a job that cannot be scheduled until the address verifies.

| Customer | Address on file | Why blocked | What is wrong |
|---|---|---|---|
| david alfaro | 71 E Madison St | job attached | No town, state or zip. |
| scott bucellato | (blank) | job attached | No address captured. |
| chris iorio | (blank) | job attached | No address captured. |
| julia lee | 1 Horse Shoe Path, Lloyd Harbor, BM, 11743 | job attached | "BM" is not a state. Should be NY. This is job #1045, sitting in to_schedule. |
| michael vahling | (blank) | job attached | No address captured. |
| chaudhry bashir | NEW YORK, NY, 10013 | job attached | No street number. |
| deborah sande | (blank) | live quote | No address captured. |
| rohith nandagiri | (blank) | live quote | No address captured. |
| yule love lights | (no address) | live quote | Our own record. Decide what it is for. |
| janice mckie | (blank) | live quote | No address captured. |
| stephen siena | 7 COUNTRY LAKE CT | live quote | No town, state or zip. |

## How to work it

Open /admin/geocoding. Each row has a box for the address and a Save button;
the page re-checks the address the moment you save and the row disappears when
Google matches it to a specific house. A row that saves but stays on the list
means the new address still did not match a house.

Nine of the 25 have no address at all. Those need the customer contacted or the
original lead re-read; there is nothing to correct on screen.

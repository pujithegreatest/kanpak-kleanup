# Kanpak Kleanup — local concept demo

Double-click **STARTSERVER.bat** (or **Start Server.bat**). It starts the Python server and opens the HTML interface at **http://127.0.0.1:5088**. Keep its console open; close it or press Ctrl+C to stop. Requires Python 3.11 or newer. No application packages, cloud services, or internet connection are needed.

The browser must open the server URL, not the HTML file directly. The interface files are in `static/index.html`, `static/style.css`, and `static/app.js`.

## Admin access

Initial demo password: **KanPakDemo!2026**

Open **Admin workspace** in the sidebar. Change the password under **Settings**. Employee access has no login: select Person 1–4, or a name added by an admin. Admin sessions expire after eight hours, when the server restarts, when the password changes, or when locked manually.

## Five-minute presentation

1. Show the six sample machines and green/easy, yellow/medium, red/hard task badges.
2. Find the Case conveyor's assigned person on the board and select that name. Start the task. The server records who was selected and when it started.
3. Complete the five checklist confirmations, answer the three knowledge questions, and enter a sample cleaning-record reference. Correct demo answers are first / second / third, respectively.
4. Submit. The task becomes **Needs review** and earns no points yet.
5. Open Admin workspace, inspect the checklist and notes, and verify with an inspection note. The task becomes **Verified** and earns 25 XP.
6. Show Activity & records, timestamps, Team progress, and CSV export. Demonstrate returning another task for rework; the original record remains.
7. Under Equipment or Team members, add or remove an entry. Only the admin can do this.

No fictitious completed work is seeded: the opening state is a fresh shift. Equipment is representative dairy-processing demo content, not a verified inventory of a KanPak facility. All sample procedures are placeholders referencing the approved site SOP; they do not prescribe chemicals, temperatures, contact times, or machine operation.

## Storage and multiple users

All authoritative records live in `data/cleanshift.db` on the computer running the server. SQLite transactions prevent two clients from claiming the same machine for the same date and shift. Clients poll every five seconds. Each machine has one cleaning task per Day or Night shift per server calendar date. A returned task can be retried, retaining the original attempt. Night shift dates use the start date; resuming a task after midnight retains its original date. Historical Evening records are retained.

### Balanced shift assignments

Day and Night repeat the same equipment tasks, with separate completion records. Under **Admin → Shift assignments**, select each shift's recurring crew. Initial demo rosters include all four sample people on both shifts; set the actual crews for your presentation. Newly added users must be checked into a roster before receiving tasks.

The server assigns the hardest tasks first to the person with the least assigned workload: easy = 1, medium = 2, hard = 3. Task count breaks load ties and the starting person rotates each day and between shifts. Six sample tasks across four people produce loads of 3, 3, 4, and 4 units. This balances estimated difficulty; it does not measure actual cleaning duration, qualifications, or prove a mathematically optimal schedule for every inventory.

Selecting a name shows **My tasks**. The board also shows everybody's assigned task count and difficulty mix. A person can start only their own assignment and have only one task in progress. After submitting it, they may start the next while review is pending. Admins can return abandoned work for rework.

Assignments persist across reloads and restarts. Roster or equipment changes rebalance unstarted tasks, keeping in-progress, submitted, and verified work with its original person. Removing everybody from a shift leaves unstarted tasks clearly unassigned. Existing work is never erased to rebalance. A small crew or already-started workload can limit how evenly remaining tasks can be split.

Each browser tab remembers its selected name and unfinished checklist draft in session storage. Drafts are not shared between devices; submitted records are. Switching machines or refreshing preserves the tab's draft. Restarting the server preserves database records.

The default launcher accepts connections from this computer only. For a trusted local-network demonstration, use **STARTSERVER_LAN.bat** on the host and open `http://HOST-IP:5088` from other devices on the same network. If Windows asks, allow access only on the appropriate private network. Every device must use the same server; do not start a separate database on each device. Local HTTP is suitable for this concept demo; company IT should configure authenticated transport and hosting before a real deployment. No firewall settings are changed automatically.

Back up the `data` folder with the server stopped, including any SQLite companion files. Removed users/machines are archived so their histories remain. There is deliberately no employee-facing delete-record action. Store the folder on a local disk, not a simultaneously accessed network share or cloud-synced database directory.

## What the demo can establish

It establishes server-recorded task start, submission, checklist answers, observations, and admin review times. It does **not** prove physical cleaning or the identity behind a selected name. The shared admin password also does not establish which individual supervisor reviewed a task. Site verification and release procedures still apply. Points recognize reviewed work, not speed. This is a workflow demonstration, not a validated food-safety, compliance, or production-release system.

## Optional developer checks

`python test_server.py` runs isolated integration checks for duplicate claims, validation, access controls, verification, rework, archival, export, password changes, and persistent storage.

The optional `package.json` is only for Playwright browser checks; it is not needed to run or present the app.

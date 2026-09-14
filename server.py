"""Kanpak Kleanup local demonstration; Python standard library and SQLite."""
import argparse
import csv
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from http.cookies import SimpleCookie
import webbrowser

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get('KANPAK_DB', str(ROOT / 'data' / 'cleanshift.db')))
SESSIONS = {}
ATTEMPTS = {}
AUTH_LOCK = threading.Lock()
SHIFTS = ['Day', 'Night']
WEIGHTS = {'easy': 1, 'medium': 2, 'hard': 3}
QUESTIONS = [
    {'q': 'Where do you find the approved cleaning method for this equipment?', 'options': ['Use the current site SOP and equipment instructions', 'Use the same settings as any other machine', 'Choose the quickest method'], 'answer': 0},
    {'q': 'What should happen if a check fails or you find residue or damage?', 'options': ['Mark it complete and move on', 'Stop, report the issue, and follow the site escalation process', 'Skip that check'], 'answer': 1},
    {'q': 'Does submitting this checklist release equipment for production?', 'options': ['Yes, submission is approval', 'Yes, if you earned enough points', 'No. Follow the site verification and release procedure'], 'answer': 2},
]

def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')

def day():
    return datetime.now().date().isoformat()

def connect():
    db = sqlite3.connect(DB, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db

def password_hash(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 240000).hex()

def init():
    DB.parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS machines (id INTEGER PRIMARY KEY, name TEXT NOT NULL, area TEXT NOT NULL, difficulty TEXT NOT NULL, description TEXT NOT NULL, steps TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, machine_id INTEGER NOT NULL REFERENCES machines(id), user_id INTEGER NOT NULL REFERENCES users(id), machine TEXT NOT NULL, person TEXT NOT NULL, difficulty TEXT NOT NULL, points INTEGER NOT NULL, work_day TEXT NOT NULL, shift TEXT NOT NULL, started TEXT NOT NULL, submitted TEXT, reviewed TEXT, status TEXT NOT NULL, steps TEXT NOT NULL, answers TEXT, note TEXT, review_note TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS one_open_run ON runs(machine_id, work_day, shift) WHERE status IN ('in_progress','pending','verified');
        CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS shift_roster (shift TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(shift,user_id));
        CREATE TABLE IF NOT EXISTS plans (work_day TEXT NOT NULL, shift TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(work_day,shift));
        CREATE TABLE IF NOT EXISTS assignments (work_day TEXT NOT NULL, shift TEXT NOT NULL, machine_id INTEGER NOT NULL REFERENCES machines(id), user_id INTEGER REFERENCES users(id), PRIMARY KEY(work_day,shift,machine_id));
        ''')
        if not db.execute("SELECT 1 FROM settings WHERE key='salt'").fetchone():
            salt = secrets.token_hex(16)
            db.executemany('INSERT INTO settings VALUES (?,?)', [('salt', salt), ('password', password_hash(os.environ.get('KANPAK_ADMIN_PASSWORD', 'KanPakDemo!2026'), salt))])
        if not db.execute("SELECT 1 FROM settings WHERE key='seeded'").fetchone():
            db.executemany('INSERT INTO users(name) VALUES (?)', [('Person 1',), ('Person 2',), ('Person 3',), ('Person 4',)])
            machines = [
                ('Raw milk silo', 'Receiving · Zone A', 'hard', 'Storage vessel and associated product-contact connections.', 'Confirm the correct vessel and approved silo cleaning SOP.'),
                ('HTST pasteurizer', 'Processing · Zone B', 'hard', 'Plate heat exchanger and pasteurization circuit.', 'Identify the correct pasteurizer circuit and its approved cleaning record.'),
                ('Homogenizer', 'Processing · Zone B', 'medium', 'High-pressure dairy processing equipment.', 'Confirm the homogenizer is in the safe state required by its SOP.'),
                ('Mixing & blend tank', 'Blending · Zone C', 'medium', 'Agitated tank for preparing dairy-based product mixes.', 'Identify the blend tank and the required product-changeover procedure.'),
                ('Aseptic filler', 'Packaging · Zone D', 'hard', 'Filling equipment with controlled hygienic boundaries.', 'Confirm the filler-specific procedure and authorized personnel requirements.'),
                ('Case conveyor', 'Packaging · Zone D', 'easy', 'Secondary-packaging conveyor and accessible external surfaces.', 'Identify the conveyor section and approved external-cleaning procedure.'),
            ]
            for name, area, difficulty, desc, first in machines:
                steps = [first, 'Confirm authorization, required PPE, and safe equipment isolation under the site procedure.', 'Complete the approved cleaning procedure and record required measurements in the official site record.', 'Inspect the designated check points and report any residue, damage, or failed checks.', 'Record the cleaning reference and hand over for supervisor verification.']
                db.execute('INSERT INTO machines(name,area,difficulty,description,steps) VALUES (?,?,?,?,?)', (name, area, difficulty, desc, json.dumps(steps)))
            db.execute("INSERT INTO settings VALUES ('seeded','1')")
        if not db.execute("SELECT 1 FROM settings WHERE key='roster_seeded'").fetchone():
            for shift in SHIFTS:
                db.execute('INSERT OR IGNORE INTO shift_roster SELECT ?,id FROM users WHERE active=1', (shift,))
            db.execute("INSERT INTO settings VALUES ('roster_seeded','1')")

def ensure_plan(db, work_day, shift):
    """Persist balanced allocations; preserve started work when a roster changes."""
    machines = db.execute('SELECT id,difficulty FROM machines WHERE active=1 ORDER BY id').fetchall()
    users = [r['id'] for r in db.execute('SELECT u.id FROM users u JOIN shift_roster s ON s.user_id=u.id WHERE u.active=1 AND s.shift=? ORDER BY u.id', (shift,))]
    signature = json.dumps([users, [(m['id'], m['difficulty']) for m in machines]])
    previous = db.execute('SELECT signature FROM plans WHERE work_day=? AND shift=?', (work_day, shift)).fetchone()
    if previous and previous['signature'] == signature:
        return
    fixed = {r['machine_id']: r['user_id'] for r in db.execute("SELECT machine_id,user_id FROM runs WHERE work_day=? AND shift=? AND status IN ('in_progress','pending','verified')", (work_day, shift))}
    loads, counts = {u: 0 for u in users}, {u: 0 for u in users}
    allocation = {}
    for m in machines:
        if m['id'] in fixed:
            u = fixed[m['id']]
            allocation[m['id']] = u
            if u in loads:
                loads[u] += WEIGHTS[m['difficulty']]
                counts[u] += 1
    if users:
        offset = (datetime.fromisoformat(work_day).toordinal() + SHIFTS.index(shift)) % len(users)
        rotation = users[offset:] + users[:offset]
        rank = {u: i for i, u in enumerate(rotation)}
        for m in sorted(machines, key=lambda m: (-WEIGHTS[m['difficulty']], m['id'])):
            if m['id'] in allocation:
                continue
            u = min(users, key=lambda u: (loads[u], counts[u], rank[u]))
            allocation[m['id']] = u
            loads[u] += WEIGHTS[m['difficulty']]
            counts[u] += 1
    db.execute('DELETE FROM assignments WHERE work_day=? AND shift=?', (work_day, shift))
    db.executemany('INSERT INTO assignments VALUES (?,?,?,?)', [(work_day, shift, m['id'], allocation.get(m['id'])) for m in machines])
    db.execute('INSERT OR REPLACE INTO plans VALUES (?,?,?)', (work_day, shift, signature))
    audit(db, 'Shift allocation updated', f'{work_day} · {shift} · {len(users)} on roster · {len(machines)} tasks; started work retained')

def audit(db, action, detail):
    db.execute('INSERT INTO audit(at,action,detail) VALUES (?,?,?)', (stamp(), action, detail))

class BadRequest(Exception):
    def __init__(self, message, code=400):
        self.message, self.code = message, code

def require(value, message, code=400):
    if not value:
        raise BadRequest(message, code)

def field(data, key, limit=200):
    value = data.get(key, '')
    require(isinstance(value, str) and 0 < len(value.strip()) <= limit, f'{key.replace("_", " ").capitalize()} is required (maximum {limit} characters).')
    return value.strip()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if args and str(args[0]).startswith('GET /api/state'):
            return
        super().log_message(fmt, *args)

    def session(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
            token = cookie['cleanshift_admin'].value if 'cleanshift_admin' in cookie else ''
        except Exception:
            return ''
        with AUTH_LOCK:
            if SESSIONS.get(token, 0) > time.time():
                return token
        return ''

    def send(self, data, code=200, kind='application/json; charset=utf-8', cookie=None):
        body = json.dumps(data).encode() if kind.startswith('application/json') else data if isinstance(data, bytes) else data.encode()
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        if cookie:
            self.send_header('Set-Cookie', cookie)
        if kind.startswith('text/csv'):
            self.send_header('Content-Disposition', 'attachment; filename="cleanshift-records.csv"')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/health':
            return self.send({'app': 'kanpak-cleanshift', 'ok': True})
        if path == '/api/state':
            with connect() as db:
                db.execute('BEGIN IMMEDIATE')
                for shift in SHIFTS:
                    ensure_plan(db, day(), shift)
                assignments = [dict(r) for r in db.execute('SELECT * FROM assignments WHERE work_day=?', (day(),))]
                roster = [dict(r) for r in db.execute('SELECT s.* FROM shift_roster s JOIN users u ON s.user_id=u.id WHERE u.active=1')]
                machines = [dict(r) for r in db.execute('SELECT * FROM machines WHERE active=1')]
                for m in machines:
                    m['steps'] = json.loads(m['steps'])
                runs = [dict(r) for r in db.execute('SELECT * FROM runs ORDER BY id DESC')]
                for r in runs:
                    r['steps'] = json.loads(r['steps'])
                    r['answers'] = json.loads(r['answers']) if r['answers'] else None
                return self.send({'day': day(), 'shifts': SHIFTS, 'assignments': assignments, 'roster': roster, 'admin': bool(self.session()), 'users': [dict(r) for r in db.execute('SELECT * FROM users')], 'machines': machines, 'runs': runs, 'questions': QUESTIONS, 'audit': [dict(r) for r in db.execute('SELECT * FROM audit ORDER BY id DESC LIMIT 100')] if self.session() else []})
        if path == '/api/export':
            if not self.session():
                return self.send({'error': 'Admin access required.'}, 401)
            with connect() as db:
                rows = db.execute('SELECT * FROM runs ORDER BY id DESC')
                out = io.StringIO()
                writer = csv.writer(out)
                writer.writerow([c[0] for c in rows.description])
                for row in rows:
                    writer.writerow(["'" + v if isinstance(v, str) and v.lstrip().startswith(('=', '+', '-', '@')) else v for v in row])
                return self.send('\ufeff' + out.getvalue(), kind='text/csv; charset=utf-8')
        assets = {'/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/assignments.css': 'assignments.css', '/app.js': 'app.js'}
        if path in assets:
            kind = {'html': 'text/html', 'css': 'text/css', 'js': 'text/javascript'}[assets[path].split('.')[-1]]
            return self.send((ROOT / 'static' / assets[path]).read_bytes(), kind=kind + '; charset=utf-8')
        return self.send({'error': 'Not found.'}, 404)

    def do_POST(self):
        try:
            require(self.headers.get('Content-Type', '').split(';')[0] == 'application/json', 'JSON required.', 415)
            origin = self.headers.get('Origin')
            require(not origin or origin == 'http://' + self.headers.get('Host', ''), 'Origin not allowed.', 403)
            length = int(self.headers.get('Content-Length', '0'))
            require(0 < length <= 32000, 'Invalid request size.')
            data = json.loads(self.rfile.read(length))
            require(isinstance(data, dict), 'Invalid request.')
            path = self.path
            if path == '/api/login':
                password = field(data, 'password', 200)
                ip = self.client_address[0]
                with AUTH_LOCK:
                    failures = [t for t in ATTEMPTS.get(ip, []) if t > time.time() - 300]
                    ATTEMPTS[ip] = failures
                    require(len(failures) < 10, 'Too many attempts. Try again in five minutes.', 429)
                with connect() as db:
                    settings = dict(db.execute('SELECT key,value FROM settings').fetchall())
                if not hmac.compare_digest(password_hash(password, settings['salt']), settings['password']):
                    with AUTH_LOCK:
                        ATTEMPTS.setdefault(ip, []).append(time.time())
                    raise BadRequest('Incorrect admin password.', 401)
                token = secrets.token_urlsafe(32)
                with AUTH_LOCK:
                    SESSIONS[token] = time.time() + 28800
                    ATTEMPTS.pop(ip, None)
                return self.send({'ok': True}, cookie=f'cleanshift_admin={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800')
            if path == '/api/logout':
                token = self.session()
                with AUTH_LOCK:
                    SESSIONS.pop(token, None)
                return self.send({'ok': True}, cookie='cleanshift_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
            if path.startswith('/api/admin/'):
                require(self.session(), 'Admin access required.', 401)
            with connect() as db:
                db.execute('BEGIN IMMEDIATE')
                if path == '/api/start':
                    machine = db.execute('SELECT * FROM machines WHERE id=? AND active=1', (data.get('machine_id'),)).fetchone()
                    user = db.execute('SELECT * FROM users WHERE id=? AND active=1', (data.get('user_id'),)).fetchone()
                    require(machine and user, 'Choose an active team member and machine.')
                    shift = data.get('shift')
                    require(shift in SHIFTS, 'Choose a shift.')
                    ensure_plan(db, day(), shift)
                    existing = db.execute("SELECT id FROM runs WHERE machine_id=? AND work_day=? AND shift=? AND status IN ('in_progress','pending','verified')", (machine['id'], day(), shift)).fetchone()
                    require(not existing, 'This task was already started or submitted. Refresh to see its current status.', 409)
                    assignment = db.execute('SELECT user_id FROM assignments WHERE work_day=? AND shift=? AND machine_id=?', (day(), shift, machine['id'])).fetchone()
                    require(assignment and assignment['user_id'] == user['id'], 'This task is assigned to another team member, or the shift roster is empty. Refresh to see the assignments.', 409)
                    require(not db.execute("SELECT 1 FROM runs WHERE user_id=? AND status='in_progress'", (user['id'],)).fetchone(), 'Finish your in-progress task before starting another. An admin can return an abandoned task for rework.', 409)
                    cur = db.execute('INSERT INTO runs(machine_id,user_id,machine,person,difficulty,points,work_day,shift,started,status,steps) VALUES (?,?,?,?,?,?,?,?,?,?,?)', (machine['id'], user['id'], machine['name'], user['name'], machine['difficulty'], {'easy': 25, 'medium': 50, 'hard': 75}[machine['difficulty']], day(), shift, stamp(), 'in_progress', machine['steps']))
                    audit(db, 'Task started', f"#{cur.lastrowid} · {user['name']} · {machine['name']} · {shift}")
                    result = {'id': cur.lastrowid}
                elif path == '/api/submit':
                    run = db.execute('SELECT * FROM runs WHERE id=?', (data.get('id'),)).fetchone()
                    require(run and run['status'] == 'in_progress', 'This task is no longer in progress.', 409)
                    require(data.get('user_id') == run['user_id'], 'Select the team member who started this task.')
                    steps = json.loads(run['steps'])
                    require(data.get('checks') == [True] * len(steps), 'Complete every checklist step.')
                    require(data.get('answers') == [q['answer'] for q in QUESTIONS], 'Review the knowledge check answers before submitting.')
                    note = field(data, 'note', 2000)
                    db.execute("UPDATE runs SET status='pending', submitted=?, answers=?, note=? WHERE id=?", (stamp(), json.dumps(data['answers']), note, run['id']))
                    audit(db, 'Submitted for review', f"#{run['id']} · {run['person']} · {run['machine']}")
                    result = {'ok': True}
                elif path == '/api/admin/review':
                    run = db.execute('SELECT * FROM runs WHERE id=?', (data.get('id'),)).fetchone()
                    require(run and run['status'] in ('pending', 'in_progress'), 'This record has already been reviewed.', 409)
                    decision = data.get('decision')
                    require(decision in ('verified', 'rework'), 'Invalid review decision.')
                    require(decision != 'verified' or run['status'] == 'pending', 'Only submitted work can be verified.')
                    note = field(data, 'review_note', 2000)
                    db.execute('UPDATE runs SET status=?, reviewed=?, review_note=? WHERE id=?', (decision, stamp(), note, run['id']))
                    audit(db, 'Admin ' + decision, f"#{run['id']} · {note}")
                    if decision == 'rework' and run['shift'] in SHIFTS:
                        on_roster = db.execute('SELECT 1 FROM shift_roster s JOIN users u ON s.user_id=u.id WHERE s.shift=? AND s.user_id=? AND u.active=1', (run['shift'], run['user_id'])).fetchone()
                        if not on_roster:
                            db.execute('DELETE FROM plans WHERE work_day=? AND shift=?', (run['work_day'], run['shift']))
                            ensure_plan(db, run['work_day'], run['shift'])
                    result = {'ok': True}
                elif path == '/api/admin/roster':
                    shift = data.get('shift')
                    require(shift in SHIFTS, 'Choose Day or Night.')
                    users = data.get('user_ids')
                    require(isinstance(users, list) and all(type(u) is int for u in users), 'Choose valid team members.')
                    active = {r['id'] for r in db.execute('SELECT id FROM users WHERE active=1')}
                    require(set(users).issubset(active), 'A selected team member is no longer active.')
                    db.execute('DELETE FROM shift_roster WHERE shift=?', (shift,))
                    db.executemany('INSERT INTO shift_roster VALUES (?,?)', [(shift, u) for u in sorted(set(users))])
                    ensure_plan(db, day(), shift)
                    audit(db, 'Shift roster saved', f'{shift} · user IDs {sorted(set(users))}')
                    result = {'ok': True}
                elif path == '/api/admin/user':
                    name = field(data, 'name', 60)
                    require(not db.execute('SELECT 1 FROM users WHERE lower(name)=lower(?) AND active=1', (name,)).fetchone(), 'An active team member already has this name.')
                    db.execute('INSERT INTO users(name) VALUES (?)', (name,))
                    audit(db, 'Team member added', name)
                    result = {'ok': True}
                elif path == '/api/admin/user-delete':
                    user = db.execute('SELECT * FROM users WHERE id=? AND active=1', (data.get('id'),)).fetchone()
                    require(user, 'Team member not found.', 404)
                    require(not db.execute("SELECT 1 FROM runs WHERE user_id=? AND status='in_progress'", (user['id'],)).fetchone(), 'Resolve this person’s in-progress tasks before removing them.')
                    db.execute('UPDATE users SET active=0 WHERE id=?', (user['id'],))
                    audit(db, 'Team member archived', user['name'])
                    result = {'ok': True}
                elif path == '/api/admin/machine':
                    name, area = field(data, 'name', 80), field(data, 'area', 80)
                    description = field(data, 'description', 300)
                    difficulty = data.get('difficulty')
                    require(difficulty in ('easy', 'medium', 'hard'), 'Choose a difficulty.')
                    steps = data.get('steps')
                    require(isinstance(steps, list) and 2 <= len(steps) <= 15 and all(isinstance(s, str) and 0 < len(s.strip()) <= 400 for s in steps), 'Enter 2–15 checklist steps, each up to 400 characters.')
                    db.execute('INSERT INTO machines(name,area,difficulty,description,steps) VALUES (?,?,?,?,?)', (name, area, difficulty, description, json.dumps([s.strip() for s in steps])))
                    audit(db, 'Machine added', name)
                    result = {'ok': True}
                elif path == '/api/admin/machine-delete':
                    machine = db.execute('SELECT * FROM machines WHERE id=? AND active=1', (data.get('id'),)).fetchone()
                    require(machine, 'Machine not found.', 404)
                    require(not db.execute("SELECT 1 FROM runs WHERE machine_id=? AND status IN ('in_progress','pending')", (machine['id'],)).fetchone(), 'Review or return open tasks before removing this machine.')
                    db.execute('UPDATE machines SET active=0 WHERE id=?', (machine['id'],))
                    audit(db, 'Machine archived', machine['name'])
                    result = {'ok': True}
                elif path == '/api/admin/password':
                    current = field(data, 'current_password', 200)
                    settings = dict(db.execute('SELECT key,value FROM settings').fetchall())
                    require(hmac.compare_digest(password_hash(current, settings['salt']), settings['password']), 'Current password is incorrect.', 401)
                    password = field(data, 'new_password', 200)
                    require(len(password) >= 12, 'Use at least 12 characters.')
                    db.execute("UPDATE settings SET value=? WHERE key='password'", (password_hash(password, settings['salt']),))
                    audit(db, 'Admin password changed', 'All admin sessions revoked')
                    with AUTH_LOCK:
                        SESSIONS.clear()
                    result = {'ok': True}
                else:
                    raise BadRequest('Not found.', 404)
            self.send(result)
        except BadRequest as exc:
            self.send({'error': exc.message}, exc.code)
        except (ValueError, TypeError, sqlite3.IntegrityError):
            self.send({'error': 'Invalid or conflicting request. Refresh and try again.'}, 400)
        except Exception:
            import traceback
            traceback.print_exc()
            self.send({'error': 'The server could not save this change. Please try again.'}, 500)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=5088)
    parser.add_argument('--open', action='store_true')
    args = parser.parse_args()
    init()
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        print(f'Cannot start Kanpak Kleanup on port {args.port}: {exc}')
        raise SystemExit(1)
    url = f'http://127.0.0.1:{args.port}'
    print(f'\nKANPAK CLEANSHIFT DEMO\n{url}\nStorage: {DB}\nKeep this window open. Ctrl+C stops the server.\n', flush=True)
    if args.open:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

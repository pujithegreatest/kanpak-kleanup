"""Integration checks use a temporary database, never the demo's records."""
import concurrent.futures
import http.cookiejar
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
import server

class WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='kanpak-test-')
        server.DB = Path(cls.temp.name) / 'test.db'
        server.init()
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.url = f'http://127.0.0.1:{cls.http.server_port}'
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        # Windows SQLite handles may remain pending GC until interpreter exit.
        import gc
        gc.collect()
        cls.temp.cleanup()

    def client(self):
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, data=None, client=None, origin=None):
        headers = {'Content-Type':'application/json'}
        if origin:
            headers['Origin'] = origin
        req = urllib.request.Request(self.url+path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
        try:
            with (client or self.client()).open(req) as response:
                raw=response.read().decode('utf-8-sig')
                return response.status, json.loads(raw) if response.headers.get('Content-Type','').startswith('application/json') else raw
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_end_to_end(self):
        code, state = self.request('/api/state')
        self.assertEqual(code,200)
        self.assertEqual(len(state['machines']),6)
        self.assertEqual(len(state['users']),4)
        self.assertEqual(state['shifts'],['Day','Night'])
        for shift in state['shifts']:
            allocation=[a for a in state['assignments'] if a['shift']==shift]
            self.assertEqual(len(allocation),6)
            loads={u['id']:0 for u in state['users']}
            for a in allocation:
                machine=next(m for m in state['machines'] if m['id']==a['machine_id'])
                loads[a['user_id']]+=server.WEIGHTS[machine['difficulty']]
            self.assertEqual(sorted(loads.values()),[3,3,4,4])
        self.assertEqual(self.request('/api/state')[1]['assignments'],state['assignments'])
        self.assertFalse(state['admin'])
        self.assertEqual(self.request('/api/admin/user',{'name':'Unauthorized'})[0],401)
        self.assertEqual(self.request('/api/export')[0],401)
        self.assertEqual(self.request('/api/start',{},origin='http://untrusted.example')[0],403)
        self.assertEqual(self.request('/api/login',{'password':'wrong'})[0],401)
        admin=self.client()
        self.assertEqual(self.request('/api/login',{'password':'KanPakDemo!2026'},admin)[0],200)
        owner=next(a['user_id'] for a in state['assignments'] if a['machine_id']==1 and a['shift']=='Day')
        night_owner=next(a['user_id'] for a in state['assignments'] if a['machine_id']==1 and a['shift']=='Night')
        payload={'machine_id':1,'user_id':owner,'shift':'Day'}
        self.assertEqual(self.request('/api/start',{**payload,'user_id':owner%4+1})[0],409)
        self.assertEqual(self.request('/api/admin/roster',{'shift':'Day','user_ids':[1]})[0],401)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            claims=list(pool.map(lambda _:self.request('/api/start',payload),range(2)))
        self.assertEqual(sorted(x[0] for x in claims),[200,409])
        run_id=next(x[1]['id'] for x in claims if x[0]==200)
        submit={'id':run_id,'user_id':owner,'checks':[True]*5,'answers':[0,1,2],'note':'Demo cleaning log QA-001; check points inspected.'}
        self.assertEqual(self.request('/api/submit',{**submit,'checks':[False]*5})[0],400)
        self.assertEqual(self.request('/api/submit',{**submit,'answers':[2,1,2]})[0],400)
        self.assertEqual(self.request('/api/submit',{**submit,'user_id':999})[0],400)
        self.assertEqual(self.request('/api/submit',submit)[0],200)
        self.assertEqual(self.request('/api/submit',submit)[0],409)
        record=self.request('/api/state')[1]['runs'][0]
        self.assertEqual(record['status'],'pending')
        self.assertTrue(record['submitted'])
        review={'id':run_id,'decision':'verified','review_note':'Inspected demo evidence and checklist.'}
        self.assertEqual(self.request('/api/admin/review',review)[0],401)
        self.assertEqual(self.request('/api/admin/review',review,admin)[0],200)
        self.assertEqual(self.request('/api/admin/review',review,admin)[0],409)
        record=self.request('/api/state')[1]['runs'][0]
        self.assertEqual(record['status'],'verified')
        self.assertEqual(record['points'],75)
        self.assertTrue(record['reviewed'])
        self.assertEqual(self.request('/api/start',payload)[0],409)
        # Shift independence, rework preserves history, a new attempt is allowed.
        code, second=self.request('/api/start',{**payload,'shift':'Night','user_id':night_owner})
        self.assertEqual(code,200)
        self.assertEqual(self.request('/api/admin/review',{'id':second['id'],'decision':'verified','review_note':'no submission'},admin)[0],400)
        self.assertEqual(self.request('/api/admin/review',{'id':second['id'],'decision':'rework','review_note':'Abandoned task; retry.'},admin)[0],200)
        self.assertEqual(self.request('/api/start',{**payload,'shift':'Night','user_id':night_owner})[0],200)
        self.assertEqual(self.request('/api/admin/user',{'name':'Test operator'},admin)[0],200)
        self.assertEqual(self.request('/api/admin/user',{'name':'test operator'},admin)[0],400)
        machine={'name':'Test equipment','area':'QA','description':'Test-only machine','difficulty':'easy','steps':['Check the approved instructions.','Record results.']}
        self.assertEqual(self.request('/api/admin/machine',machine,admin)[0],200)
        state=self.request('/api/state')[1]
        self.assertEqual(self.request('/api/admin/machine-delete',{'id':state['machines'][-1]['id']},admin)[0],200)
        self.assertEqual(self.request('/api/admin/user-delete',{'id':state['users'][-1]['id']},admin)[0],200)
        self.assertEqual(self.request('/api/admin/machine-delete',{'id':1},admin)[0],400)
        code, csv=self.request('/api/export',client=admin)
        self.assertEqual(code,200)
        self.assertIn('Demo cleaning log QA-001',csv)
        self.assertTrue(self.request('/api/state',client=admin)[1]['audit'])
        # Initialization preserves all previously saved records.
        before=self.request('/api/state')[1]['runs']
        server.init()
        self.assertEqual(self.request('/api/state')[1]['runs'],before)
        self.assertEqual(self.request('/api/admin/password',{'current_password':'KanPakDemo!2026','new_password':'NewDemoPassword!123'},admin)[0],200)
        self.assertFalse(self.request('/api/state',client=admin)[1]['admin'])

    def test_z_roster_and_sequential_work(self):
        from unittest.mock import patch
        # A future date avoids changing any records created by the full workflow test.
        with patch.object(server,'day',return_value='2030-01-15'):
            admin=self.client()
            self.assertEqual(self.request('/api/login',{'password':'NewDemoPassword!123'},admin)[0],200)
            self.assertEqual(self.request('/api/admin/roster',{'shift':'Day','user_ids':[1,2]},admin)[0],200)
            state=self.request('/api/state')[1]
            allocation=[a for a in state['assignments'] if a['shift']=='Day']
            self.assertEqual({a['user_id'] for a in allocation},{1,2})
            loads={1:0,2:0}
            for a in allocation:
                m=next(m for m in state['machines'] if m['id']==a['machine_id'])
                loads[a['user_id']]+=server.WEIGHTS[m['difficulty']]
            self.assertEqual(loads,{1:7,2:7})
            # Finish/return old in-progress demo attempts before testing concurrency.
            for r in state['runs']:
                if r['status']=='in_progress':
                    self.request('/api/admin/review',{'id':r['id'],'decision':'rework','review_note':'Close earlier test attempt.'},admin)
            mine=[a for a in allocation if a['user_id']==1]
            code,run=self.request('/api/start',{'machine_id':mine[0]['machine_id'],'user_id':1,'shift':'Day'})
            self.assertEqual(code,200)
            self.assertEqual(self.request('/api/start',{'machine_id':mine[1]['machine_id'],'user_id':1,'shift':'Day'})[0],409)
            self.assertEqual(self.request('/api/admin/roster',{'shift':'Day','user_ids':[2]},admin)[0],200)
            updated=self.request('/api/state')[1]
            self.assertEqual(next(a['user_id'] for a in updated['assignments'] if a['shift']=='Day' and a['machine_id']==mine[0]['machine_id']),1)
            self.assertTrue(all(a['user_id']==2 for a in updated['assignments'] if a['shift']=='Day' and a['machine_id']!=mine[0]['machine_id']))
            self.assertEqual(self.request('/api/admin/roster',{'shift':'Night','user_ids':[]},admin)[0],200)
            self.assertTrue(all(a['user_id'] is None for a in self.request('/api/state')[1]['assignments'] if a['shift']=='Night'))
            self.assertEqual(self.request('/api/start',{'machine_id':1,'user_id':2,'shift':'Night'})[0],409)
        self.assertEqual(self.request('/api/login',{'password':'KanPakDemo!2026'},admin)[0],401)
        self.assertEqual(self.request('/api/login',{'password':'NewDemoPassword!123'},admin)[0],200)
        self.assertEqual(self.request('/api/logout',{},admin)[0],200)
        self.assertFalse(self.request('/api/state',client=admin)[1]['admin'])

if __name__=='__main__':
    unittest.main(verbosity=2)

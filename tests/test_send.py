"""Behavior/security regression tests for the shipped standalone skill."""
import contextlib,hashlib,importlib.util,io,json,os,socket,stat,sys,tempfile,threading,time,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
import send_to_kindle as send
import kindle_store as storemod
from kindle_store import ConfigStore,KindleError,SystemKeys,new_key
from kindle_usb import pair,lua_ssh_settings
from kindle_transport import session,send_file,validate_address,profile_for
import paramiko

class MemoryKeys:
 def __init__(self):self.values={}
 def get(self,k):return self.values.get(k)
 def put_new(self,k,v):
  if k in self.values and self.values[k]!=v:raise KindleError('credential-conflict','keep identity')
  self.values[k]=v

class CoreTests(unittest.TestCase):
 def test_invalid_books_and_bounded_metadata(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/'wrong.pdf';p.write_text('<html>error</html>')
   with self.assertRaises(ValueError):send.inspect_book(str(p))
   p=Path(tmp)/'run.sh';p.write_text('echo no')
   with self.assertRaises(ValueError):send.inspect_book(str(p))
   p=Path(tmp)/'book.epub'
   with zipfile.ZipFile(p,'w') as z:
    z.writestr('mimetype','application/epub+zip');z.writestr('META-INF/container.xml','<container><rootfile full-path="book.opf"/></container>');z.writestr('book.opf','<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>中文书名</dc:title><dc:creator>作者</dc:creator></metadata></package>')
   self.assertEqual(send.inspect_book(str(p))['metadata']['title'],['中文书名'])
   with zipfile.ZipFile(p,'w') as z:z.writestr('mimetype','x'*1000)
   with self.assertRaises(ValueError):send.inspect_book(str(p))
 def test_private_lan_and_port_boundaries(self):
  for host in ['127.0.0.1','8.8.8.8','example.com','192.168.1.2;id','169.254.1.2','192.168.1.999']:
   with self.assertRaises(KindleError):validate_address(host,2222)
  for port in [True,0,65536,'2222']:
   with self.assertRaises(KindleError):validate_address('192.168.1.2',port)
  self.assertEqual(validate_address('172.16.1.3',2222),('172.16.1.3',2222))
 def test_metadata_is_atomic_owner_only_and_cannot_contain_keys(self):
  with tempfile.TemporaryDirectory() as tmp:
   s=ConfigStore(Path(tmp)/'state')
   with s.edit() as d:d['marker']='first'
   before=s.path.read_bytes()
   with self.assertRaises(KindleError):
    with s.edit() as d:d['privateKey']='must never persist'
   self.assertEqual(s.path.read_bytes(),before)
   with self.assertRaises(RuntimeError):
    with s.edit() as d:d['marker']='wrong';raise RuntimeError()
   self.assertEqual(s.load()['marker'],'first')
   if os.name!='nt':self.assertEqual(s.path.stat().st_mode&0o777,0o600)
   other=ConfigStore(Path(tmp)/'other-checkout');self.assertNotEqual(other.path,s.path)
 def test_keychain_failure_never_becomes_plaintext_fallback(self):
  k=SystemKeys.__new__(SystemKeys)
  class Broken:
   def get_password(self,*args):raise RuntimeError('private payload should not be echoed')
  k.backend=Broken()
  with self.assertRaises(KindleError) as e:k.get('kindle-test')
  self.assertEqual(e.exception.code,'credential-unavailable');self.assertNotIn('payload',str(e.exception))
 def fixture_usb(self,root):
  (root/'system').mkdir();(root/'system/version.txt').write_text('Kindle 5.16 fixture')
  (root/'documents').mkdir();(root/'koreader').mkdir();(root/'koreader/koreader.sh').write_text('fixture')
  (root/'koreader/settings.reader.lua').write_text('return {\n    ["custom"] = "preserve",\n}\n')
 def test_pairing_only_public_keys_no_duplicate_and_missing_identity_is_not_replaced(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp)/'kindle';root.mkdir();self.fixture_usb(root)
   state=ConfigStore(Path(tmp)/'machine');keys=MemoryKeys()
   r=pair(state,keys,root,host='192.168.1.2')
   keyfile=root/'koreader/settings/SSH/authorized_keys'
   first=keyfile.read_bytes();pair(state,keys,root,host='192.168.1.2')
   self.assertEqual(keyfile.read_bytes(),first);self.assertEqual(len(keys.values),1)
   self.assertNotIn('PRIVATE KEY',state.path.read_text());self.assertNotIn('PRIVATE KEY',keyfile.read_text())
   self.assertIn('SSH_key_only_auth', (root/'koreader/settings.reader.lua').read_text())
   self.assertIn('["custom"] = "preserve"',(root/'koreader/settings.reader.lua').read_text())
   keys.values.clear()
   with patch('kindle_usb.new_key',side_effect=AssertionError('must not regenerate')):
    with self.assertRaises(KindleError) as error:pair(state,keys,root)
   self.assertEqual(error.exception.code,'credential-missing');self.assertEqual(keyfile.read_bytes(),first)
 def test_usb_symlink_escape_and_ambiguous_settings_are_rejected(self):
  with self.assertRaises(KindleError):lua_ssh_settings('return {\n    ["SSH_port"] = "1",\n    ["SSH_port"] = "2",\n}',2222)
  if os.name=='nt':return
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp)/'kindle';root.mkdir();self.fixture_usb(root)
   outside=Path(tmp)/'outside';outside.mkdir()
   (root/'koreader/settings').mkdir();(root/'koreader/settings/SSH').symlink_to(outside,target_is_directory=True)
   with self.assertRaises(KindleError):pair(ConfigStore(Path(tmp)/'state'),MemoryKeys(),root)
   self.assertEqual(list(outside.iterdir()),[])
 def test_receipt_binds_uploaded_representation_and_original(self):
  b={'name':'中文.epub','bytes':50,'sha256':'a'*64}
  r={'ok':True,'mode':'koreader','path':'/mnt/us/documents/中文.epub','bytes':50,'sha256':'a'*64}
  self.assertEqual(send.delivery_receipt(r,b)['source_sha256'],'a'*64)
  with self.assertRaises(RuntimeError):send.delivery_receipt({**r,'sha256':'b'*64},b)
  c={**r,'mode':'native','converted':True,'path':'/mnt/us/documents/中文.azw3','sha256':'b'*64,'bytes':100}
  self.assertEqual(send.delivery_receipt(c,b)['source_sha256'],'a'*64)
  with self.assertRaises(RuntimeError):send.delivery_receipt({**c,'mode':'koreader'},b)
 def test_native_usb_pairing_shares_identity_and_keeps_koreader_keys(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp)/'kindle';root.mkdir();self.fixture_usb(root)
   state=ConfigStore(Path(tmp)/'state');keys=MemoryKeys();pair(state,keys,root,host='192.168.1.2')
   old=(root/'koreader/settings/SSH/authorized_keys').read_bytes()
   (root/'qiaomu-kindle').mkdir();(root/'qiaomu-kindle/receiver.json').write_text(json.dumps({'protocol':1,'port':2223,'prepared':True}))
   result=pair(state,keys,root,mode='native',host='192.168.1.2')
   self.assertTrue(result['installPending']);self.assertEqual(len(keys.values),1)
   self.assertEqual((root/'usbnetlite/etc/dropbear/authorized_keys').read_bytes(),old)
   self.assertEqual((root/'koreader/settings/SSH/authorized_keys').read_bytes(),old)
   before=state.path.read_bytes()
   with self.assertRaises(KindleError):pair(state,keys,root,port=0)
   self.assertEqual(state.path.read_bytes(),before)
 def test_invalid_or_unauthenticated_migration_never_saves_credentials(self):
  with tempfile.TemporaryDirectory() as tmp:
   state=ConfigStore(Path(tmp)/'state');keys=MemoryKeys()
   for value in [[],None,{'profiles':[]}]:
    with self.assertRaises(KindleError):send.migrate_record(state,keys,value)
   private,_=new_key();record={'privateKey':private,'profiles':{'koreader':{'host':'192.168.1.2','port':2222,'fingerprint':'a'*64,'paired':True}}}
   with patch('send_to_kindle.session',side_effect=KindleError('auth','rejected')):
    with self.assertRaises(KindleError):send.migrate_record(state,keys,record)
   self.assertEqual(keys.values,{});self.assertFalse(state.path.exists())
 def test_mode_selection_does_not_mutate_default(self):
  with tempfile.TemporaryDirectory() as tmp:
   state=ConfigStore(Path(tmp)/'state')
   with state.edit() as d:d.update(active_device='test',default_mode='koreader',devices={'test':{'credential_id':'key','profiles':{'native':{'paired':True}}}})
   before=state.path.read_bytes();self.assertEqual(profile_for(state,mode='native')[2],'native');self.assertEqual(state.path.read_bytes(),before)
 def test_script_does_not_launch_or_import_obsidian(self):
  for name in ['send_to_kindle.py','kindle_store.py','kindle_transport.py','kindle_usb.py','kindle_convert.py']:
   text=(ROOT/'scripts'/name).read_text()
   self.assertNotIn('run_host(',text);self.assertNotIn('getSecret(',text);self.assertNotIn('app.plugins',text);self.assertNotIn("'vault='",text)

class TestServer(paramiko.ServerInterface):
 def __init__(self,fixture):self.fixture=fixture
 def check_auth_publickey(self,username,key):
  self.fixture.auth_calls+=1
  return paramiko.AUTH_SUCCESSFUL if key==self.fixture.client_key else paramiko.AUTH_FAILED
 def get_allowed_auths(self,username):return 'publickey'
 def check_channel_request(self,kind,chanid):return paramiko.OPEN_SUCCEEDED if kind=='session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

class Handle(paramiko.SFTPHandle):
 def __init__(self,fixture,flags):super().__init__(flags);self.fixture=fixture
 def read(self,offset,length):
  data=super().read(offset,length)
  if self.fixture.corrupt and isinstance(data,bytes) and data and offset==0:return bytes([data[0]^1])+data[1:]
  return data
 def stat(self):return paramiko.SFTPAttributes.from_stat(os.fstat(self.readfile.fileno()))

class Files(paramiko.SFTPServerInterface):
 def __init__(self,server,fixture):super().__init__(server);self.fixture=fixture
 def path(self,p):
  if p=='/mnt/us/documents':return self.fixture.root
  if not p.startswith('/mnt/us/documents/'):raise OSError(13,'forbidden')
  result=self.fixture.root/p[len('/mnt/us/documents/'):]
  if not result.resolve().is_relative_to(self.fixture.root):raise OSError(13,'forbidden')
  return result
 def canonicalize(self,p):return p
 def stat(self,p):
  try:return paramiko.SFTPAttributes.from_stat(self.path(p).stat())
  except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
 lstat=stat
 def open(self,p,flags,attr):
  try:
   fd=os.open(self.path(p),flags,0o600);f=os.fdopen(fd,'r+b' if flags&os.O_RDWR else 'wb' if flags&os.O_WRONLY else 'rb')
   h=Handle(self.fixture,flags);h.readfile=f;h.writefile=f;return h
  except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
 def remove(self,p):
  try:self.path(p).unlink();return paramiko.SFTP_OK
  except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
 def rename(self,a,b):
  try:
   target=self.path(b)
   if self.fixture.race:target.write_bytes(b'concurrent book')
   if target.exists():return paramiko.SFTP_FAILURE
   self.path(a).rename(target);return paramiko.SFTP_OK
  except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)

class TransportTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=(Path(self.tmp.name)/'remote').resolve();self.root.mkdir()
  self.private,self.client_key=new_key();self.server_key=paramiko.ECDSAKey.generate();self.auth_calls=0;self.corrupt=False;self.race=False
  self.listener=socket.socket();self.listener.bind(('127.0.0.1',0));self.listener.listen();self.transports=[];self.running=True
  self.port=self.listener.getsockname()[1]
  def serve():
   while self.running:
    try:client,_=self.listener.accept()
    except OSError:return
    transport=paramiko.Transport(client);self.transports.append(transport);transport.add_server_key(self.server_key)
    transport.set_subsystem_handler('sftp',paramiko.SFTPServer,Files,fixture=self)
    try:transport.start_server(server=TestServer(self))
    except (EOFError,OSError,paramiko.SSHException):transport.close()
  self.thread=threading.Thread(target=serve,daemon=True);self.thread.start()
  original=socket.create_connection
  self.patch=patch('kindle_transport.socket.create_connection',side_effect=lambda address,timeout:original(('127.0.0.1',self.port),timeout=timeout));self.patch.start()
  self.profile={'host':'192.168.1.2','port':2222,'fingerprint':hashlib.sha256(self.server_key.asbytes()).hexdigest()}
  self.book=Path(self.tmp.name)/'中文.txt';self.book.write_bytes('中文正文与校验'.encode()*300)
 def tearDown(self):
  self.patch.stop();self.running=False;self.listener.close()
  for transport in self.transports:transport.close()
  self.tmp.cleanup()
 def test_real_sftp_full_readback_and_existing_book_is_preserved(self):
  (self.root/self.book.name).write_bytes(b'original')
  result=send_file(self.profile,self.private,self.book,self.book.name)
  target=self.root/Path(result['path']).name
  self.assertEqual(target.read_bytes(),self.book.read_bytes());self.assertEqual(result['sha256'],hashlib.sha256(self.book.read_bytes()).hexdigest())
  self.assertEqual((self.root/self.book.name).read_bytes(),b'original');self.assertNotEqual(target.name,self.book.name)
 def test_host_identity_mismatch_stops_before_authentication(self):
  with self.assertRaises(KindleError) as e:
   with session({**self.profile,'fingerprint':'0'*64},self.private):pass
  self.assertEqual(e.exception.code,'host-key');self.assertEqual(self.auth_calls,0)
 def test_unknown_identity_requires_explicit_first_pairing_trust(self):
  with self.assertRaises(KindleError) as e:
   with session({**self.profile,'fingerprint':'','pending_trust':True},self.private):pass
  self.assertEqual(e.exception.code,'trust-required');self.assertEqual(self.auth_calls,0)
 def test_corrupted_readback_and_changed_source_hash_never_finalize(self):
  self.corrupt=True
  with self.assertRaises(KindleError) as e:send_file(self.profile,self.private,self.book,self.book.name)
  self.assertEqual(e.exception.code,'verify');self.assertEqual(list(self.root.iterdir()),[])
  self.corrupt=False
  with self.assertRaises(KindleError) as e:send_file(self.profile,self.private,self.book,self.book.name,'0'*64)
  self.assertEqual(e.exception.code,'changed');self.assertEqual(list(self.root.iterdir()),[])
 def test_final_rename_race_keeps_concurrent_book_and_cleans_partial(self):
  self.race=True
  with self.assertRaises(KindleError):send_file(self.profile,self.private,self.book,self.book.name)
  self.assertEqual((self.root/self.book.name).read_bytes(),b'concurrent book')
  self.assertFalse(any(p.name.endswith('.part') for p in self.root.iterdir()))

if __name__=='__main__':unittest.main()

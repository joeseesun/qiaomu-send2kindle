#!/usr/bin/env python3
"""Wi-Fi Kindle delivery using bundled code and OS credentials; no Obsidian host."""
from __future__ import annotations
import argparse,hashlib,importlib.util,json,os,re,subprocess,sys,uuid,zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from runtime_paths import runtime_python

if __name__=='__main__' and any(importlib.util.find_spec(name) is None for name in ['paramiko','keyring','filelock','psutil']):
    runtime=runtime_python()
    if runtime.is_file() and Path(sys.executable).absolute()!=runtime.absolute():os.execv(str(runtime),[str(runtime),str(Path(__file__).resolve()),*sys.argv[1:]])
    print(json.dumps({'ok':False,'code':'runtime','error':'Run python3 scripts/setup_runtime.py once to prepare isolated dependencies.'}));sys.exit(1)
from kindle_store import ConfigStore,SystemKeys,KindleError,parse_key
from kindle_usb import pair,find_usb,MODES,valid_id
from kindle_transport import connect,discover,profile_for,private_for,send_file,scan_native,session,validate_address
from kindle_convert import prepare
MAX_BYTES=512*1024*1024
EXTENSIONS={'.epub','.pdf','.mobi','.azw','.azw3','.fb2','.txt','.cbz','.cbr','.djvu','.djv','.rtf','.chm','.doc','.html','.htm'}

def inspect_book(raw: str) -> dict:
    path = Path(raw).expanduser().resolve(strict=True)
    if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
        raise ValueError('Choose a supported local ebook file.')
    size = path.stat().st_size
    if not 0 < size <= MAX_BYTES:
        raise ValueError('This skill accepts books up to 512 MiB; native EPUB conversion accepts up to 64 MiB.')
    if any(ord(c) < 32 for c in path.name) or len(path.name) > 180:
        raise ValueError('Invalid book filename.')
    with path.open('rb') as stream:
        head = stream.read(80)
    metadata = {}
    if path.suffix.lower() == '.epub':
        with zipfile.ZipFile(path) as book:
            info = book.getinfo('mimetype')
            if info.file_size > 100 or book.read(info).strip() != b'application/epub+zip':
                raise ValueError('Not a valid EPUB container.')
            container = book.getinfo('META-INF/container.xml')
            if container.file_size > 65536:
                raise ValueError('Oversized EPUB container metadata.')
            xml = ET.fromstring(book.read(container))
            opf = next((x.attrib.get('full-path') for x in xml.iter() if x.tag.endswith('rootfile')), None)
            if opf:
                info = book.getinfo(opf)
                if info.file_size > 1024 * 1024:
                    raise ValueError('Oversized EPUB book metadata.')
                doc = ET.fromstring(book.read(info))
                for key in ['title','creator','language']:
                    metadata[key] = [''.join(x.itertext()).strip() for x in doc.iter() if x.tag == '{http://purl.org/dc/elements/1.1/}'+key]
    elif path.suffix.lower() == '.pdf' and not head.startswith(b'%PDF-'):
        raise ValueError('Not a PDF file.')
    elif path.suffix.lower() in {'.mobi', '.azw', '.azw3'} and head[60:68] != b'BOOKMOBI':
        raise ValueError('Not a MOBI/AZW book.')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return {'path': str(path), 'name': path.name, 'bytes': size, 'sha256': digest.hexdigest(), 'metadata': metadata}


def delivery_receipt(result: dict, book: dict) -> dict:
    if not result.get('ok'):
        return result
    mode = result.get('mode', 'koreader')
    converted = result.get('converted') is True
    digest, size = result.get('sha256'), result.get('bytes')
    destination = result.get('path', '')
    valid = (mode in {'native', 'koreader'} and isinstance(digest, str) and re.fullmatch(r'[a-f0-9]{64}', digest)
             and type(size) is int and 0 < size <= 512 * 1024 * 1024
             and isinstance(destination, str) and destination.startswith('/mnt/us/documents/')
             and bool(destination[len('/mnt/us/documents/'):])
             and '/' not in destination[len('/mnt/us/documents/'):])
    if converted:
        valid = valid and mode == 'native' and book['name'].lower().endswith('.epub') and destination.lower().endswith('.azw3')
    else:
        valid = valid and size == book['bytes'] and digest == book['sha256']
    if not valid:
        raise RuntimeError('Delivery receipt could not be validated; device status is unknown. Check Kindle before resending.')
    return {**result, 'mode': mode, 'converted': converted, 'source_bytes': book['bytes'], 'source_sha256': book['sha256']}


def migrate_record(store,keys,record):
    # Explicit one-time stdin import. Credentials never appear in argv, output,
    # device metadata, a source file, or a temporary file.
    if not isinstance(record,dict) or not isinstance(record.get('profiles'),dict):raise KindleError('migration','Invalid legacy pairing record; no credentials or metadata were changed.')
    key=parse_key(record.get('privateKey'))
    profiles={}
    for mode,profile in record.get('profiles',{}).items():
        if mode not in MODES or not isinstance(profile,dict) or not profile.get('paired'):continue
        host,port=validate_address(profile.get('host'),profile.get('port',MODES[mode]))
        fingerprint=profile.get('fingerprint','')
        if not re.fullmatch('[a-f0-9]{64}',fingerprint):raise KindleError('host-key','Migration requires the existing pinned device fingerprint.')
        profiles[mode]={'host':host,'port':port,'paired':True,'fingerprint':fingerprint,'pending_trust':False}
    mode=record.get('mode','koreader')
    if mode not in profiles:raise KindleError('migration','No previously paired profile is available in the selected mode.')
    with session(profiles[mode],record['privateKey']):pass
    identity='kindle-'+hashlib.sha256(key.asbytes()).hexdigest()[:32]
    did='kindle-'+profiles[mode]['fingerprint'][:16]
    with store.edit() as data:
        existing=data['devices'].get(did)
        if existing and existing['credential_id']!=identity:raise KindleError('credential-conflict','Device metadata already refers to a different identity; it was not replaced.')
        keys.put_new(identity,record['privateKey'])
        data['devices'][did]={'credential_id':identity,'profiles':{**(existing or {}).get('profiles',{}),**profiles}}
        data['active_device']=did;data['default_mode']=mode
    return {'ok':True,'migrated':True,'device':did,'mode':mode,'credential_store':'operating-system','obsidian_required':False}

class Parser(argparse.ArgumentParser):
    def error(self,message):raise KindleError('arguments',message)

def main():
    try:
        parser=Parser(description=__doc__)
        parser.add_argument('command',choices=['inspect','status','pair','configure','connect','discover','send','migrate-legacy','prepare-receiver','set-default-mode'])
        parser.add_argument('file',nargs='?')
        parser.add_argument('--mode',choices=list(MODES))
        parser.add_argument('--device');parser.add_argument('--usb');parser.add_argument('--host');parser.add_argument('--port',type=int)
        parser.add_argument('--trust-new-device',action='store_true',help='Only for the first connection after explicit physical USB pairing')
        parser.add_argument('--stdin',action='store_true',help='Explicit one-time legacy import through a pipe')
        args=parser.parse_args()
        if args.command=='inspect':
            if not args.file:raise KindleError('file','Provide a local ebook path.')
            result={'ok':True,**inspect_book(args.file)}
        elif args.command=='prepare-receiver':
            if not args.usb:raise KindleError('usb','Provide the explicitly connected Kindle USB mount with --usb.')
            done=subprocess.run([sys.executable,str(Path(__file__).parent/'receiver/prepare.py'),args.usb],capture_output=True,text=True,timeout=120)
            if done.returncode:raise KindleError('receiver',done.stderr.strip() or 'Could not prepare native receiver.')
            result={'ok':True,'prepared':True,'installPending':True,'next':'Pair in native mode while USB is connected, then safely eject and run Install Qiaomu Kindle once on Kindle.'}
        else:
            store=ConfigStore();keys=SystemKeys()
            if args.command=='status':
                data=store.load();devices=[]
                for did,device in data['devices'].items():
                    value=keys.get(device['credential_id'])
                    if value:parse_key(value)
                    devices.append({'device':did,'credential_present':bool(value),'profiles':device['profiles']})
                result={'ok':True,'version':'2.0.0','obsidian_required':False,'credential_store':'operating-system','config':str(store.path),'active_device':data.get('active_device'),'default_mode':data.get('default_mode'),'devices':devices}
            elif args.command in {'pair','configure'}:
                mode=args.mode or store.load().get('default_mode','koreader');volume=args.usb
                if not volume:
                    candidates=find_usb(mode)
                    if len(candidates)!=1:raise KindleError('usb','Connect one Kindle over USB after exiting KOReader, or select its mount with --usb.')
                    volume=candidates[0]
                result=pair(store,keys,volume,mode,args.host,args.port,args.device)
            elif args.command=='migrate-legacy':
                if not args.stdin:raise KindleError('migration','Legacy import requires explicit --stdin; never place credentials in command arguments or a file.')
                raw=sys.stdin.read(65537)
                if len(raw)>65536:raise KindleError('migration','Legacy import is too large.')
                result=migrate_record(store,keys,json.loads(raw))
            elif args.command=='set-default-mode':
                if not args.mode:raise KindleError('mode','Choose --mode koreader or native.')
                profile_for(store,args.device,args.mode)
                with store.edit() as data:
                    data['default_mode']=args.mode
                    if args.device:data['active_device']=args.device
                result={'ok':True,'mode':args.mode}
            elif args.command=='connect':result=connect(store,keys,args.device,args.mode,args.host,args.port,args.trust_new_device)
            elif args.command=='discover':result=discover(store,keys,args.device,args.mode)
            else:
                if not args.file:raise KindleError('file','Provide the local ebook path.')
                book=inspect_book(args.file)
                try:connect(store,keys,args.device,args.mode)
                except KindleError as e:
                    if e.code not in {'network','sftp'}:raise
                    discover(store,keys,args.device,args.mode);connect(store,keys,args.device,args.mode)
                did,device,mode,profile=profile_for(store,args.device,args.mode)
                private=private_for(keys,device)
                with prepare(book,mode) as ready:
                    receipt=send_file(profile,private,ready['path'],ready['name'],ready['sha256'])
                    result={'ok':True,'device':did,'mode':mode,'converted':ready['converted'],**receipt}
                    if ready.get('engine'):result['engine']=ready['engine']
                    if mode=='native':
                        try:result.update(scan_native(profile,private))
                        except (KindleError,OSError):result.update(scanRequested=False,scanPending=None,warning='scan-unconfirmed')
                    result=delivery_receipt(result,book)
        print(json.dumps(result,ensure_ascii=False));return 0
    except KeyboardInterrupt:
        print(json.dumps({'ok':False,'code':'cancelled','error':'Cancelled; check device before resending if delivery had already finalized.'}));return 130
    except (KindleError,OSError,ValueError,KeyError,TypeError,RuntimeError,zipfile.BadZipFile,ET.ParseError,subprocess.TimeoutExpired) as error:
        # Never echo an imported credential, subprocess payload or raw key error.
        message=str(error) if isinstance(error,KindleError) else 'Local file, configuration or runtime operation failed; no success receipt is available.'
        print(json.dumps({'ok':False,'code':getattr(error,'code','local'),'error':message},ensure_ascii=False));return 1

if __name__=='__main__':sys.exit(main())

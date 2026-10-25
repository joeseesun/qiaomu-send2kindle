"""Call the fixed bundled converter in a disposable process, before uploading."""
import hashlib,json,os,shutil,subprocess,tempfile
from contextlib import contextmanager
from pathlib import Path
from kindle_store import KindleError

def node_runtime():
    found=shutil.which('node')
    if found:return found
    # Agents may not have an interactive-shell PATH. Locate installed runtimes,
    # never download executable code as a consequence of a book send.
    candidates=list((Path.home()/'.nvm/versions/node').glob('v*/bin/node'))
    for p in sorted(candidates,key=lambda p:tuple(int(x) for x in p.parts[-3].lstrip('v').split('.')),reverse=True):
        if p.is_file():return str(p)
    raise KindleError('converter-runtime','Node.js 20+ is needed for local EPUB to AZW3 conversion. KOReader direct transfer does not need Node. No Calibre or Obsidian is used.')

@contextmanager
def prepare(book,mode):
    ext=Path(book['name']).suffix.lower()
    if mode=='native' and ext not in {'.epub','.pdf','.mobi','.azw','.azw3','.txt'}:raise KindleError('native-format','Native mode accepts EPUB (converted locally), PDF, MOBI, AZW/AZW3 or TXT.')
    if mode!='native' or ext!='.epub':yield {**book,'converted':False};return
    if book['bytes']>64*1024*1024:raise KindleError('conversion-size','Local EPUB conversion accepts up to 64 MiB.')
    runtime=node_runtime()
    try:
        version=subprocess.run([runtime,'--version'],capture_output=True,text=True,timeout=5,check=True).stdout.strip()
        if int(version.lstrip('v').split('.')[0])<20:raise ValueError()
    except (ValueError,subprocess.SubprocessError,OSError):raise KindleError('converter-runtime','Node.js 20+ is required for native EPUB conversion.') from None
    converter=Path(__file__).resolve().parent/'converter/converter.cjs'
    with tempfile.TemporaryDirectory(prefix='qiaomu-kindle-convert-') as tmp:
        output=Path(tmp)/'book.azw3'
        try:result=subprocess.run([runtime,str(converter),book['path'],str(output)],capture_output=True,text=True,timeout=120)
        except subprocess.TimeoutExpired:raise KindleError('conversion-timeout','Conversion timed out; no book was uploaded.') from None
        try:receipt=json.loads(result.stdout)
        except ValueError:raise KindleError('conversion','Local conversion failed; no book was uploaded.') from None
        if result.returncode or not receipt.get('ok'):raise KindleError(receipt.get('code','conversion'),'Local EPUB conversion failed; no book was uploaded.')
        before=Path(book['path']);digest=hashlib.sha256(before.read_bytes()).hexdigest()
        if digest!=book['sha256']:raise KindleError('changed','The source EPUB changed during conversion; no book was uploaded.')
        if not output.is_file() or not 78<output.stat().st_size<=512*1024*1024:raise KindleError('conversion','Invalid converted ebook.')
        with output.open('rb') as f:head=f.read(78)
        if head[60:68]!=b'BOOKMOBI':raise KindleError('conversion','Invalid AZW3 output.')
        yield {'path':str(output),'name':Path(book['name']).stem+'.azw3','bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'converted':True,'engine':'embedded-azw3'}

SCRIPT_INTERFACE = "internal-module"
